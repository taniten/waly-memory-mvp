"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const {
  isFiniteNumber,
  isNonEmptyString,
  isValidDateOnlyString,
  normalizeTicker
} = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");

const PLAYBOOKS = [
  "biotech-catalyst",
  "pdufa",
  "phase3-readout",
  "earnings-rerating",
  "reversal",
  "short-squeeze",
  "insider-accumulation",
  "options-convexity"
];

const HORIZONS = [30, 60, 90, 180, 365];
const HIT_TARGETS = [25, 50, 100, 200, 500];
const VALID_ENTRY_PRICE_POLICIES = ["provided", "signal-close", "next-open", "next-close"];
const REQUIRED_PRICE_COLUMNS = ["date", "open", "high", "low", "close", "volume"];

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`No existe el archivo ${filePath}.`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${filePath}: ${error.message}`);
    }

    throw error;
  }
}

function writeFileAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tempPath, contents, "utf8");

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  fs.renameSync(tempPath, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureBacktestsPath(targetPath) {
  const resolvedBacktests = path.resolve(BACKTESTS_DIR);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBacktests, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`No se permite escribir fuera de backtests/: ${resolvedTarget}`);
  }

  return resolvedTarget;
}

function resolveConfigPath(configPath) {
  const absolutePath = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`No existe la config ${absolutePath}.`);
  }

  return absolutePath;
}

function resolveRelativeToConfigOrCwd(filePath, configPath) {
  const candidates = [
    path.resolve(path.dirname(configPath), filePath),
    path.resolve(process.cwd(), filePath)
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error(`No existe ${filePath}.`);
  }

  return found;
}

function resolveOutputRoot(outputDir) {
  const requested = isNonEmptyString(outputDir)
    ? path.resolve(process.cwd(), outputDir)
    : path.join(BACKTESTS_DIR, "multibagger-lab");

  const outputRoot = ensureBacktestsPath(requested);
  const relativeToLab = path.relative(path.join(BACKTESTS_DIR, "multibagger-lab"), outputRoot);

  if (relativeToLab.startsWith("..") || path.isAbsolute(relativeToLab)) {
    throw new Error("outputDir debe estar dentro de backtests/multibagger-lab/.");
  }

  return outputRoot;
}

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const valid = values.filter(isFiniteNumber);

  if (!valid.length) {
    return null;
  }

  return round(valid.reduce((sum, value) => sum + value, 0) / valid.length, 2);
}

function median(values) {
  const valid = values.filter(isFiniteNumber).sort((left, right) => left - right);

  if (!valid.length) {
    return null;
  }

  const middle = Math.floor(valid.length / 2);

  if (valid.length % 2 === 1) {
    return round(valid[middle], 2);
  }

  return round((valid[middle - 1] + valid[middle]) / 2, 2);
}

function percentage(part, total) {
  if (!total) {
    return null;
  }

  return round((part / total) * 100, 2);
}

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${round(value, 2).toFixed(2)}%`;
}

