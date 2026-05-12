"use strict";

const fs = require("fs");
const path = require("path");
const {
  VALID_CATALYST_TYPES,
  VALID_OUTCOME_SOURCE_KINDS,
  VALID_PLAYBOOK_TYPES,
  VALID_SETUP_RANKS
} = require("./constants");
const { BACKTESTS_DIR } = require("./storage");
const {
  isFiniteNumber,
  isNonEmptyString,
  isValidDateOnlyString,
  isValidTimestampString,
  normalizeTextEnum,
  normalizeTicker
} = require("./validators");

const FIXED_HORIZONS = [5, 10, 20, 30];
const FIXED_HIT_TARGETS = [7, 10, 15];
const DEFAULT_HORIZONS = FIXED_HORIZONS;
const DEFAULT_HIT_TARGETS = FIXED_HIT_TARGETS;
const DEFAULT_CHECKPOINT_EVERY = 25;
const FAILED_FAST_THRESHOLD_PCT = -7;
const REQUIRED_PRICE_COLUMNS = ["date", "open", "high", "low", "close", "volume"];
const VALID_ENTRY_PRICE_POLICIES = ["provided", "signal-close", "next-open", "next-close"];

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

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
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

function resolveSignalsPath(signalsFile, configPath) {
  const candidatePaths = [
    path.resolve(path.dirname(configPath), signalsFile),
    path.resolve(process.cwd(), signalsFile)
  ];

  const found = candidatePaths.find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error(`No existe signalsFile: ${signalsFile}.`);
  }

  return found;
}

function resolveHistoricalPricesDir(historicalPricesDir, configPath) {
  const candidatePaths = [
    path.resolve(path.dirname(configPath), historicalPricesDir),
    path.resolve(process.cwd(), historicalPricesDir)
  ];
  const found = candidatePaths.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
  );

  if (!found) {
    throw new Error(`No existe historicalPricesDir: ${historicalPricesDir}.`);
  }

  return found;
}

function resolveOutputRoot(outputDir) {
  if (!isNonEmptyString(outputDir)) {
    return ensureBacktestsPath(BACKTESTS_DIR);
  }

  const absolute = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(process.cwd(), outputDir);

  return ensureBacktestsPath(absolute);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return Number(sorted[middle].toFixed(1));
  }

  return Number((((sorted[middle - 1] + sorted[middle]) / 2)).toFixed(1));
}

function average(values) {
  if (!values.length) {
    return null;
  }

  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function percentage(part, total) {
  if (!total) {
    return null;
  }

  return Number(((part / total) * 100).toFixed(1));
}

function toSafeLabel(value, fallback) {
  return isNonEmptyString(value) ? value : fallback;
}

function stableHash(input) {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function roundPrice(value) {
  return Number(value.toFixed(2));
}

function roundPercent(value) {
  return Number(value.toFixed(1));
}

function parseCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addBusinessDays(dateString, offset) {
  const parts = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  let remaining = Math.abs(offset);
  const step = offset >= 0 ? 1 : -1;

  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + step);

    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      remaining -= 1;
    }
  }

  return formatDateOnly(date);
}

function getNextBusinessDate(dateString) {
  return addBusinessDays(dateString, 1);
}

function validateHistoricalSignal(signal, index) {
  const issues = [];
  const label = `signals[${index}]`;

  if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
    issues.push(`${label} debe ser un objeto simple.`);
    return issues;
  }

  if (!isNonEmptyString(signal.ticker)) {
    issues.push(`${label}.ticker es obligatorio.`);
  }

  if (!isNonEmptyString(signal.signalDate) || !isValidDateOnlyString(signal.signalDate)) {
    issues.push(`${label}.signalDate debe usar formato YYYY-MM-DD valido.`);
  }

  if (!isNonEmptyString(signal.assetType) || !["equity", "etf"].includes(signal.assetType)) {
    issues.push(`${label}.assetType debe ser equity o etf.`);
  }

  if (!isNonEmptyString(signal.playbookType) || !VALID_PLAYBOOK_TYPES.includes(signal.playbookType)) {
    issues.push(`${label}.playbookType debe ser uno de ${VALID_PLAYBOOK_TYPES.join(", ")}.`);
  }

  if (
    !isNonEmptyString(signal.setupRankAtEntry) ||
    !VALID_SETUP_RANKS.includes(signal.setupRankAtEntry)
  ) {
    issues.push(`${label}.setupRankAtEntry debe ser uno de ${VALID_SETUP_RANKS.join(", ")}.`);
  }

  if (
    signal.catalystType !== undefined &&
    (!isNonEmptyString(signal.catalystType) || !VALID_CATALYST_TYPES.includes(signal.catalystType))
  ) {
    issues.push(`${label}.catalystType debe ser uno de ${VALID_CATALYST_TYPES.join(", ")} si existe.`);
  }

  if (
    signal.entryPrice !== undefined &&
    (!isFiniteNumber(signal.entryPrice) || signal.entryPrice <= 0)
  ) {
    issues.push(`${label}.entryPrice debe ser un numero mayor a 0 si existe.`);
  }

  if (
    signal.sourceKind !== undefined &&
    (!isNonEmptyString(signal.sourceKind) || !VALID_OUTCOME_SOURCE_KINDS.includes(signal.sourceKind))
  ) {
    issues.push(`${label}.sourceKind debe ser uno de ${VALID_OUTCOME_SOURCE_KINDS.join(", ")} si existe.`);
  }

  if (signal.notes !== undefined && !isNonEmptyString(signal.notes)) {
    issues.push(`${label}.notes debe ser string no vacio si existe.`);
  }

  if (
    signal.actualExecutionVerified !== undefined &&
    typeof signal.actualExecutionVerified !== "boolean"
  ) {
    issues.push(`${label}.actualExecutionVerified debe ser boolean si existe.`);
  }

  if (
    signal.entryPriceNote !== undefined &&
    !isNonEmptyString(signal.entryPriceNote)
  ) {
    issues.push(`${label}.entryPriceNote debe ser string no vacio si existe.`);
  }

  return issues;
}

