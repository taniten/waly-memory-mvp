"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, DATA_DIR } = require("./storage");
const {
  isFiniteNumber,
  isNonEmptyString,
  isValidDateOnlyString,
  normalizeTicker
} = require("./validators");

const REQUIRED_PRICE_COLUMNS = ["date", "open", "high", "low", "close", "volume"];
const DEFAULT_PRICE_FILE_PATTERN = "{ticker}.csv";
const DEFAULT_OUTPUT_DIR = path.join(BACKTESTS_DIR, "portfolio-backtest");
const ROOT_DIR = path.resolve(__dirname, "..");
const VALID_TRADE_STATUSES = new Set(["closed", "partial", "pending", "skipped"]);

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

function resolveInputPath(inputPath, basePath) {
  const candidates = [
    path.resolve(path.dirname(basePath), inputPath),
    path.resolve(ROOT_DIR, inputPath),
    path.resolve(process.cwd(), inputPath)
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error(`No existe ${inputPath}.`);
  }

  return found;
}

function normalizePositiveNumber(value, fallback, fieldName) {
  const candidate = value === undefined ? fallback : value;

  if (!isFiniteNumber(candidate) || candidate <= 0) {
    throw new Error(`${fieldName} debe ser un numero mayor a 0.`);
  }

  return candidate;
}

function normalizePercent(value, fallback, fieldName) {
  const candidate = value === undefined ? fallback : value;

  if (!isFiniteNumber(candidate) || candidate < 0) {
    throw new Error(`${fieldName} debe ser un porcentaje >= 0.`);
  }

  return candidate;
}

function normalizeConfig(config, configPath) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("La config de portfolio-backtest debe ser un objeto JSON.");
  }

  if (!isNonEmptyString(config.signalsConfig)) {
    throw new Error("signalsConfig es obligatorio.");
  }

  if (!isNonEmptyString(config.dataProvider) || config.dataProvider !== "local-csv") {
    throw new Error("portfolio-backtest MVP solo soporta dataProvider=local-csv.");
  }

  if (!config.defaultPositionPctByRank || typeof config.defaultPositionPctByRank !== "object") {
    throw new Error("defaultPositionPctByRank es obligatorio.");
  }

  const outputDir = ensureBacktestsPath(
    config.outputDir
      ? path.resolve(path.isAbsolute(config.outputDir) ? config.outputDir : path.join(ROOT_DIR, config.outputDir))
      : DEFAULT_OUTPUT_DIR
  );

  return {
    initialCapital: normalizePositiveNumber(config.initialCapital, 3000, "initialCapital"),
    maxPositionPct: normalizePercent(config.maxPositionPct, 35, "maxPositionPct"),
    maxBiotechPct: normalizePercent(config.maxBiotechPct, 70, "maxBiotechPct"),
    maxSpeculativePct: normalizePercent(config.maxSpeculativePct, 75, "maxSpeculativePct"),
    defaultPositionPctByRank: config.defaultPositionPctByRank,
    exitHorizonDays: normalizePositiveNumber(config.exitHorizonDays, 20, "exitHorizonDays"),
    stopLossPct: normalizePercent(Math.abs(config.stopLossPct ?? -15), 15, "stopLossPct") * -1,
    takeProfitPct: normalizePositiveNumber(config.takeProfitPct, 30, "takeProfitPct"),
    dataProvider: config.dataProvider,
    signalsConfig: config.signalsConfig,
    signalsConfigPath: resolveInputPath(config.signalsConfig, configPath),
    outputDir
  };
}

function parseCsvLine(line) {
  return line.split(",").map((value) => value.trim());
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

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  REQUIRED_PRICE_COLUMNS.forEach((column) => {
    if (!headers.includes(column)) {
      throw new Error(`Falta columna ${column} en ${filePath}.`);
    }
  });

  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);

    if (values.length !== headers.length) {
      throw new Error(`Fila CSV invalida en ${filePath} linea ${index + 2}.`);
    }

    const row = Object.fromEntries(headers.map((header, valueIndex) => [header, values[valueIndex]]));
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

    ["open", "high", "low", "close", "volume"].forEach((field) => {
      if (!isFiniteNumber(parsed[field])) {
        throw new Error(`Numero invalido en ${filePath} linea ${index + 2} campo ${field}.`);
      }
    });

    return parsed;
  });

  return rows.sort((left, right) => left.date.localeCompare(right.date));
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

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundPercent(value) {
  return Number(value.toFixed(1));
}