function formatNumber(value) {
  return isFiniteNumber(value) ? String(round(value, 2)) : "n/d";
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEnum(value) {
  return normalizeText(value).toLowerCase();
}

function coerceNumber(value) {
  if (isFiniteNumber(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.replace(/[$,%]/g, "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("La config de multibagger-lab debe ser un objeto JSON.");
  }

  if (!isNonEmptyString(config.runId) || !/^[a-z0-9][a-z0-9-_]*$/i.test(config.runId)) {
    errors.push("runId es obligatorio y solo puede usar letras, numeros, - y _.");
  }

  if (config.allowNetwork !== false) {
    errors.push("allowNetwork debe ser false.");
  }

  if (!isNonEmptyString(config.dataProvider) || normalizeEnum(config.dataProvider) !== "local-csv") {
    errors.push("dataProvider debe ser local-csv.");
  }

  if (!isNonEmptyString(config.historicalPricesDir)) {
    errors.push("historicalPricesDir es obligatorio.");
  }

  if (!isNonEmptyString(config.priceFilePattern) || !config.priceFilePattern.includes("{ticker}")) {
    errors.push("priceFilePattern es obligatorio y debe incluir {ticker}.");
  }

  if (
    config.entryPricePolicy !== undefined &&
    (!isNonEmptyString(config.entryPricePolicy) || !VALID_ENTRY_PRICE_POLICIES.includes(normalizeEnum(config.entryPricePolicy)))
  ) {
    errors.push(`entryPricePolicy debe ser uno de ${VALID_ENTRY_PRICE_POLICIES.join(", ")}.`);
  }

  if (config.maxSignals !== undefined && (!Number.isInteger(config.maxSignals) || config.maxSignals <= 0)) {
    errors.push("maxSignals debe ser entero mayor a 0 si existe.");
  }

  if (
    !Array.isArray(config.signals) &&
    !isNonEmptyString(config.signalsFile)
  ) {
    errors.push("Debe existir signals embebido o signalsFile.");
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

function validateSignal(signal, index) {
  const errors = [];
  const label = `signals[${index}]`;

  if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
    return [`${label} debe ser un objeto.`];
  }

  if (!isNonEmptyString(signal.ticker)) {
    errors.push(`${label}.ticker es obligatorio.`);
  }

  if (!isNonEmptyString(signal.signalDate) || !isValidDateOnlyString(signal.signalDate)) {
    errors.push(`${label}.signalDate debe usar YYYY-MM-DD valido.`);
  }

  if (!isNonEmptyString(signal.playbook) || !PLAYBOOKS.includes(normalizeEnum(signal.playbook))) {
    errors.push(`${label}.playbook debe ser uno de ${PLAYBOOKS.join(", ")}.`);
  }

  if (signal.entryPrice !== undefined) {
    const entryPrice = coerceNumber(signal.entryPrice);

    if (!isFiniteNumber(entryPrice) || entryPrice <= 0) {
      errors.push(`${label}.entryPrice debe ser numero mayor a 0 si existe.`);
    }
  }

  if (signal.capitalAtRisk !== undefined) {
    const capitalAtRisk = coerceNumber(signal.capitalAtRisk);

    if (!isFiniteNumber(capitalAtRisk) || capitalAtRisk < 0) {
      errors.push(`${label}.capitalAtRisk debe ser numero >= 0 si existe.`);
    }
  }

  return errors;
}

function normalizeConfig(config, configPath) {
  const historicalPricesDir = resolveRelativeToConfigOrCwd(config.historicalPricesDir, configPath);
  const outputRoot = resolveOutputRoot(config.outputDir);
  const entryPricePolicy = normalizeEnum(config.entryPricePolicy || "next-open");

  return {
    allowNetwork: false,
    configPath,
    dataProvider: "local-csv",
    defaultCapitalAtRisk: coerceNumber(config.defaultCapitalAtRisk),
    entryPricePolicy,
    historicalPricesDir,
    maxSignals: config.maxSignals,
    outputRoot,
    priceFilePattern: config.priceFilePattern,
    runId: config.runId,
    signalsFile: config.signalsFile || null,
    signalsInline: Array.isArray(config.signals) ? config.signals : null,
    tickerPriceCache: new Map()
  };
}

function loadSignals(normalizedConfig) {
  const rawSignals = normalizedConfig.signalsInline
    ? normalizedConfig.signalsInline
    : readSignalsFile(normalizedConfig.signalsFile, normalizedConfig.configPath);
  const selectedSignals = Number.isInteger(normalizedConfig.maxSignals)
    ? rawSignals.slice(0, normalizedConfig.maxSignals)
    : rawSignals;
  const errors = selectedSignals.flatMap((signal, index) => validateSignal(signal, index));

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }

  return selectedSignals.map((signal, index) => ({
    assetType: normalizeEnum(signal.assetType || "equity"),
    capitalAtRisk: coerceNumber(signal.capitalAtRisk),
    catalystType: normalizeEnum(signal.catalystType || ""),
    companyName: normalizeText(signal.companyName),
    entryPrice: coerceNumber(signal.entryPrice),
    index,
    liquidityNote: normalizeText(signal.liquidityNote),
    marketCapCategory: normalizeEnum(signal.marketCapCategory || ""),
    notes: normalizeText(signal.notes),
    playbook: normalizeEnum(signal.playbook),
    signalDate: signal.signalDate,
    setupRankAtEntry: normalizeText(signal.setupRankAtEntry),
    source: normalizeText(signal.source || "manual"),
    ticker: normalizeTicker(signal.ticker),
    whyItLookedGood: normalizeText(signal.whyItLookedGood)
  }));
}

function readSignalsFile(signalsFile, configPath) {
  const signalsPath = resolveRelativeToConfigOrCwd(signalsFile, configPath);
  const payload = readJsonFile(signalsPath);

  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload.signals)) {
    return payload.signals;
  }

  throw new Error("signalsFile debe contener un array o un objeto { signals: [] }.");
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function loadLocalCsvRows(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error(`CSV historico vacio o incompleto: ${filePath}.`);
  }

  const headers = parseCsvLine(lines[0]).map((header) => normalizeEnum(header));
  REQUIRED_PRICE_COLUMNS.forEach((column) => {
    if (!headers.includes(column)) {
      throw new Error(`Falta columna ${column} en ${filePath}.`);
    }
  });

  return lines
    .slice(1)
    .map((line, rowIndex) => {
      const values = parseCsvLine(line);

      if (values.length !== headers.length) {
        throw new Error(`Fila CSV invalida en ${filePath} linea ${rowIndex + 2}.`);
      }

      const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
      const parsed = {
        close: Number(row.close),
        date: row.date,
        high: Number(row.high),
        low: Number(row.low),
        open: Number(row.open),
        volume: Number(row.volume)
      };

      if (!isValidDateOnlyString(parsed.date)) {
        throw new Error(`Fecha invalida en ${filePath} linea ${rowIndex + 2}: ${row.date}.`);
      }

      ["open", "high", "low", "close", "volume"].forEach((fieldName) => {
        if (!isFiniteNumber(parsed[fieldName])) {
          throw new Error(`Numero invalido en ${filePath} linea ${rowIndex + 2} campo ${fieldName}.`);
        }
      });

      return parsed;
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function resolvePriceFilePath(signal, config) {
  return path.join(
    config.historicalPricesDir,
    config.priceFilePattern.replaceAll("{ticker}", signal.ticker)
  );
}

function getRowsForSignal(signal, config) {
  if (config.tickerPriceCache.has(signal.ticker)) {
    return config.tickerPriceCache.get(signal.ticker);
  }

  const priceFilePath = resolvePriceFilePath(signal, config);

  if (!fs.existsSync(priceFilePath)) {
    throw new Error(`No existe CSV historico: ${priceFilePath}.`);
  }

  const rows = loadLocalCsvRows(priceFilePath);
  config.tickerPriceCache.set(signal.ticker, rows);
  return rows;
}

function resolveEntry(signal, rows, config) {
  const firstOnOrAfterIndex = rows.findIndex((row) => row.date >= signal.signalDate);
  const firstAfterIndex = rows.findIndex((row) => row.date > signal.signalDate);
  const policy = config.entryPricePolicy;

  if (policy === "provided") {
    if (!isFiniteNumber(signal.entryPrice) || signal.entryPrice <= 0) {
      throw new Error("entryPricePolicy=provided requiere entryPrice.");
    }

    if (firstOnOrAfterIndex === -1) {
      throw new Error(`No hay precio disponible en o despues de ${signal.signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstOnOrAfterIndex].date,
      entryIndex: firstOnOrAfterIndex,
      entryPrice: round(signal.entryPrice, 4),
      entryPriceSource: "provided"
    };
  }

  if (policy === "signal-close") {
    if (firstOnOrAfterIndex === -1) {
      throw new Error(`No hay close disponible en o despues de ${signal.signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstOnOrAfterIndex].date,
      entryIndex: firstOnOrAfterIndex,
      entryPrice: rows[firstOnOrAfterIndex].close,
      entryPriceSource: "signal-close"
    };
  }

  if (policy === "next-open") {
    if (firstAfterIndex === -1) {
      throw new Error(`No hay open disponible despues de ${signal.signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstAfterIndex].date,
      entryIndex: firstAfterIndex,
      entryPrice: rows[firstAfterIndex].open,
      entryPriceSource: "next-open"
    };
  }

  if (policy === "next-close") {
    if (firstAfterIndex === -1) {
      throw new Error(`No hay close disponible despues de ${signal.signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstAfterIndex].date,
      entryIndex: firstAfterIndex,
      entryPrice: rows[firstAfterIndex].close,
      entryPriceSource: "next-close"
    };
  }

  throw new Error(`entryPricePolicy no soportada: ${policy}.`);
}

function buildEvaluationPoints(rows, entry) {
  const closeBasedEntry = ["provided", "signal-close", "next-close"].includes(entry.entryPriceSource);
  const startOffset = closeBasedEntry ? 1 : 0;
  const points = [
    {
      close: entry.entryPrice,
      date: entry.entryDate,
      day: 0,
      low: entry.entryPrice,
      returnPct: 0
    }
  ];

  for (let index = entry.entryIndex + startOffset; index < rows.length; index += 1) {
    const row = rows[index];
    const day = points.length;

    points.push({
      close: row.close,
      date: row.date,
      day,
      low: row.low,
      returnPct: round(((row.close - entry.entryPrice) / entry.entryPrice) * 100, 2)
    });
  }

  return points;
}

function getPointAtHorizon(points, horizon) {
  return points.find((point) => point.day === horizon) || null;
}

function getReturnAtHorizon(points, horizon) {
  const point = getPointAtHorizon(points, horizon);
  return point ? point.returnPct : null;
}

function getHit(points, targetPct) {
  return points.some((point) => point.returnPct >= targetPct);
}

function classifySignal(maxReturnPct) {
  if (!isFiniteNumber(maxReturnPct) || maxReturnPct < 10) {
    return "failed";
  }

  if (maxReturnPct < 25) {
    return "small-win";
  }

  if (maxReturnPct < 100) {
    return "strong-win";
  }

  if (maxReturnPct < 500) {
    return "multibagger";
  }

  return "monster";
}

function getMaxDrawdownBeforePeak(points, peakPoint) {
  if (!peakPoint) {
    return null;
  }

  const pointsBeforePeak = points.filter((point) => point.day <= peakPoint.day);

  if (!pointsBeforePeak.length) {
    return null;
  }

  return Math.min(0, ...pointsBeforePeak.map((point) => point.returnPct));
}

function isLookedGoodFailure(signal, classification) {
  if (classification !== "failed") {
    return false;
  }

  return (
    ["A+", "A"].includes(signal.setupRankAtEntry) ||
    isNonEmptyString(signal.whyItLookedGood)
  );
}

function analyzeSignal(signal, config) {
  const rows = getRowsForSignal(signal, config);
  const entry = resolveEntry(signal, rows, config);
  const points = buildEvaluationPoints(rows, entry);
  const availableTradingDays = points.length - 1;
  const returnFields = Object.fromEntries(
    HORIZONS.map((horizon) => [`return${horizon}d`, getReturnAtHorizon(points, horizon)])
  );
  const peakPoint = points.reduce(
    (best, point) => (!best || point.returnPct > best.returnPct ? point : best),
    null
  );
  const maxReturnPct = peakPoint ? peakPoint.returnPct : null;
  const classification = classifySignal(maxReturnPct);
  const maxDrawdownBeforePeak = getMaxDrawdownBeforePeak(points, peakPoint);
  const capitalAtRisk = isFiniteNumber(signal.capitalAtRisk)
    ? signal.capitalAtRisk
    : config.defaultCapitalAtRisk;

  return {
    ...signal,
    ...returnFields,
    availableTradingDays,
    capitalAtRisk: isFiniteNumber(capitalAtRisk) ? capitalAtRisk : null,
    classification,
    daysToPeak: peakPoint ? peakPoint.day : null,
    entryDate: entry.entryDate,
    entryPrice: entry.entryPrice,
    entryPricePolicy: config.entryPricePolicy,
    entryPriceSource: entry.entryPriceSource,
    failureRate: classification === "failed" ? 100 : 0,
    hit25: getHit(points, 25),
    hit50: getHit(points, 50),
    hit100: getHit(points, 100),
    hit200: getHit(points, 200),
    hit500: getHit(points, 500),
    latestAvailablePriceDate: points.length ? points[points.length - 1].date : null,
    lookedGoodButFailed: isLookedGoodFailure(signal, classification),
    maxDrawdownBeforePeak,
    maxReturnPct,
    payoffMultiple: isFiniteNumber(maxReturnPct) ? round(1 + maxReturnPct / 100, 4) : null,
    priceSource: formatRelative(resolvePriceFilePath(signal, config)),
    status: availableTradingDays >= Math.min(...HORIZONS)
      ? HORIZONS.every((horizon) => availableTradingDays >= horizon) ? "completed" : "partial"
      : availableTradingDays > 0 ? "partial" : "pending"
  };
}

function createEmptyPlaybookStats(playbook) {
  return {
    averageMaxReturn: null,
    capitalAtRisk: null,
    failureRate: null,
    hit25: null,
    hit50: null,
    hit100: null,
    hit200: null,
    hit500: null,
    medianDrawdownBeforePeak: null,
    medianPayoffMultiple: null,
    monsterCount: 0,
    multibaggerCount: 0,
    payoffMultiple: null,
    playbook,
    signalsCount: 0,
    smallWinCount: 0,
    strongWinCount: 0
  };
}

function buildStatsForPlaybook(playbook, signals) {
  if (!signals.length) {
    return createEmptyPlaybookStats(playbook);
  }

  const count = signals.length;

  return {
    averageMaxReturn: average(signals.map((signal) => signal.maxReturnPct)),
    capitalAtRisk: average(signals.map((signal) => signal.capitalAtRisk)),
    failureRate: percentage(signals.filter((signal) => signal.classification === "failed").length, count),
    hit25: percentage(signals.filter((signal) => signal.hit25).length, count),
    hit50: percentage(signals.filter((signal) => signal.hit50).length, count),
    hit100: percentage(signals.filter((signal) => signal.hit100).length, count),
    hit200: percentage(signals.filter((signal) => signal.hit200).length, count),
    hit500: percentage(signals.filter((signal) => signal.hit500).length, count),
    medianDrawdownBeforePeak: median(signals.map((signal) => signal.maxDrawdownBeforePeak)),
    medianPayoffMultiple: median(signals.map((signal) => signal.payoffMultiple)),
    monsterCount: signals.filter((signal) => signal.classification === "monster").length,
    multibaggerCount: signals.filter((signal) => signal.classification === "multibagger").length,
    payoffMultiple: average(signals.map((signal) => signal.payoffMultiple)),
    playbook,
    signalsCount: count,
    smallWinCount: signals.filter((signal) => signal.classification === "small-win").length,
    strongWinCount: signals.filter((signal) => signal.classification === "strong-win").length
  };
}

function buildPlaybookStats(analyzedSignals) {
  return Object.fromEntries(
    PLAYBOOKS.map((playbook) => [
      playbook,
      buildStatsForPlaybook(
        playbook,
        analyzedSignals.filter((signal) => signal.playbook === playbook)
      )
    ])
  );
}

function rankPlaybooks(stats, direction) {
  return Object.values(stats)
    .filter((item) => item.signalsCount > 0)
    .sort((left, right) => {
      const leftScore = (left.hit100 || 0) + (left.hit200 || 0) + (left.averageMaxReturn || 0) - (left.failureRate || 0);
      const rightScore = (right.hit100 || 0) + (right.hit200 || 0) + (right.averageMaxReturn || 0) - (right.failureRate || 0);

      return direction === "best" ? rightScore - leftScore : leftScore - rightScore;
    });
}

function buildCandidateRules(analyzedSignals, playbookStats) {
  const rules = [];
  const completedSignals = analyzedSignals.filter((signal) => signal.status === "completed");
  const bestPlaybooks = rankPlaybooks(playbookStats, "best");
  const highFailurePlaybooks = Object.values(playbookStats)
    .filter((item) => item.signalsCount > 0 && isFiniteNumber(item.failureRate) && item.failureRate >= 50)
    .sort((left, right) => right.failureRate - left.failureRate);

  if (analyzedSignals.length < 20) {
    rules.push("No promover reglas definitivas con muestra menor a 20 senales.");
  }

  if (completedSignals.length < analyzedSignals.length) {
    rules.push("Separar senales partial/pending antes de calibrar WALY 3.0.");
  }

  if (bestPlaybooks[0] && (bestPlaybooks[0].hit100 || 0) > 0) {
    rules.push(`Priorizar ${bestPlaybooks[0].playbook} solo cuando catalyst, liquidez y downside esten documentados.`);
  }

  if (highFailurePlaybooks[0]) {
    rules.push(`Penalizar ${highFailurePlaybooks[0].playbook} si no hay confirmacion posterior: failureRate ${formatPercent(highFailurePlaybooks[0].failureRate)}.`);
  }

  rules.push("No llamar multibagger a una idea sin ruta verificable a +100% y volumen real.");
  rules.push("Medir drawdown antes del pico: si el camino exige aguantar demasiado dolor, bajar size o descartar.");

  return [...new Set(rules)];
}

function buildSummary(analyzedSignals, errors, playbookStats, config) {
  const total = analyzedSignals.length;
  const multibaggers = analyzedSignals.filter((signal) =>
    ["multibagger", "monster"].includes(signal.classification)
  );

  return {
    allowNetwork: false,
    averageMaxReturn: average(analyzedSignals.map((signal) => signal.maxReturnPct)),
    candidateRules: buildCandidateRules(analyzedSignals, playbookStats),
    dataProvider: config.dataProvider,
    errorCount: errors.length,
    failureRate: percentage(analyzedSignals.filter((signal) => signal.classification === "failed").length, total),
    hit100: percentage(analyzedSignals.filter((signal) => signal.hit100).length, total),
    hit200: percentage(analyzedSignals.filter((signal) => signal.hit200).length, total),
    hit500: percentage(analyzedSignals.filter((signal) => signal.hit500).length, total),
    medianDrawdownBeforePeak: median(analyzedSignals.map((signal) => signal.maxDrawdownBeforePeak)),
    monsterCount: analyzedSignals.filter((signal) => signal.classification === "monster").length,
    multibaggerCount: multibaggers.length,
    partialSignals: analyzedSignals.filter((signal) => signal.status === "partial").length,
    pendingSignals: analyzedSignals.filter((signal) => signal.status === "pending").length,
    runId: config.runId,
    signalsCount: total,
    source: config.signalsInline ? "config.signals" : config.signalsFile,
    statusCompleted: analyzedSignals.filter((signal) => signal.status === "completed").length
  };
}

function renderPlaybookList(items) {
  if (!items.length) {
    return "- Sin muestra.";
  }

  return items
    .slice(0, 5)
    .map((item) =>
      `- ${item.playbook}: count ${item.signalsCount} | hit100 ${formatPercent(item.hit100)} | avg max ${formatPercent(item.averageMaxReturn)} | failure ${formatPercent(item.failureRate)}`
    )
    .join("\n");
}

function renderSummaryMarkdown(summary, analyzedSignals, playbookStats, errors) {
  const bestPlaybooks = rankPlaybooks(playbookStats, "best");
  const worstPlaybooks = rankPlaybooks(playbookStats, "worst");
  const lookedGoodFailures = analyzedSignals.filter((signal) => signal.lookedGoodButFailed);

  return [
    `# WALY Multibagger Lab - ${summary.runId}`,
    "",
    "_Research/backtest local. No opera, no usa brokers, no toca cartera ni outcomes._",
    "",
    "## 1. Cantidad de senales",
    `- Total analizadas: ${summary.signalsCount}`,
    `- Completed: ${summary.statusCompleted} | partial: ${summary.partialSignals} | pending: ${summary.pendingSignals} | errors: ${summary.errorCount}`,
    "",
    "## 2. Cantidad de multibaggers",
    `- Multibagger o monster: ${summary.multibaggerCount}`,
    `- Monster: ${summary.monsterCount}`,
    "",
    "## 3. Hit100 / Hit200 / Hit500",
    `- hit100: ${formatPercent(summary.hit100)}`,
    `- hit200: ${formatPercent(summary.hit200)}`,
    `- hit500: ${formatPercent(summary.hit500)}`,
    "",
    "## 4. Average Max Return",
    `- average max return: ${formatPercent(summary.averageMaxReturn)}`,
    "",
    "## 5. Median Drawdown Before Peak",
    `- median drawdown before peak: ${formatPercent(summary.medianDrawdownBeforePeak)}`,
    "",
    "## 6. Mejores Playbooks",
    renderPlaybookList(bestPlaybooks),
    "",
    "## 7. Peores Playbooks",
    renderPlaybookList(worstPlaybooks),
    "",
    "## 8. Senales Que Parecian Buenas Pero Fallaron",
    ...(lookedGoodFailures.length
      ? lookedGoodFailures.map((signal) =>
        `- ${signal.ticker} | ${signal.playbook} | max ${formatPercent(signal.maxReturnPct)} | DD ${formatPercent(signal.maxDrawdownBeforePeak)} | ${signal.whyItLookedGood || signal.setupRankAtEntry || "sin detalle"}`
      )
      : ["- Ninguna en esta muestra."]),
    "",
    "## 9. Reglas Candidatas Para WALY 3.0",
    ...summary.candidateRules.map((rule) => `- ${rule}`),
    "",
    "## Playbook Stats",
    "| playbook | count | failureRate | hit25 | hit50 | hit100 | hit200 | hit500 | avgMaxReturn | medianDDBeforePeak | payoffMultiple |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...PLAYBOOKS.map((playbook) => {
      const item = playbookStats[playbook];
      return `| ${playbook} | ${item.signalsCount} | ${formatPercent(item.failureRate)} | ${formatPercent(item.hit25)} | ${formatPercent(item.hit50)} | ${formatPercent(item.hit100)} | ${formatPercent(item.hit200)} | ${formatPercent(item.hit500)} | ${formatPercent(item.averageMaxReturn)} | ${formatPercent(item.medianDrawdownBeforePeak)} | ${formatNumber(item.payoffMultiple)} |`;
    }),
    "",
    "## Errors",
    ...(errors.length
      ? errors.map((error) => `- ${error.ticker || "n/d"} | ${error.message}`)
      : ["- Sin errores."])
  ].join("\n");
}

function buildRunPaths(config) {
  const runDir = ensureBacktestsPath(path.join(config.outputRoot, config.runId));

  return {
    analyzedSignalsPath: path.join(runDir, "analyzedSignals.json"),
    playbookStatsPath: path.join(runDir, "playbookStats.json"),
    rawSignalsPath: path.join(runDir, "rawSignals.json"),
    runDir,
    summaryPath: path.join(runDir, "summary.md")
  };
}

function runMultibaggerLab(configPathInput) {
  const configPath = resolveConfigPath(configPathInput);
  const configPayload = readJsonFile(configPath);

  validateConfig(configPayload);

  const config = normalizeConfig(configPayload, configPath);
  const runPaths = buildRunPaths(config);
  const rawSignals = loadSignals(config);
  const errors = [];
  const analyzedSignals = [];

  rawSignals.forEach((signal) => {
    try {
      analyzedSignals.push(analyzeSignal(signal, config));
    } catch (error) {
      errors.push({
        message: error.message,
        playbook: signal.playbook,
        signalDate: signal.signalDate,
        ticker: signal.ticker
      });
    }
  });

  const playbookStats = buildPlaybookStats(analyzedSignals);
  const summary = buildSummary(analyzedSignals, errors, playbookStats, config);
  const summaryMarkdown = renderSummaryMarkdown(summary, analyzedSignals, playbookStats, errors);
  const generatedAt = new Date().toISOString();

  fs.mkdirSync(runPaths.runDir, { recursive: true });
  writeJsonAtomic(runPaths.rawSignalsPath, {
    generatedAt,
    runId: config.runId,
    signals: rawSignals
  });
  writeJsonAtomic(runPaths.analyzedSignalsPath, {
    errors,
    generatedAt,
    runId: config.runId,
    signals: analyzedSignals
  });
  writeJsonAtomic(runPaths.playbookStatsPath, {
    generatedAt,
    playbookStats,
    runId: config.runId,
    summary
  });
  writeFileAtomic(runPaths.summaryPath, summaryMarkdown);

  return {
    analyzedSignals,
    errors,
    paths: runPaths,
    playbookStats,
    rawSignals,
    summary
  };
}

module.exports = {
  PLAYBOOKS,
  runMultibaggerLab
};