function validateSignalsFile(signalsData) {
  if (!signalsData || !Array.isArray(signalsData.signals)) {
    throw new Error("historical signals debe contener un array signals.");
  }

  const errors = signalsData.signals.flatMap((signal, index) =>
    validateHistoricalSignal(signal, index)
  );

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("La config de historical-backtest debe ser un objeto JSON.");
  }

  if (!isNonEmptyString(config.runId) || !/^[a-z0-9][a-z0-9-_]*$/i.test(config.runId)) {
    errors.push("runId es obligatorio y solo puede usar letras, numeros, - y _.");
  }

  if (config.dryRun !== undefined && typeof config.dryRun !== "boolean") {
    errors.push("dryRun debe ser boolean si existe.");
  }

  if (config.maxSignals !== undefined && !isPositiveInteger(config.maxSignals)) {
    errors.push("maxSignals debe ser un entero mayor a 0 si existe.");
  }

  if (config.dryRun === true && !isPositiveInteger(config.maxSignals)) {
    errors.push("dryRun=true requiere maxSignals para evitar corridas largas.");
  }

  if (
    config.checkpointEvery !== undefined &&
    !isPositiveInteger(config.checkpointEvery)
  ) {
    errors.push("checkpointEvery debe ser un entero mayor a 0 si existe.");
  }

  if (config.outputDir !== undefined && !isNonEmptyString(config.outputDir)) {
    errors.push("outputDir debe ser string no vacio si existe.");
  }

  if (
    config.resumeFromCheckpoint !== undefined &&
    typeof config.resumeFromCheckpoint !== "boolean"
  ) {
    errors.push("resumeFromCheckpoint debe ser boolean si existe.");
  }

  if (!isNonEmptyString(config.signalsFile)) {
    errors.push("signalsFile es obligatorio.");
  }

  if (
    config.horizons !== undefined &&
    (!Array.isArray(config.horizons) || config.horizons.some((value) => !isPositiveInteger(value)))
  ) {
    errors.push("horizons debe ser un array de enteros positivos si existe.");
  }

  if (
    config.hitTargetsPct !== undefined &&
    (!Array.isArray(config.hitTargetsPct) || config.hitTargetsPct.some((value) => !isPositiveInteger(value)))
  ) {
    errors.push("hitTargetsPct debe ser un array de enteros positivos si existe.");
  }

  if (
    !isNonEmptyString(config.dataProvider) ||
    !["mock", "local-csv"].includes(normalizeTextEnum(config.dataProvider))
  ) {
    errors.push("dataProvider debe ser mock o local-csv.");
  }

  if (
    config.entryPricePolicy !== undefined &&
    (
      !isNonEmptyString(config.entryPricePolicy) ||
      !VALID_ENTRY_PRICE_POLICIES.includes(normalizeTextEnum(config.entryPricePolicy))
    )
  ) {
    errors.push(`entryPricePolicy debe ser uno de ${VALID_ENTRY_PRICE_POLICIES.join(", ")}.`);
  }

  if (
    config.historicalPricesDir !== undefined &&
    !isNonEmptyString(config.historicalPricesDir)
  ) {
    errors.push("historicalPricesDir debe ser string no vacio si existe.");
  }

  if (
    config.priceFilePattern !== undefined &&
    !isNonEmptyString(config.priceFilePattern)
  ) {
    errors.push("priceFilePattern debe ser string no vacio si existe.");
  }

  if (normalizeTextEnum(config.dataProvider) === "local-csv") {
    if (!isNonEmptyString(config.historicalPricesDir)) {
      errors.push("dataProvider=local-csv requiere historicalPricesDir.");
    }

    if (!isNonEmptyString(config.priceFilePattern)) {
      errors.push("dataProvider=local-csv requiere priceFilePattern.");
    } else if (!config.priceFilePattern.includes("{ticker}")) {
      errors.push("priceFilePattern debe incluir {ticker} para dataProvider=local-csv.");
    }
  }

  if (typeof config.allowNetwork !== "boolean") {
    errors.push("allowNetwork debe ser boolean.");
  }

  if (config.allowNetwork !== false) {
    errors.push("allowNetwork debe ser false en Historical Signal Backtest MVP.");
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

function normalizeConfig(config, configPath) {
  const outputRoot = resolveOutputRoot(config.outputDir || BACKTESTS_DIR);
  const signalsPath = resolveSignalsPath(config.signalsFile, configPath);
  const dataProvider = normalizeTextEnum(config.dataProvider);

  return {
    allowNetwork: false,
    checkpointEvery: config.checkpointEvery || DEFAULT_CHECKPOINT_EVERY,
    configPath,
    dataProvider,
    dryRun: config.dryRun === true,
    entryPricePolicy: normalizeTextEnum(config.entryPricePolicy || "next-open"),
    hitTargetsPct: Array.from(new Set(config.hitTargetsPct || DEFAULT_HIT_TARGETS)).sort((left, right) => left - right),
    historicalPricesDir:
      dataProvider === "local-csv"
        ? resolveHistoricalPricesDir(config.historicalPricesDir, configPath)
        : null,
    horizons: Array.from(new Set(config.horizons || DEFAULT_HORIZONS)).sort((left, right) => left - right),
    maxSignals: config.maxSignals,
    outputRoot,
    priceFilePattern: isNonEmptyString(config.priceFilePattern) ? config.priceFilePattern : null,
    resumeFromCheckpoint: config.resumeFromCheckpoint === true,
    runId: config.runId,
    signalsFile: config.signalsFile,
    signalsPath,
    tickerPriceCache: new Map()
  };
}

function loadSignals(signalsPath) {
  const data = readJsonFile(signalsPath);
  validateSignalsFile(data);
  return data.signals.map((signal) => ({
    ...signal,
    actualExecutionVerified:
      typeof signal.actualExecutionVerified === "boolean"
        ? signal.actualExecutionVerified
        : null,
    assetType: normalizeTextEnum(signal.assetType),
    catalystType: signal.catalystType ? normalizeTextEnum(signal.catalystType) : undefined,
    entryPriceNote: signal.entryPriceNote || null,
    playbookType: normalizeTextEnum(signal.playbookType),
    setupRankAtEntry: signal.setupRankAtEntry,
    sourceKind: signal.sourceKind ? normalizeTextEnum(signal.sourceKind) : undefined,
    ticker: normalizeTicker(signal.ticker)
  }));
}

function buildRunPaths(normalizedConfig) {
  const runDir = ensureBacktestsPath(path.join(normalizedConfig.outputRoot, normalizedConfig.runId));

  return {
    checkpointPath: path.join(runDir, "checkpoint.json"),
    priceCoveragePath: path.join(runDir, "price-coverage.json"),
    runDir,
    signalsPath: path.join(runDir, "signals.json"),
    summaryJsonPath: path.join(runDir, "summary.json"),
    summaryMarkdownPath: path.join(runDir, "summary.md")
  };
}

function formatIntegerList(values) {
  return values.length ? values.join(", ") : "none";
}

function isCsvValidationError(error) {
  return (
    error.message.startsWith("CSV historico vacio o incompleto:") ||
    error.message.startsWith("Falta columna ") ||
    error.message.startsWith("Fila CSV invalida en ") ||
    error.message.startsWith("Fecha invalida en ") ||
    error.message.startsWith("Numero invalido en ")
  );
}

function getConservativeCoverageRange(signalDate) {
  return {
    requiredEndDate: addBusinessDays(signalDate, 45),
    requiredStartDate: addBusinessDays(signalDate, -10)
  };
}

function validatePriceColumns(headers, filePath) {
  const normalizedHeaders = headers.map((header) => normalizeTextEnum(header));

  REQUIRED_PRICE_COLUMNS.forEach((column) => {
    if (!normalizedHeaders.includes(column)) {
      throw new Error(`Falta columna ${column} en ${filePath}.`);
    }
  });

  return normalizedHeaders;
}

function loadLocalCsvRows(filePath) {
  let raw;

  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`No existe CSV historico: ${filePath}.`);
    }

    throw error;
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error(`CSV historico vacio o incompleto: ${filePath}.`);
  }

  const headers = validatePriceColumns(parseCsvLine(lines[0]), filePath);
  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);

    if (values.length !== headers.length) {
      throw new Error(`Fila CSV invalida en ${filePath} linea ${index + 2}.`);
    }

    const row = Object.fromEntries(headers.map((header, valueIndex) => [header, values[valueIndex]]));
    const numericFields = ["open", "high", "low", "close", "volume"];
    const parsed = {
      close: Number(row.close),
      date: row.date,
      high: Number(row.high),
      low: Number(row.low),
      open: Number(row.open),
      volume: Number(row.volume)
    };

    if (!isValidDateOnlyString(parsed.date)) {
      throw new Error(`Fecha invalida en ${filePath} linea ${index + 2}: ${row.date}.`);
    }

    numericFields.forEach((field) => {
      if (!isFiniteNumber(parsed[field])) {
        throw new Error(`Numero invalido en ${filePath} linea ${index + 2} campo ${field}.`);
      }
    });

    return parsed;
  });

  return rows.sort((left, right) => left.date.localeCompare(right.date));
}