function average(values) {
  const measured = values.filter(isFiniteNumber);

  if (!measured.length) {
    return null;
  }

  return roundPercent(measured.reduce((sum, value) => sum + value, 0) / measured.length);
}

function percentage(part, total) {
  if (!total) {
    return null;
  }

  return roundPercent((part / total) * 100);
}

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatMoney(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function getSizingKey(signal) {
  const quality = String(signal.signalQuality || "").toLowerCase();
  const status = String(signal.status || "").toLowerCase();
  const rank = String(signal.setupRankAtEntry || "").toLowerCase();

  if (rank === "descartar" || quality === "discard" || quality === "descartar" || status.includes("discard")) {
    return "discard";
  }

  if (quality === "manual-candidate") {
    return "manual-candidate";
  }

  if (quality === "watch") {
    return "watch";
  }

  return signal.setupRankAtEntry || "watch";
}

function getConfiguredPositionPct(signal, config) {
  const key = getSizingKey(signal);
  const direct = config.defaultPositionPctByRank[key];
  const upper = config.defaultPositionPctByRank[String(key).toUpperCase()];
  const fallback = config.defaultPositionPctByRank.watch;

  return {
    sizingKey: key,
    positionPct: isFiniteNumber(direct)
      ? direct
      : isFiniteNumber(upper)
        ? upper
        : isFiniteNumber(fallback)
          ? fallback
          : 0
  };
}

function isNoTradeSignal(signal) {
  const status = String(signal.status || "").toLowerCase();
  const quality = String(signal.signalQuality || "").toLowerCase();
  const notes = String(signal.notes || "").toLowerCase();

  return (
    status.includes("no-trade") ||
    status.includes("discard") ||
    status.includes("descartar") ||
    quality === "discard" ||
    quality === "descartar" ||
    notes.includes("no-trade")
  );
}

function isBiotechSignal(signal) {
  const fields = [
    signal.catalystType,
    signal.catalystSubtype,
    signal.notes,
    signal.inclusionReason,
    signal.exclusionRisk
  ].map((value) => String(value || "").toLowerCase());

  return fields.some((value) =>
    value.includes("fda") ||
    value.includes("pdufa") ||
    value.includes("phase3") ||
    value.includes("phase 3") ||
    value.includes("biotech")
  );
}

function isSpeculativeSignal(signal) {
  return signal.assetType === "equity" && signal.playbookType === "event-swing";
}

function resolvePriceFilePath(signal, signalsConfig) {
  const pattern = signalsConfig.priceFilePattern || DEFAULT_PRICE_FILE_PATTERN;
  const relativeFile = pattern.replaceAll("{ticker}", signal.ticker);
  return path.join(signalsConfig.historicalPricesDir, relativeFile);
}

function resolveNextOpen(signal, rows) {
  const entryIndex = rows.findIndex((row) => row.date > signal.signalDate);
  const latestAvailablePriceDate = rows.length ? rows[rows.length - 1].date : null;

  if (entryIndex === -1) {
    return {
      entry: null,
      earliestEntryDate: addBusinessDays(signal.signalDate, 1),
      latestAvailablePriceDate,
      pendingReason: `waiting-for-entry-date: entryPricePolicy next-open requiere una rueda posterior a ${signal.signalDate}. Latest available: ${latestAvailablePriceDate || "n/d"}.`
    };
  }

  return {
    entry: {
      entryDate: rows[entryIndex].date,
      entryIndex,
      entryPrice: rows[entryIndex].open
    },
    earliestEntryDate: rows[entryIndex].date,
    latestAvailablePriceDate,
    pendingReason: null
  };
}

function closeExpiredActiveTrades(activeTrades, entryDate) {
  return activeTrades.filter((trade) => !trade.exitDate || trade.exitDate > entryDate);
}

function sumActivePct(activeTrades, selector) {
  return activeTrades
    .filter(selector)
    .reduce((sum, trade) => sum + trade.positionPct, 0);
}

function determineAllowedPct(signal, basePct, config, activeTrades) {
  const cappedByPosition = Math.min(basePct, config.maxPositionPct);
  const biotech = isBiotechSignal(signal);
  const speculative = isSpeculativeSignal(signal);
  let allowedPct = cappedByPosition;
  const blockers = [];

  if (basePct > config.maxPositionPct) {
    blockers.push(`position cap ${config.maxPositionPct}%`);
  }

  if (biotech) {
    const currentBiotechPct = sumActivePct(activeTrades, (trade) => trade.isBiotech);
    const room = Math.max(0, config.maxBiotechPct - currentBiotechPct);
    allowedPct = Math.min(allowedPct, room);

    if (room <= 0) {
      blockers.push(`maxBiotechPct ${config.maxBiotechPct}% sin espacio`);
    } else if (room < cappedByPosition) {
      blockers.push(`reducido por maxBiotechPct ${config.maxBiotechPct}%`);
    }
  }

  if (speculative) {
    const currentSpeculativePct = sumActivePct(activeTrades, (trade) => trade.isSpeculative);
    const room = Math.max(0, config.maxSpeculativePct - currentSpeculativePct);
    allowedPct = Math.min(allowedPct, room);

    if (room <= 0) {
      blockers.push(`maxSpeculativePct ${config.maxSpeculativePct}% sin espacio`);
    } else if (room < cappedByPosition) {
      blockers.push(`reducido por maxSpeculativePct ${config.maxSpeculativePct}%`);
    }
  }

  return {
    allowedPct: roundPercent(allowedPct),
    blockers,
    isBiotech: biotech,
    isSpeculative: speculative
  };
}

function evaluateExit(rows, entryResolution, config) {
  const entryPrice = entryResolution.entryPrice;
  const stopPrice = entryPrice * (1 + (config.stopLossPct / 100));
  const takeProfitPrice = entryPrice * (1 + (config.takeProfitPct / 100));
  const maxIndex = Math.min(rows.length - 1, entryResolution.entryIndex + config.exitHorizonDays);
  const windowRows = rows.slice(entryResolution.entryIndex, maxIndex + 1);
  let exitReason = null;
  let exitRow = null;
  let exitPrice = null;

  for (const row of windowRows) {
    if (row.low <= stopPrice) {
      exitReason = "stop-loss";
      exitRow = row;
      exitPrice = stopPrice;
      break;
    }

    if (row.high >= takeProfitPrice) {
      exitReason = "take-profit";
      exitRow = row;
      exitPrice = takeProfitPrice;
      break;
    }
  }

  if (!exitRow && rows[entryResolution.entryIndex + config.exitHorizonDays]) {
    exitReason = "exit-horizon";
    exitRow = rows[entryResolution.entryIndex + config.exitHorizonDays];
    exitPrice = exitRow.close;
  }

  if (!exitRow) {
    exitReason = "latest-available";
    exitRow = rows[rows.length - 1];
    exitPrice = exitRow.close;
  }

  const measuredRows = rows.slice(entryResolution.entryIndex, rows.indexOf(exitRow) + 1);
  const peakReturnPct = measuredRows.length
    ? Math.max(...measuredRows.map((row) => ((row.high - entryPrice) / entryPrice) * 100))
    : null;
  const maxDrawdownPct = measuredRows.length
    ? Math.min(0, Math.min(...measuredRows.map((row) => ((row.low - entryPrice) / entryPrice) * 100)))
    : null;

  return {
    exitDate: exitRow.date,
    exitPrice,
    exitReason,
    maxDrawdownPct: isFiniteNumber(maxDrawdownPct) ? roundPercent(maxDrawdownPct) : null,
    peakReturnPct: isFiniteNumber(peakReturnPct) ? roundPercent(peakReturnPct) : null,
    status: exitReason === "latest-available" ? "partial" : "closed"
  };
}

function buildSkippedTrade(signal, reason, extra = {}) {
  return {
    ...extra,
    allocationUsd: 0,
    entryDate: null,
    entryPrice: null,
    exitDate: null,
    exitPrice: null,
    exitReason: null,
    maxDrawdownPct: null,
    peakReturnPct: null,
    pnlUsd: 0,
    returnPct: null,
    shares: 0,
    signalDate: signal.signalDate,
    sizingKey: extra.sizingKey || getSizingKey(signal),
    skipReason: reason,
    status: "skipped",
    ticker: signal.ticker
  };
}

function buildPendingTrade(signal, pendingReason, extra = {}) {
  return {
    ...extra,
    allocationUsd: 0,
    entryDate: null,
    entryPrice: null,
    exitDate: null,
    exitPrice: null,
    exitReason: null,
    maxDrawdownPct: null,
    peakReturnPct: null,
    pendingReason,
    pnlUsd: 0,
    returnPct: null,
    shares: 0,
    signalDate: signal.signalDate,
    status: "pending",
    ticker: signal.ticker
  };
}

function simulateSignal(signal, context) {
  const { activeTrades, config, signalsConfig } = context;
  const normalizedSignal = {
    ...signal,
    assetType: signal.assetType || "equity",
    playbookType: signal.playbookType || "event-swing",
    ticker: normalizeTicker(signal.ticker)
  };
  const { positionPct: configuredPct, sizingKey } = getConfiguredPositionPct(normalizedSignal, config);
  const priceFilePath = resolvePriceFilePath(normalizedSignal, signalsConfig);
  let rows;

  try {
    rows = loadLocalCsvRows(priceFilePath);
  } catch (error) {
    return buildSkippedTrade(normalizedSignal, error.message, {
      configuredPositionPct: configuredPct,
      priceFilePath,
      sizingKey
    });
  }

  const entryResolution = resolveNextOpen(normalizedSignal, rows);

  if (!entryResolution.entry) {
    return buildPendingTrade(normalizedSignal, entryResolution.pendingReason, {
      configuredPositionPct: configuredPct,
      earliestEntryDate: entryResolution.earliestEntryDate,
      latestAvailablePriceDate: entryResolution.latestAvailablePriceDate,
      priceFilePath,
      sizingKey
    });
  }

  if (isNoTradeSignal(normalizedSignal)) {
    return buildSkippedTrade(normalizedSignal, "signal status is discard/no-trade", {
      configuredPositionPct: configuredPct,
      priceFilePath,
      sizingKey
    });
  }

  if (configuredPct <= 0) {
    return buildSkippedTrade(normalizedSignal, "sizing is 0", {
      configuredPositionPct: configuredPct,
      priceFilePath,
      sizingKey
    });
  }

  const activeAtEntry = closeExpiredActiveTrades(activeTrades, entryResolution.entry.entryDate);
  activeTrades.splice(0, activeTrades.length, ...activeAtEntry);
  const risk = determineAllowedPct(normalizedSignal, configuredPct, config, activeTrades);

  if (risk.allowedPct <= 0) {
    return buildSkippedTrade(normalizedSignal, risk.blockers.join(" | ") || "risk limit blocks entry", {
      configuredPositionPct: configuredPct,
      isBiotech: risk.isBiotech,
      isSpeculative: risk.isSpeculative,
      priceFilePath,
      sizingKey
    });
  }

  const exit = evaluateExit(rows, entryResolution.entry, config);
  const positionPct = risk.allowedPct;
  const allocationUsd = roundMoney(config.initialCapital * (positionPct / 100));
  const shares = allocationUsd / entryResolution.entry.entryPrice;
  const returnPct = roundPercent(((exit.exitPrice - entryResolution.entry.entryPrice) / entryResolution.entry.entryPrice) * 100);
  const pnlUsd = roundMoney(allocationUsd * (returnPct / 100));
  const trade = {
    allocationUsd,
    configuredPositionPct: configuredPct,
    entryDate: entryResolution.entry.entryDate,
    entryPrice: roundMoney(entryResolution.entry.entryPrice),
    exitDate: exit.exitDate,
    exitPrice: roundMoney(exit.exitPrice),
    exitReason: exit.exitReason,
    isBiotech: risk.isBiotech,
    isSpeculative: risk.isSpeculative,
    maxDrawdownPct: exit.maxDrawdownPct,
    peakReturnPct: exit.peakReturnPct,
    pnlUsd,
    positionPct,
    priceFilePath,
    returnPct,
    riskNotes: risk.blockers,
    shares: Number(shares.toFixed(4)),
    signalDate: normalizedSignal.signalDate,
    signalQuality: normalizedSignal.signalQuality || null,
    sizingKey,
    sourceKind: normalizedSignal.sourceKind || null,
    status: exit.status,
    ticker: normalizedSignal.ticker
  };

  activeTrades.push({
    exitDate: trade.exitDate,
    isBiotech: trade.isBiotech,
    isSpeculative: trade.isSpeculative,
    positionPct: trade.positionPct,
    ticker: trade.ticker
  });

  return trade;
}

function buildSummary(config, trades, state) {
  const measuredTrades = trades.filter((trade) => trade.status === "closed" || trade.status === "partial");
  const closedTrades = trades.filter((trade) => trade.status === "closed");
  const partialTrades = trades.filter((trade) => trade.status === "partial");
  const pendingTrades = trades.filter((trade) => trade.status === "pending");
  const skippedTrades = trades.filter((trade) => trade.status === "skipped");
  const winners = measuredTrades.filter((trade) => trade.pnlUsd > 0);
  const losers = measuredTrades.filter((trade) => trade.pnlUsd < 0);
  const totalPnlUsd = roundMoney(measuredTrades.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const finalCapital = roundMoney(config.initialCapital + totalPnlUsd);
  const maxDrawdownPct = measuredTrades.length
    ? Math.min(...measuredTrades.map((trade) => trade.maxDrawdownPct).filter(isFiniteNumber))
    : null;
  const bestTrades = [...measuredTrades]
    .sort((left, right) => right.pnlUsd - left.pnlUsd)
    .slice(0, 5);
  const worstTrades = [...measuredTrades]
    .sort((left, right) => left.pnlUsd - right.pnlUsd)
    .slice(0, 5);
  const currentPositions = ((state.positions && state.positions.positions) || []).map((position) => ({
    avgPrice: position.avgPrice,
    lastPrice: position.lastPrice,
    quantity: position.quantity,
    status: position.status,
    ticker: position.ticker
  }));

  return {
    avgLossPct: average(losers.map((trade) => trade.returnPct)),
    avgWinPct: average(winners.map((trade) => trade.returnPct)),
    bestTrades,
    closedTrades: closedTrades.length,
    currentPositions,
    finalCapital,
    initialCapital: config.initialCapital,
    maxDrawdownPct: isFiniteNumber(maxDrawdownPct) ? roundPercent(maxDrawdownPct) : null,
    measuredTrades: measuredTrades.length,
    openPortfolioCapitalEstimate:
      state.settings &&
      state.settings.portfolio &&
      state.settings.portfolio.totalCapitalEstimate,
    partialTrades: partialTrades.length,
    pendingTrades: pendingTrades.length,
    pnlUsd: totalPnlUsd,
    returnPct: roundPercent((totalPnlUsd / config.initialCapital) * 100),
    skippedTrades: skippedTrades.length,
    totalTrades: trades.length,
    winRate: percentage(winners.length, measuredTrades.length),
    worstTrades
  };
}

function renderTradeLine(trade) {
  if (trade.status === "pending") {
    return `- ${trade.ticker}: pending | ${trade.pendingReason}`;
  }

  if (trade.status === "skipped") {
    return `- ${trade.ticker}: skipped | ${trade.skipReason}`;
  }

  return `- ${trade.ticker}: ${trade.status} | ${trade.entryDate} ${trade.entryPrice} -> ${trade.exitDate} ${trade.exitPrice} | ${formatPercent(trade.returnPct)} | PnL ${formatMoney(trade.pnlUsd)} | ${trade.exitReason}`;
}

function renderSummaryMarkdown(summary, trades, config) {
  const closed = trades.filter((trade) => trade.status === "closed");
  const partial = trades.filter((trade) => trade.status === "partial");
  const pending = trades.filter((trade) => trade.status === "pending");
  const skipped = trades.filter((trade) => trade.status === "skipped");
  const rulesWorking = [];
  const rulesToAdjust = [];

  if (summary.winRate !== null && summary.winRate >= 50) {
    rulesWorking.push("Sizing chico por rank mantiene P&L positivo en la muestra observable.");
  }

  if (summary.bestTrades.some((trade) => ["IPX", "AXSM", "U"].includes(trade.ticker))) {
    rulesWorking.push("Event-swing historico sigue concentrando los mejores trades medidos.");
  }

  if (pending.length) {
    rulesToAdjust.push("Las senales recientes necesitan mas ruedas antes de medir edge real.");
  }

  if (skipped.length) {
    rulesToAdjust.push("Watch/no-trade y descartadas deben permanecer separadas de compras simuladas.");
  }

  if (summary.maxDrawdownPct !== null && summary.maxDrawdownPct <= config.stopLossPct) {
    rulesToAdjust.push("Stop loss debe revisarse: al menos un trade toco el umbral configurado.");
  }

  return [
    "# WALY Portfolio Backtest MVP",
    "",
    "## Summary",
    `- capital inicial: ${formatMoney(summary.initialCapital)}`,
    `- capital final simulado: ${formatMoney(summary.finalCapital)}`,
    `- P&L total: ${formatMoney(summary.pnlUsd)}`,
    `- return total: ${formatPercent(summary.returnPct)}`,
    `- trades cerrados: ${summary.closedTrades}`,
    `- partial trades: ${summary.partialTrades}`,
    `- pending trades: ${summary.pendingTrades}`,
    `- skipped trades: ${summary.skippedTrades}`,
    `- win rate: ${formatPercent(summary.winRate)}`,
    `- avg win: ${formatPercent(summary.avgWinPct)}`,
    `- avg loss: ${formatPercent(summary.avgLossPct)}`,
    `- max drawdown aproximado: ${formatPercent(summary.maxDrawdownPct)}`,
    "",
    "## Posiciones Abiertas Actuales",
    ...(summary.currentPositions.length
      ? summary.currentPositions.map((position) =>
          `- ${position.ticker}: ${position.quantity} acciones | avg ${position.avgPrice} | last ${position.lastPrice || "n/d"} | ${position.status}`
        )
      : ["- Sin posiciones abiertas."]),
    "",
    "## Mejores Trades",
    ...(summary.bestTrades.length ? summary.bestTrades.map(renderTradeLine) : ["- n/d"]),
    "",
    "## Peores Trades",
    ...(summary.worstTrades.length ? summary.worstTrades.map(renderTradeLine) : ["- n/d"]),
    "",
    "## Trades Cerrados",
    ...(closed.length ? closed.map(renderTradeLine) : ["- none"]),
    "",
    "## Partial",
    ...(partial.length ? partial.map(renderTradeLine) : ["- none"]),
    "",
    "## Pending",
    ...(pending.length ? pending.map(renderTradeLine) : ["- none"]),
    "",
    "## Skipped",
    ...(skipped.length ? skipped.map(renderTradeLine) : ["- none"]),
    "",
    "## Reglas Que Parecen Funcionar",
    ...(rulesWorking.length ? rulesWorking.map((item) => `- ${item}`) : ["- Muestra todavia chica: no declarar edge definitivo."]),
    "",
    "## Reglas Que Deben Ajustarse",
    ...(rulesToAdjust.length ? rulesToAdjust.map((item) => `- ${item}`) : ["- Completar mas history antes de tocar reglas."]),
    "",
    "## Lectura WALY Brutal",
    "- El backtest de cartera todavia no prueba edge final: mide bien los ganadores historicos, pero la capa FDA/biotech nueva sigue mayormente pending.",
    "- Cartera primero: VKTX, VRDN y OCS existen como riesgo real y ninguna simulacion debe tapar esa concentracion.",
    "- VERA manual-candidate no debe convertirse en compra automatica; solo sirve como idea medible hasta tener trigger y rueda posterior."
  ].join("\n");
}

function loadState() {
  return {
    positions: readJsonFile(path.join(DATA_DIR, "positions.json")),
    settings: readJsonFile(path.join(DATA_DIR, "settings.json"))
  };
}

function loadSignalsConfig(config) {
  const raw = readJsonFile(config.signalsConfigPath);

  if (!raw || raw.dataProvider !== "local-csv") {
    throw new Error("signalsConfig debe usar dataProvider=local-csv.");
  }

  if (raw.allowNetwork !== false) {
    throw new Error("signalsConfig debe tener allowNetwork=false.");
  }

  if (!isNonEmptyString(raw.signalsFile)) {
    throw new Error("signalsConfig.signalsFile es obligatorio.");
  }

  if (!isNonEmptyString(raw.historicalPricesDir)) {
    throw new Error("signalsConfig.historicalPricesDir es obligatorio.");
  }

  return {
    ...raw,
    historicalPricesDir: resolveInputPath(raw.historicalPricesDir, config.signalsConfigPath),
    signalsPath: resolveInputPath(raw.signalsFile, config.signalsConfigPath)
  };
}

function loadSignals(signalsPath) {
  const raw = readJsonFile(signalsPath);

  if (!raw || !Array.isArray(raw.signals)) {
    throw new Error("historical signals debe contener un array signals.");
  }

  return raw.signals
    .map((signal) => ({
      ...signal,
      ticker: normalizeTicker(signal.ticker)
    }))
    .sort((left, right) => {
      const dateCompare = String(left.signalDate || "").localeCompare(String(right.signalDate || ""));

      if (dateCompare !== 0) {
        return dateCompare;
      }

      return left.ticker.localeCompare(right.ticker);
    });
}

function buildConsoleReport(summary, paths) {
  return [
    "WALY Portfolio Backtest MVP generado.",
    `Output dir: ${paths.outputDir}`,
    `Trades: ${summary.totalTrades}`,
    `Capital inicial: ${formatMoney(summary.initialCapital)}`,
    `Capital final simulado: ${formatMoney(summary.finalCapital)}`,
    `P&L total: ${formatMoney(summary.pnlUsd)} (${formatPercent(summary.returnPct)})`,
    `Closed: ${summary.closedTrades}`,
    `Partial: ${summary.partialTrades}`,
    `Pending: ${summary.pendingTrades}`,
    `Skipped: ${summary.skippedTrades}`,
    `Win rate: ${formatPercent(summary.winRate)}`,
    `Max drawdown aprox: ${formatPercent(summary.maxDrawdownPct)}`,
    `Trades JSON: ${paths.tradesPath}`,
    `Summary JSON: ${paths.summaryJsonPath}`,
    `Summary MD: ${paths.summaryMarkdownPath}`
  ].join("\n");
}

function buildTradesPayload(config, trades, generatedAt) {
  return {
    config: {
      dataProvider: config.dataProvider,
      exitHorizonDays: config.exitHorizonDays,
      initialCapital: config.initialCapital,
      maxBiotechPct: config.maxBiotechPct,
      maxPositionPct: config.maxPositionPct,
      maxSpeculativePct: config.maxSpeculativePct,
      signalsConfig: config.signalsConfig,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct
    },
    generatedAt,
    trades
  };
}

function simulatePortfolioBacktest(rawConfig, configPathInput) {
  const configPath = resolveConfigPath(configPathInput);
  const config = normalizeConfig(rawConfig, configPath);
  const state = loadState();
  const signalsConfig = loadSignalsConfig(config);
  const signals = loadSignals(signalsConfig.signalsPath);
  const activeTrades = [];
  const trades = signals.map((signal) =>
    simulateSignal(signal, {
      activeTrades,
      config,
      signalsConfig
    })
  );
  const invalidStatus = trades.find((trade) => !VALID_TRADE_STATUSES.has(trade.status));

  if (invalidStatus) {
    throw new Error(`Trade status invalido: ${invalidStatus.status}`);
  }

  const summary = buildSummary(config, trades, state);
  const outputDir = ensureBacktestsPath(config.outputDir);
  const paths = {
    outputDir,
    summaryJsonPath: path.join(outputDir, "summary.json"),
    summaryMarkdownPath: path.join(outputDir, "summary.md"),
    tradesPath: path.join(outputDir, "trades.json")
  };
  const generatedAt = new Date().toISOString();
  const summaryPayload = {
    ...summary,
    generatedAt,
    outputDir,
    signalsConfig: config.signalsConfig
  };

  return {
    config,
    paths,
    summary: summaryPayload,
    trades
  };
}

function runPortfolioBacktest(configPathInput) {
  const configPath = resolveConfigPath(configPathInput);
  const result = simulatePortfolioBacktest(readJsonFile(configPath), configPath);
  const { config, paths, summary, trades } = result;
  const tradesPayload = buildTradesPayload(config, trades, summary.generatedAt);
  const summaryMarkdown = renderSummaryMarkdown(summary, trades, config);

  writeJsonAtomic(paths.tradesPath, tradesPayload);
  writeJsonAtomic(paths.summaryJsonPath, summary);
  writeFileAtomic(paths.summaryMarkdownPath, `${summaryMarkdown}\n`);

  return {
    consoleReport: buildConsoleReport(summary, paths),
    paths,
    summary,
    trades
  };
}

module.exports = {
  runPortfolioBacktest,
  simulatePortfolioBacktest
};