function resolvePriceFilePath(signal, normalizedConfig) {
  const relativeFile = normalizedConfig.priceFilePattern.replaceAll("{ticker}", signal.ticker);
  return path.join(normalizedConfig.historicalPricesDir, relativeFile);
}

function getLocalCsvRows(signal, normalizedConfig) {
  if (normalizedConfig.tickerPriceCache.has(signal.ticker)) {
    return normalizedConfig.tickerPriceCache.get(signal.ticker);
  }

  const filePath = resolvePriceFilePath(signal, normalizedConfig);
  const rows = loadLocalCsvRows(filePath);
  normalizedConfig.tickerPriceCache.set(signal.ticker, rows);
  return rows;
}

function buildMockSeries(signal, maxHorizon) {
  const seedKey = `${signal.ticker}|${signal.signalDate}|${signal.playbookType}|${signal.setupRankAtEntry}`;
  const seed = stableHash(seedKey);
  const basePrice = roundPrice(8 + ((seed % 9200) / 100));
  const rows = [];
  let closePrice = basePrice;
  let tradingDate = signal.signalDate;

  for (let day = 0; day <= maxHorizon + 2; day += 1) {
    const daySeed = stableHash(`${seedKey}|${day}`);
    const drift = (((seed >>> 3) % 17) - 8) / 5000;
    const wave = Math.sin((day + (seed % 19)) * 0.85) * (0.004 + ((seed % 7) / 1000));
    const noise = (((daySeed % 1000) / 1000) - 0.5) * 0.035;
    const shockDay = 2 + (seed % 5);
    const shockMagnitude = 0.01 + ((seed % 8) / 1000);
    const shockDirection = seed % 2 === 0 ? 1 : -1;
    const shock = day === shockDay ? shockDirection * shockMagnitude : 0;
    const dailyReturn = clamp(drift + wave + noise + shock, -0.12, 0.12);
    const open = day === 0
      ? basePrice
      : roundPrice(closePrice * (1 + ((((daySeed >>> 4) % 9) - 4) / 1000)));
    const close = roundPrice(open * (1 + dailyReturn));
    const high = roundPrice(Math.max(open, close) * (1 + ((daySeed % 5) / 1000)));
    const low = roundPrice(Math.min(open, close) * (1 - (((daySeed >>> 6) % 5) / 1000)));

    rows.push({
      close,
      date: tradingDate,
      high,
      low,
      open,
      volume: 1000000 + (daySeed % 500000)
    });

    closePrice = close;
    tradingDate = getNextBusinessDate(tradingDate);
  }

  return {
    mockSeed: seed,
    rows
  };
}

function getCloseForDay(series, day) {
  return series.find((item) => item.day === day) || null;
}

function getReturnFieldName(horizon) {
  return `return${horizon}d`;
}

function getRequiredThroughDate(entryDate, horizons) {
  if (!isNonEmptyString(entryDate) || !Array.isArray(horizons) || !horizons.length) {
    return null;
  }

  return addBusinessDays(entryDate, Math.max(...horizons));
}

function getEarliestNextHorizonDate(entryDate, missingHorizons) {
  if (!isNonEmptyString(entryDate) || !Array.isArray(missingHorizons) || !missingHorizons.length) {
    return null;
  }

  return addBusinessDays(entryDate, Math.min(...missingHorizons));
}

function buildHorizonCompletion(evaluationPoints, horizons) {
  const returnsByHorizon = new Map();
  const completedHorizons = [];
  const missingHorizons = [];
  const peakReturnByHorizon = new Map();
  const hitTargetsByHorizon = new Map();

  horizons.forEach((horizon) => {
    const point = getCloseForDay(evaluationPoints, horizon);

    if (point) {
      completedHorizons.push(horizon);
      returnsByHorizon.set(horizon, point.returnPct);
      peakReturnByHorizon.set(
        horizon,
        Math.max(...evaluationPoints.filter((item) => item.day <= horizon).map((item) => item.returnPct))
      );
    } else {
      missingHorizons.push(horizon);
      returnsByHorizon.set(horizon, null);
      peakReturnByHorizon.set(horizon, null);
    }
  });

  [...peakReturnByHorizon.entries()].forEach(([horizon, peakReturn]) => {
    if (!isFiniteNumber(peakReturn)) {
      hitTargetsByHorizon.set(horizon, {
        hit10pct: null,
        hit15pct: null,
        hit7pct: null
      });
      return;
    }

    hitTargetsByHorizon.set(horizon, {
      hit10pct: peakReturn >= 10,
      hit15pct: peakReturn >= 15,
      hit7pct: peakReturn >= 7
    });
  });

  return {
    completedHorizons,
    hitTargetsByHorizon,
    missingHorizons,
    peakReturnByHorizon,
    returnsByHorizon
  };
}

function resolveEntryFromRows(signal, rows, config) {
  const policy = config.entryPricePolicy;
  const signalDate = signal.signalDate;
  const firstOnOrAfterIndex = rows.findIndex((row) => row.date >= signalDate);
  const firstAfterIndex = rows.findIndex((row) => row.date > signalDate);

  if (policy === "provided") {
    if (!isFiniteNumber(signal.entryPrice) || signal.entryPrice <= 0) {
      throw new Error("entryPricePolicy=provided requiere entryPrice en la senal.");
    }

    if (firstOnOrAfterIndex === -1) {
      throw new Error(`No hay precio disponible en o despues de ${signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstOnOrAfterIndex].date,
      entryIndex: firstOnOrAfterIndex,
      entryPrice: roundPrice(signal.entryPrice),
      entryPriceSource: "provided",
      entryPriceWarning:
        signal.actualExecutionVerified === true
          ? null
          : "provided entryPrice sin ejecucion real verificada"
    };
  }

  if (policy === "signal-close") {
    if (firstOnOrAfterIndex === -1) {
      throw new Error(`No hay close disponible en o despues de ${signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstOnOrAfterIndex].date,
      entryIndex: firstOnOrAfterIndex,
      entryPrice: roundPrice(rows[firstOnOrAfterIndex].close),
      entryPriceSource: "signal-close",
      entryPriceWarning:
        isFiniteNumber(signal.entryPrice) && signal.actualExecutionVerified !== true
          ? "entryPrice provisto ignorado por entryPricePolicy signal-close"
          : null
    };
  }

  if (policy === "next-open") {
    if (firstAfterIndex === -1) {
      throw new Error(`No hay open disponible despues de ${signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstAfterIndex].date,
      entryIndex: firstAfterIndex,
      entryPrice: roundPrice(rows[firstAfterIndex].open),
      entryPriceSource: "next-open",
      entryPriceWarning:
        isFiniteNumber(signal.entryPrice) && signal.actualExecutionVerified !== true
          ? "entryPrice provisto ignorado por entryPricePolicy next-open"
          : null
    };
  }

  if (policy === "next-close") {
    if (firstAfterIndex === -1) {
      throw new Error(`No hay close disponible despues de ${signalDate} para ${signal.ticker}.`);
    }

    return {
      entryDate: rows[firstAfterIndex].date,
      entryIndex: firstAfterIndex,
      entryPrice: roundPrice(rows[firstAfterIndex].close),
      entryPriceSource: "next-close",
      entryPriceWarning:
        isFiniteNumber(signal.entryPrice) && signal.actualExecutionVerified !== true
          ? "entryPrice provisto ignorado por entryPricePolicy next-close"
          : null
    };
  }

  throw new Error(`entryPricePolicy no soportada: ${policy}`);
}

function buildEvaluationSeries(rows, entryResolution) {
  const closeBasedEntry = entryResolution.entryPriceSource === "signal-close" ||
    entryResolution.entryPriceSource === "next-close" ||
    entryResolution.entryPriceSource === "provided";
  const startOffset = closeBasedEntry ? 1 : 0;
  const points = [
    {
      close: entryResolution.entryPrice,
      date: entryResolution.entryDate,
      day: 0,
      returnPct: 0
    }
  ];

  for (let index = entryResolution.entryIndex + startOffset; index < rows.length; index += 1) {
    const row = rows[index];
    const day = points.length;

    points.push({
      close: row.close,
      date: row.date,
      day,
      returnPct: roundPercent(((row.close - entryResolution.entryPrice) / entryResolution.entryPrice) * 100)
    });
  }

  return {
    latestAvailablePriceDate: rows.length ? rows[rows.length - 1].date : entryResolution.entryDate,
    points,
    startOffset
  };
}

function buildLocalCsvSeries(signal, normalizedConfig) {
  const rows = getLocalCsvRows(signal, normalizedConfig);
  const entryResolution = resolveEntryFromRows(signal, rows, normalizedConfig);
  const evaluation = buildEvaluationSeries(rows, entryResolution);

  return {
    entryDate: entryResolution.entryDate,
    entryPrice: entryResolution.entryPrice,
    entryPriceSource: entryResolution.entryPriceSource,
    entryPriceWarning: entryResolution.entryPriceWarning,
    evaluationPoints: evaluation.points,
    latestAvailablePriceDate: evaluation.latestAvailablePriceDate,
    priceSource: resolvePriceFilePath(signal, normalizedConfig)
  };
}

function buildPriceCoverageItem(signal, normalizedConfig) {
  const priceFilePath = resolvePriceFilePath(signal, normalizedConfig);
  const conservativeRange = getConservativeCoverageRange(signal.signalDate);
  const baseItem = {
    columnsValid: false,
    completedHorizons: [],
    csvExists: fs.existsSync(priceFilePath),
    entryDate: null,
    entryPricePolicy: normalizedConfig.entryPricePolicy,
    firstCsvDate: null,
    hasEntryDate: false,
    lastCsvDate: null,
    missingHorizons: [...normalizedConfig.horizons],
    priceFilePath,
    requiredEndDate: conservativeRange.requiredEndDate,
    requiredStartDate: conservativeRange.requiredStartDate,
    requiredThroughDate: null,
    signalDate: signal.signalDate,
    status: "missing_csv",
    ticker: signal.ticker,
    validationMessage: `No existe CSV historico: ${priceFilePath}.`
  };

  if (!baseItem.csvExists) {
    return baseItem;
  }

  let rows;

  try {
    rows = loadLocalCsvRows(priceFilePath);
  } catch (error) {
    return {
      ...baseItem,
      status: isCsvValidationError(error) ? "invalid_csv" : "insufficient_data",
      validationMessage: error.message
    };
  }

  const itemWithRows = {
    ...baseItem,
    columnsValid: true,
    firstCsvDate: rows.length ? rows[0].date : null,
    lastCsvDate: rows.length ? rows[rows.length - 1].date : null
  };

  let entryResolution;

  try {
    entryResolution = resolveEntryFromRows(signal, rows, normalizedConfig);
  } catch (error) {
    return {
      ...itemWithRows,
      requiredThroughDate: getRequiredThroughDate(signal.signalDate, normalizedConfig.horizons),
      status: "insufficient_data",
      validationMessage: error.message
    };
  }

  const evaluation = buildEvaluationSeries(rows, entryResolution);
  const horizonCompletion = buildHorizonCompletion(evaluation.points, normalizedConfig.horizons);
  const requiredThroughDate = getRequiredThroughDate(entryResolution.entryDate, normalizedConfig.horizons);
  let status = "ready";
  let validationMessage = "Cobertura completa para todos los horizontes configurados.";

  if (!horizonCompletion.completedHorizons.length) {
    status = "insufficient_data";
    validationMessage =
      `CSV historico insuficiente para ${signal.ticker}: no completa ningun horizonte configurado. ` +
      `Latest available: ${evaluation.latestAvailablePriceDate || "n/d"} | required through: ${requiredThroughDate || "n/d"}.`;
  } else if (horizonCompletion.missingHorizons.length) {
    status = "partial";
    validationMessage =
      `Faltan horizontes ${horizonCompletion.missingHorizons.join(", ")}. ` +
      `Latest available: ${evaluation.latestAvailablePriceDate || "n/d"} | required through: ${requiredThroughDate || "n/d"}.`;
  }

  return {
    ...itemWithRows,
    completedHorizons: horizonCompletion.completedHorizons,
    entryDate: entryResolution.entryDate,
    hasEntryDate: true,
    latestAvailablePriceDate: evaluation.latestAvailablePriceDate,
    missingHorizons: horizonCompletion.missingHorizons,
    requiredThroughDate,
    status,
    validationMessage
  };
}

function computeSignalMetrics(signal, priceSeries, config) {
  const horizonCompletion = buildHorizonCompletion(priceSeries.evaluationPoints, config.horizons);
  const lastConfiguredHorizon = config.horizons.length
    ? config.horizons[config.horizons.length - 1]
    : FIXED_HORIZONS[FIXED_HORIZONS.length - 1];
  const finalReturn = horizonCompletion.returnsByHorizon.get(lastConfiguredHorizon);
  const latestAvailablePriceDate =
    priceSeries.latestAvailablePriceDate ||
    (priceSeries.evaluationPoints.length
      ? priceSeries.evaluationPoints[priceSeries.evaluationPoints.length - 1].date
      : null);
  const requiredThroughDate = getRequiredThroughDate(priceSeries.entryDate || signal.signalDate, config.horizons);
  const earliestNextHorizonDate = getEarliestNextHorizonDate(
    priceSeries.entryDate || signal.signalDate,
    horizonCompletion.missingHorizons
  );
  const hasCompletedHorizons = horizonCompletion.completedHorizons.length > 0;
  const status = !horizonCompletion.missingHorizons.length
    ? "completed"
    : hasCompletedHorizons
      ? "partial"
      : "pending";
  const allReturns = hasCompletedHorizons
    ? priceSeries.evaluationPoints.map((item) => item.returnPct)
    : [];
  const peakReturnPct = allReturns.length ? Math.max(...allReturns) : null;
  const maxDrawdownPct = allReturns.length
    ? Math.min(0, Math.min(...allReturns))
    : null;
  const peakPoint = priceSeries.evaluationPoints.find((item) => item.returnPct === peakReturnPct) || null;
  const daysToPeak = peakPoint ? peakPoint.day : null;
  const earlyWindow = hasCompletedHorizons
    ? priceSeries.evaluationPoints
      .filter((item) => item.day > 0 && item.day <= Math.min(5, priceSeries.evaluationPoints.length - 1))
      .map((item) => item.returnPct)
    : [];
  const earlyMinReturn = earlyWindow.length ? Math.min(...earlyWindow) : null;
  const pendingReason = status === "pending"
    ? `Senal pendiente: CSV y entryDate validos, pero todavia no completa ningun horizonte configurado. Latest available: ${latestAvailablePriceDate || "n/d"} | earliest next horizon: ${earliestNextHorizonDate || "n/d"} | required through: ${requiredThroughDate || "n/d"}.`
    : null;
  const incompleteReason = status === "partial"
    ? `Faltan horizontes ${horizonCompletion.missingHorizons.join(", ")}. Latest available: ${latestAvailablePriceDate || "n/d"} | required through: ${requiredThroughDate || "n/d"}.`
    : pendingReason;
  const maxHorizonHitTargets = horizonCompletion.hitTargetsByHorizon.get(lastConfiguredHorizon) || {
    hit10pct: null,
    hit15pct: null,
    hit7pct: null
  };
  const hitTargetsByHorizon = Object.fromEntries(
    [...horizonCompletion.hitTargetsByHorizon.entries()].map(([horizon, hits]) => [
      String(horizon),
      hits
    ])
  );
  const returnFields = Object.fromEntries(
    config.horizons.map((horizon) => [
      getReturnFieldName(horizon),
      horizonCompletion.returnsByHorizon.get(horizon) ?? null
    ])
  );

  return {
    assetType: signal.assetType,
    catalystType: signal.catalystType || null,
    actualExecutionVerified: signal.actualExecutionVerified,
    completedHorizons: horizonCompletion.completedHorizons,
    daysToPeak,
    entryDate: priceSeries.entryDate || signal.signalDate,
    entryPrice: priceSeries.entryPrice,
    entryPriceNote: signal.entryPriceNote,
    entryPricePolicy: config.entryPricePolicy,
    entryPriceSource: priceSeries.entryPriceSource,
    entryPriceWarning: priceSeries.entryPriceWarning || null,
    earliestNextHorizonDate,
    failedFast: isFiniteNumber(earlyMinReturn) ? earlyMinReturn <= FAILED_FAST_THRESHOLD_PCT : null,
    falsePositive: isFiniteNumber(peakReturnPct) && peakReturnPct >= 7 && isFiniteNumber(finalReturn)
      ? finalReturn <= 0
      : null,
    hit10pct: status === "completed" ? maxHorizonHitTargets.hit10pct : null,
    hit15pct: status === "completed" ? maxHorizonHitTargets.hit15pct : null,
    hit7pct: status === "completed" ? maxHorizonHitTargets.hit7pct : null,
    hitTargetsByHorizon,
    incompleteReason,
    latestAvailablePriceDate,
    maxDrawdownPct,
    missingHorizons: horizonCompletion.missingHorizons,
    notes: signal.notes || "",
    pendingReason,
    peakReturnPct,
    playbookType: signal.playbookType,
    requiredThroughDate,
    ...returnFields,
    setupRankAtEntry: signal.setupRankAtEntry,
    signalDate: signal.signalDate,
    sourceKind: signal.sourceKind || null,
    status,
    ticker: signal.ticker
  };
}

function buildBucketSummary(items, config) {
  const lastConfiguredHorizon = config.horizons.length
    ? config.horizons[config.horizons.length - 1]
    : FIXED_HORIZONS[FIXED_HORIZONS.length - 1];
  const lastReturnField = getReturnFieldName(lastConfiguredHorizon);
  const matureSignals = items.filter((item) => item.completedHorizons.includes(lastConfiguredHorizon));
  const winsMeasured = matureSignals.filter((item) => isFiniteNumber(item[lastReturnField]));
  const wins = winsMeasured.filter((item) => item[lastReturnField] > 0).length;
  const hit7Measured = items.filter((item) => typeof item.hit7pct === "boolean");
  const hit10Measured = items.filter((item) => typeof item.hit10pct === "boolean");
  const hit15Measured = items.filter((item) => typeof item.hit15pct === "boolean");
  const completedByHorizon = Object.fromEntries(
    config.horizons.map((horizon) => [
      String(horizon),
      items.filter((item) => item.completedHorizons.includes(horizon)).length
    ])
  );

  return {
    avgMaxDrawdown: average(items.map((item) => item.maxDrawdownPct).filter(isFiniteNumber)),
    avgPeakReturn: average(items.map((item) => item.peakReturnPct).filter(isFiniteNumber)),
    avgReturn10d: average(items.map((item) => item.return10d).filter(isFiniteNumber)),
    avgReturn20d: average(items.map((item) => item.return20d).filter(isFiniteNumber)),
    avgReturn30d: average(items.map((item) => item.return30d).filter(isFiniteNumber)),
    avgReturn5d: average(items.map((item) => item.return5d).filter(isFiniteNumber)),
    completedByHorizon,
    completedSignals: items.filter((item) => item.status === "completed").length,
    hit10Rate: percentage(
      hit10Measured.filter((item) => item.hit10pct).length,
      hit10Measured.length
    ),
    hit15Rate: percentage(
      hit15Measured.filter((item) => item.hit15pct).length,
      hit15Measured.length
    ),
    hit7Rate: percentage(
      hit7Measured.filter((item) => item.hit7pct).length,
      hit7Measured.length
    ),
    medianDaysToPeak: median(items.map((item) => item.daysToPeak).filter(isFiniteNumber)),
    partialSignals: items.filter((item) => item.status === "partial").length,
    pendingCount: items.filter((item) => item.status === "pending").length,
    pendingSignals: items.filter((item) => item.status === "pending").length,
    signalsCount: items.length,
    winRate: percentage(wins, winsMeasured.length)
  };
}

function buildBreakdown(items, selector, fallback, config) {
  const buckets = new Map();

  items.forEach((item) => {
    const key = toSafeLabel(selector(item), fallback);

    if (!buckets.has(key)) {
      buckets.set(key, []);
    }

    buckets.get(key).push(item);
  });

  return [...buckets.entries()]
    .sort((left, right) => {
      if (right[1].length !== left[1].length) {
        return right[1].length - left[1].length;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([key, bucketItems]) => ({
      key,
      ...buildBucketSummary(bucketItems, config)
    }));
}

function buildSummary(normalizedConfig, processedSignals, errors) {
  const lastConfiguredHorizon = normalizedConfig.horizons.length
    ? normalizedConfig.horizons[normalizedConfig.horizons.length - 1]
    : FIXED_HORIZONS[FIXED_HORIZONS.length - 1];
  const lastReturnField = getReturnFieldName(lastConfiguredHorizon);
  const pendingItems = processedSignals.filter((item) => item.status === "pending");
  const entryWarnings = processedSignals
    .filter((item) => isNonEmptyString(item.entryPriceWarning))
    .map((item) => ({
      entryPriceWarning: item.entryPriceWarning,
      entryPricePolicy: item.entryPricePolicy,
      ticker: item.ticker
    }));
  const notes = normalizedConfig.dataProvider === "local-csv"
    ? [
        "Este Historical Signal Backtest usa provider local-csv sobre archivos locales.",
        "Si los CSV contienen precios historicos reales, las metricas representan retornos reales medidos ex-post.",
        "WALY no descarga estos CSV automaticamente; la preparacion de historical_prices sigue siendo manual.",
        "Las senales recientes pueden quedar partial o pending si todavia no existe cobertura suficiente para todos los horizontes configurados.",
        "pending no es fallo: significa que existe CSV y entryDate, pero no hay ningun horizonte observable todavia."
      ]
    : [
        "Este Historical Signal Backtest MVP usa provider mock deterministico.",
        "No valida edge real hasta conectarlo con history de precios reales.",
        "Las metricas se calculan solo con trayectoria posterior a signalDate para evitar look-ahead bias en la medicion."
      ];
  const completedByHorizon = Object.fromEntries(
    normalizedConfig.horizons.map((horizon) => [
      String(horizon),
      processedSignals.filter((item) => item.completedHorizons.includes(horizon)).length
    ])
  );
  const hitRatesByHorizon = Object.fromEntries(
    normalizedConfig.horizons.map((horizon) => {
      const matureSignals = processedSignals.filter((item) => item.completedHorizons.includes(horizon));
      const measured = matureSignals
        .map((item) => item.hitTargetsByHorizon[String(horizon)] || null)
        .filter(Boolean);

      return [
        String(horizon),
        {
          completedSignals: matureSignals.length,
          hit10Rate: percentage(measured.filter((item) => item.hit10pct === true).length, measured.length),
          hit15Rate: percentage(measured.filter((item) => item.hit15pct === true).length, measured.length),
          hit7Rate: percentage(measured.filter((item) => item.hit7pct === true).length, measured.length)
        }
      ];
    })
  );
  const matureSignalsForFinalHorizon = processedSignals.filter((item) =>
    item.completedHorizons.includes(lastConfiguredHorizon)
  );

  return {
    allowNetwork: normalizedConfig.allowNetwork,
    avgMaxDrawdown: average(processedSignals.map((item) => item.maxDrawdownPct).filter(isFiniteNumber)),
    avgPeakReturn: average(processedSignals.map((item) => item.peakReturnPct).filter(isFiniteNumber)),
    avgReturn10d: average(processedSignals.map((item) => item.return10d).filter(isFiniteNumber)),
    avgReturn20d: average(processedSignals.map((item) => item.return20d).filter(isFiniteNumber)),
    avgReturn30d: average(processedSignals.map((item) => item.return30d).filter(isFiniteNumber)),
    avgReturn5d: average(processedSignals.map((item) => item.return5d).filter(isFiniteNumber)),
    breakdown: {
      assetType: buildBreakdown(processedSignals, (item) => item.assetType, "unknown", normalizedConfig),
      catalystType: buildBreakdown(processedSignals, (item) => item.catalystType, "none", normalizedConfig),
      playbookType: buildBreakdown(processedSignals, (item) => item.playbookType, "unknown", normalizedConfig),
      setupRankAtEntry: buildBreakdown(processedSignals, (item) => item.setupRankAtEntry, "unknown", normalizedConfig)
    },
    completedByHorizon,
    completedSignals: processedSignals.filter((item) => item.status === "completed").length,
    dataProvider: normalizedConfig.dataProvider,
    dryRun: normalizedConfig.dryRun,
    errorCount: errors.length,
    entryPricePolicy: normalizedConfig.entryPricePolicy,
    hitRatesByHorizon,
    hit10Rate: percentage(
      matureSignalsForFinalHorizon.filter((item) => item.hit10pct === true).length,
      matureSignalsForFinalHorizon.filter((item) => typeof item.hit10pct === "boolean").length
    ),
    hit15Rate: percentage(
      matureSignalsForFinalHorizon.filter((item) => item.hit15pct === true).length,
      matureSignalsForFinalHorizon.filter((item) => typeof item.hit15pct === "boolean").length
    ),
    hit7Rate: percentage(
      matureSignalsForFinalHorizon.filter((item) => item.hit7pct === true).length,
      matureSignalsForFinalHorizon.filter((item) => typeof item.hit7pct === "boolean").length
    ),
    hitTargetsPct: normalizedConfig.hitTargetsPct,
    horizons: normalizedConfig.horizons,
    maxSignals: normalizedConfig.maxSignals || null,
    medianDaysToPeak: median(processedSignals.map((item) => item.daysToPeak).filter(isFiniteNumber)),
    notes,
    partialSignals: processedSignals.filter((item) => item.status === "partial").length,
    pendingCount: pendingItems.length,
    pendingDetails: pendingItems.map((item) => ({
      earliestNextHorizonDate: item.earliestNextHorizonDate,
      pendingReason: item.pendingReason,
      requiredThroughDate: item.requiredThroughDate,
      ticker: item.ticker
    })),
    pendingSignals: pendingItems.length,
    pendingTickers: pendingItems.map((item) => item.ticker),
    runId: normalizedConfig.runId,
    signalsFile: normalizedConfig.signalsFile,
    totalSignals: normalizedConfig.totalSignals,
    warningCount: entryWarnings.length,
    warnings: entryWarnings,
    winRate: percentage(
      matureSignalsForFinalHorizon.filter((item) => isFiniteNumber(item[lastReturnField]) && item[lastReturnField] > 0).length,
      matureSignalsForFinalHorizon.filter((item) => isFiniteNumber(item[lastReturnField])).length
    )
  };
}

function renderBreakdownTable(items) {
  if (!items.length) {
    return "_Sin muestra._";
  }

  const header = [
    "| bucket | count | winRate | hit7Rate | hit10Rate | hit15Rate | avg5d | avg10d | avg20d | avg30d | avgPeak | avgMaxDD | medianDaysToPeak |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  const rows = items.map((item) =>
    `| ${item.key} | ${item.signalsCount} | ${formatPercent(item.winRate)} | ${formatPercent(item.hit7Rate)} | ${formatPercent(item.hit10Rate)} | ${formatPercent(item.hit15Rate)} | ${formatPercent(item.avgReturn5d)} | ${formatPercent(item.avgReturn10d)} | ${formatPercent(item.avgReturn20d)} | ${formatPercent(item.avgReturn30d)} | ${formatPercent(item.avgPeakReturn)} | ${formatPercent(item.avgMaxDrawdown)} | ${item.medianDaysToPeak === null ? "n/d" : item.medianDaysToPeak} |`
  );

  return [...header, ...rows].join("\n");
}

function renderSummaryMarkdown(summary, errors) {
  const intro = summary.dataProvider === "local-csv"
    ? "_Backtest ex-ante usando CSV locales. Si los archivos contienen history real, las metricas si reflejan retornos medidos con precios reales._"
    : "_Infraestructura ex-ante con provider mock deterministico. No valida edge real._";

  return [
    `# Historical Signal Backtest MVP - ${summary.runId}`,
    "",
    intro,
    "",
    "## Run",
    `- runId: \`${summary.runId}\``,
    `- dryRun: \`${summary.dryRun}\``,
    `- dataProvider: \`${summary.dataProvider}\``,
    `- entryPricePolicy: \`${summary.entryPricePolicy}\``,
    `- allowNetwork: \`${summary.allowNetwork}\``,
    `- signalsFile: \`${summary.signalsFile}\``,
    `- totalSignals: ${summary.totalSignals}`,
    `- completedSignals: ${summary.completedSignals}`,
    `- partialSignals: ${summary.partialSignals}`,
    `- pendingSignals: ${summary.pendingSignals}`,
    `- errorCount: ${summary.errorCount}`,
    `- warningCount: ${summary.warningCount}`,
    "",
    "## Summary",
    `- winRate: ${formatPercent(summary.winRate)}`,
    `- hit7Rate: ${formatPercent(summary.hit7Rate)}`,
    `- hit10Rate: ${formatPercent(summary.hit10Rate)}`,
    `- hit15Rate: ${formatPercent(summary.hit15Rate)}`,
    `- avgReturn5d: ${formatPercent(summary.avgReturn5d)}`,
    `- avgReturn10d: ${formatPercent(summary.avgReturn10d)}`,
    `- avgReturn20d: ${formatPercent(summary.avgReturn20d)}`,
    `- avgReturn30d: ${formatPercent(summary.avgReturn30d)}`,
    `- avgPeakReturn: ${formatPercent(summary.avgPeakReturn)}`,
    `- avgMaxDrawdown: ${formatPercent(summary.avgMaxDrawdown)}`,
    `- medianDaysToPeak: ${summary.medianDaysToPeak === null ? "n/d" : summary.medianDaysToPeak}`,
    "",
    "## Completed By Horizon",
    ...Object.entries(summary.completedByHorizon).map(([horizon, count]) => `- ${horizon}d: ${count}`),
    "",
    "## Hit Rates By Horizon",
    ...Object.entries(summary.hitRatesByHorizon).map(
      ([horizon, metrics]) =>
        `- ${horizon}d: completed=${metrics.completedSignals} | hit7=${formatPercent(metrics.hit7Rate)} | hit10=${formatPercent(metrics.hit10Rate)} | hit15=${formatPercent(metrics.hit15Rate)}`
    ),
    "",
    "## Breakdown: assetType",
    renderBreakdownTable(summary.breakdown.assetType),
    "",
    "## Breakdown: playbookType",
    renderBreakdownTable(summary.breakdown.playbookType),
    "",
    "## Breakdown: setupRankAtEntry",
    renderBreakdownTable(summary.breakdown.setupRankAtEntry),
    "",
    "## Breakdown: catalystType",
    renderBreakdownTable(summary.breakdown.catalystType),
    "",
    "## Notes",
    ...summary.notes.map((note) => `- ${note}`),
    "",
    "## Warnings",
    ...(summary.warnings.length
      ? summary.warnings.map((warning) => `- ${warning.ticker} | ${warning.entryPricePolicy} | ${warning.entryPriceWarning}`)
      : ["- Sin warnings."]),
    "",
    "## Pending",
    ...(summary.pendingDetails.length
      ? summary.pendingDetails.map((item) => `- ${item.ticker} | earliestNextHorizonDate=${item.earliestNextHorizonDate || "n/d"} | ${item.pendingReason}`)
      : ["- Sin pending."]),
    "",
    "## Errors",
    ...(errors.length
      ? errors.map((error) => `- index ${error.index} | ${error.ticker || "n/d"} | ${error.message}`)
      : ["- Sin errores."])
  ].join("\n");
}

function loadCheckpoint(checkpointPath, normalizedConfig) {
  if (!fs.existsSync(checkpointPath)) {
    throw new Error(`No existe checkpoint para resume: ${checkpointPath}`);
  }

  const checkpoint = readJsonFile(checkpointPath);

  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error("checkpoint.json invalido.");
  }

  if (checkpoint.runId !== normalizedConfig.runId) {
    throw new Error(`checkpoint.json pertenece a otro runId: ${checkpoint.runId}`);
  }

  if (
    checkpoint.startedAt !== undefined &&
    !isValidTimestampString(checkpoint.startedAt)
  ) {
    throw new Error("checkpoint.startedAt no es ISO valido.");
  }

  if (
    checkpoint.updatedAt !== undefined &&
    !isValidTimestampString(checkpoint.updatedAt)
  ) {
    throw new Error("checkpoint.updatedAt no es ISO valido.");
  }

  if (
    checkpoint.lastProcessedIndex !== undefined &&
    checkpoint.lastProcessedIndex !== null &&
    checkpoint.lastProcessedIndex !== -1 &&
    !Number.isInteger(checkpoint.lastProcessedIndex)
  ) {
    throw new Error("checkpoint.lastProcessedIndex debe ser entero.");
  }

  if (!Array.isArray(checkpoint.processedSignals)) {
    throw new Error("checkpoint.processedSignals debe ser un array.");
  }

  if (!Array.isArray(checkpoint.errors)) {
    throw new Error("checkpoint.errors debe ser un array.");
  }

  return checkpoint;
}

function writeCheckpoint(checkpointPath, payload) {
  writeJsonAtomic(checkpointPath, payload);
}

function createCheckpointPayload(options) {
  const {
    runId,
    startedAt,
    updatedAt,
    lastProcessedIndex,
    processedSignals,
    errors
  } = options;

  return {
    errors,
    lastProcessedIndex,
    processedSignals,
    runId,
    startedAt,
    updatedAt
  };
}

function selectSignals(allSignals, normalizedConfig) {
  if (isPositiveInteger(normalizedConfig.maxSignals)) {
    return allSignals.slice(0, normalizedConfig.maxSignals);
  }

  return allSignals;
}

function processSignal(signal, normalizedConfig) {
  if (normalizedConfig.allowNetwork !== false) {
    throw new Error("allowNetwork=true no esta permitido en este MVP.");
  }

  if (normalizedConfig.dataProvider === "local-csv") {
    const priceSeries = buildLocalCsvSeries(signal, normalizedConfig);
    const metrics = computeSignalMetrics(signal, priceSeries, normalizedConfig);

    return {
      ...metrics,
      priceSource: priceSeries.priceSource,
      provider: "local-csv"
    };
  }

  if (normalizedConfig.dataProvider !== "mock") {
    throw new Error(`dataProvider no soportado: ${normalizedConfig.dataProvider}`);
  }

  const maxHorizon = Math.max(...normalizedConfig.horizons, ...FIXED_HORIZONS);
  const priceSeries = buildMockSeries(signal, maxHorizon);
  const entryResolution = resolveEntryFromRows(signal, priceSeries.rows, normalizedConfig);
  const metrics = computeSignalMetrics(
    signal,
    {
      entryDate: entryResolution.entryDate,
      entryPrice: entryResolution.entryPrice,
      entryPriceSource: entryResolution.entryPriceSource,
      entryPriceWarning: entryResolution.entryPriceWarning,
      evaluationPoints: buildEvaluationSeries(priceSeries.rows, entryResolution).points
    },
    normalizedConfig
  );

  return {
    ...metrics,
    mockSeed: priceSeries.mockSeed,
    provider: "mock"
  };
}

function writeOutputs(runPaths, payload) {
  writeJsonAtomic(runPaths.signalsPath, payload.signalsJson);
  writeJsonAtomic(runPaths.summaryJsonPath, payload.summaryJson);
  writeFileAtomic(runPaths.summaryMarkdownPath, payload.summaryMarkdown);
  writeCheckpoint(runPaths.checkpointPath, payload.checkpoint);
}

function buildPriceCoverageSummary(items, normalizedConfig, allSignalsCount) {
  const groups = {
    insufficient_data: [],
    invalid_csv: [],
    missing_csv: [],
    partial: [],
    ready: []
  };

  items.forEach((item) => {
    groups[item.status].push(item.ticker);
  });

  return {
    allSignalsCount,
    entryPricePolicy: normalizedConfig.entryPricePolicy,
    horizons: normalizedConfig.horizons,
    invalidCsvCount: groups.invalid_csv.length,
    invalidCsvTickers: groups.invalid_csv,
    insufficientDataCount: groups.insufficient_data.length,
    insufficientDataTickers: groups.insufficient_data,
    missingCsvCount: groups.missing_csv.length,
    missingCsvTickers: groups.missing_csv,
    partialCount: groups.partial.length,
    partialTickers: groups.partial,
    readyCount: groups.ready.length,
    readyTickers: groups.ready,
    runId: normalizedConfig.runId,
    selectedSignalsCount: items.length,
    totalSignals: items.length
  };
}

function renderPriceCoverageConsole(report) {
  const summary = report.summary;
  const lines = [
    `# Price Coverage Check - ${summary.runId}`,
    "",
    `- signalsFile: ${report.signalsFile}`,
    `- historicalPricesDir: ${report.historicalPricesDir}`,
    `- entryPricePolicy: ${summary.entryPricePolicy}`,
    `- horizons: ${summary.horizons.join(", ")}`,
    `- selectedSignals: ${summary.selectedSignalsCount}/${summary.allSignalsCount}`,
    "- required range uses weekdays approximation: 10 ruedas habiles antes y 45 despues de signalDate.",
    "",
    "## Status summary",
    `- ready: ${summary.readyCount} | ${summary.readyTickers.length ? summary.readyTickers.join(", ") : "none"}`,
    `- partial: ${summary.partialCount} | ${summary.partialTickers.length ? summary.partialTickers.join(", ") : "none"}`,
    `- missing_csv: ${summary.missingCsvCount} | ${summary.missingCsvTickers.length ? summary.missingCsvTickers.join(", ") : "none"}`,
    `- invalid_csv: ${summary.invalidCsvCount} | ${summary.invalidCsvTickers.length ? summary.invalidCsvTickers.join(", ") : "none"}`,
    `- insufficient_data: ${summary.insufficientDataCount} | ${summary.insufficientDataTickers.length ? summary.insufficientDataTickers.join(", ") : "none"}`,
    "",
    "## Signals"
  ];

  report.signals.forEach((item) => {
    lines.push(
      `- ${item.ticker} | ${item.status} | signalDate ${item.signalDate} | policy ${item.entryPricePolicy} | csv ${item.csvExists ? "yes" : "no"} | columns ${item.columnsValid ? "yes" : "no"} | first ${item.firstCsvDate || "n/d"} | last ${item.lastCsvDate || "n/d"} | required ${item.requiredStartDate}..${item.requiredEndDate} | hasEntryDate ${item.hasEntryDate ? "yes" : "no"} | completed ${formatIntegerList(item.completedHorizons)} | missing ${formatIntegerList(item.missingHorizons)}`
    );

    if (item.validationMessage) {
      lines.push(`  note: ${item.validationMessage}`);
    }
  });

  return lines.join("\n");
}

function runPriceCoverage(configPathInput) {
  const configPath = resolveConfigPath(configPathInput);
  const config = readJsonFile(configPath);

  validateConfig(config);

  const normalizedConfig = normalizeConfig(config, configPath);

  if (normalizedConfig.dataProvider !== "local-csv") {
    throw new Error("price-coverage solo soporta configs con dataProvider=local-csv.");
  }

  const runPaths = buildRunPaths(normalizedConfig);
  const allSignals = loadSignals(normalizedConfig.signalsPath);
  const selectedSignals = selectSignals(allSignals, normalizedConfig);
  const signals = selectedSignals.map((signal) => buildPriceCoverageItem(signal, normalizedConfig));
  const summary = buildPriceCoverageSummary(signals, normalizedConfig, allSignals.length);
  const generatedAt = new Date().toISOString();
  const payload = {
    dataProvider: normalizedConfig.dataProvider,
    entryPricePolicy: normalizedConfig.entryPricePolicy,
    generatedAt,
    historicalPricesDir: normalizedConfig.historicalPricesDir,
    horizons: normalizedConfig.horizons,
    runId: normalizedConfig.runId,
    signals,
    signalsFile: normalizedConfig.signalsFile,
    summary
  };

  fs.mkdirSync(runPaths.runDir, { recursive: true });
  writeJsonAtomic(runPaths.priceCoveragePath, payload);

  return {
    consoleReport: renderPriceCoverageConsole(payload),
    coveragePath: runPaths.priceCoveragePath,
    runDir: runPaths.runDir,
    signals,
    summary
  };
}

function runHistoricalBacktest(configPathInput) {
  const configPath = resolveConfigPath(configPathInput);
  const config = readJsonFile(configPath);

  validateConfig(config);

  const normalizedConfig = normalizeConfig(config, configPath);
  const runPaths = buildRunPaths(normalizedConfig);
  const allSignals = loadSignals(normalizedConfig.signalsPath);
  const selectedSignals = selectSignals(allSignals, normalizedConfig);
  const now = new Date().toISOString();
  let startedAt = now;
  let lastProcessedIndex = -1;
  let processedSignals = [];
  let errors = [];

  normalizedConfig.totalSignals = selectedSignals.length;
  fs.mkdirSync(runPaths.runDir, { recursive: true });

  if (normalizedConfig.resumeFromCheckpoint) {
    const checkpoint = loadCheckpoint(runPaths.checkpointPath, normalizedConfig);
    startedAt = checkpoint.startedAt || now;
    lastProcessedIndex = Number.isInteger(checkpoint.lastProcessedIndex)
      ? checkpoint.lastProcessedIndex
      : -1;
    processedSignals = checkpoint.processedSignals || [];
    errors = checkpoint.errors || [];
  }

  for (let index = lastProcessedIndex + 1; index < selectedSignals.length; index += 1) {
    const signal = selectedSignals[index];

    try {
      processedSignals.push(processSignal(signal, normalizedConfig));
    } catch (error) {
      errors.push({
        index,
        incompleteReason: error.message,
        message: error.message,
        missingHorizons: normalizedConfig.horizons,
        signalDate: signal && signal.signalDate ? signal.signalDate : null,
        status: "error",
        ticker: signal && signal.ticker ? signal.ticker : null
      });
    }

    lastProcessedIndex = index;

    if ((index + 1) % normalizedConfig.checkpointEvery === 0) {
      writeCheckpoint(
        runPaths.checkpointPath,
        createCheckpointPayload({
          errors,
          lastProcessedIndex,
          processedSignals,
          runId: normalizedConfig.runId,
          startedAt,
          updatedAt: new Date().toISOString()
        })
      );
    }
  }

  const summary = buildSummary(normalizedConfig, processedSignals, errors);
  const checkpoint = createCheckpointPayload({
    errors,
    lastProcessedIndex,
    processedSignals,
    runId: normalizedConfig.runId,
    startedAt,
    updatedAt: new Date().toISOString()
  });
  const signalsJson = {
    dataProvider: normalizedConfig.dataProvider,
    dryRun: normalizedConfig.dryRun,
    entryPricePolicy: normalizedConfig.entryPricePolicy,
    errors,
    generatedAt: checkpoint.updatedAt,
    runId: normalizedConfig.runId,
    signals: processedSignals
  };
  const summaryJson = {
    ...summary,
    generatedAt: checkpoint.updatedAt,
    runDir: runPaths.runDir
  };
  const summaryMarkdown = renderSummaryMarkdown(summaryJson, errors);

  writeOutputs(runPaths, {
    checkpoint,
    signalsJson,
    summaryJson,
    summaryMarkdown
  });

  return {
    checkpoint,
    runDir: runPaths.runDir,
    signalsPath: runPaths.signalsPath,
    summary,
    summaryJsonPath: runPaths.summaryJsonPath,
    summaryMarkdownPath: runPaths.summaryMarkdownPath
  };
}

module.exports = {
  runHistoricalBacktest,
  runPriceCoverage
};
