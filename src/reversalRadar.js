"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, readJson } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const DEFAULT_CONFIG = {
  catalystForwardDays: 90,
  catalystRecentDays: 14,
  includeLocalCatalysts: true,
  maxCandidates: 5,
  maxTickers: 50,
  minDollarVolume: 10000000,
  minMarketCap: 250000000,
  minPrice: 2,
  minRelativeVolume: 0.75,
  outputDir: "backtests/reversal-radar",
  requireReboundReason: true,
  useLocalCsv: true,
  thresholds: {
    strongDrop5dPct: -8,
    strongDrop20dPct: -15,
    minDistanceFrom52wHighPct: -25
  },
  universeSeeds: [],
  candidates: []
};

const HISTORICAL_PRICES_DIR = path.resolve(__dirname, "..", "historical_prices");
const CLASSIFICATION_ORDER = {
  "reversal candidate": 3,
  watchlist: 2,
  discard: 1
};

function readConfig(configPath) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return JSON.parse(raw);
}

function mergeConfig(input = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    maxCandidates: Math.min(Math.max(Number(input.maxCandidates) || DEFAULT_CONFIG.maxCandidates, 0), 5),
    maxTickers: Math.min(Math.max(Number(input.maxTickers) || DEFAULT_CONFIG.maxTickers, 0), 250),
    thresholds: {
      ...DEFAULT_CONFIG.thresholds,
      ...(input.thresholds || {})
    },
    candidates: Array.isArray(input.candidates) ? input.candidates : [],
    universeSeeds: Array.isArray(input.universeSeeds) ? input.universeSeeds : []
  };
}

function ensureOutputDir(outputDir) {
  const requested = path.resolve(process.cwd(), outputDir || DEFAULT_CONFIG.outputDir);
  const relativeToBacktests = path.relative(BACKTESTS_DIR, requested);

  if (relativeToBacktests.startsWith("..") || path.isAbsolute(relativeToBacktests)) {
    throw new Error("outputDir debe estar dentro de backtests/ para mantener reversal-scan read-only.");
  }

  fs.mkdirSync(requested, { recursive: true });
  return requested;
}

function writeJsonFile(directory, fileName, value) {
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writeTextFile(directory, fileName, value) {
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, value, "utf8");
  return filePath;
}

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  if (!isFiniteNumber(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function getCurrentDateInTimezone(timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric"
    });
    const parts = formatter.formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch (error) {
    return new Date().toISOString().slice(0, 10);
  }
}

function daysBetween(leftDate, rightDate) {
  const left = new Date(`${leftDate}T00:00:00.000Z`);
  const right = new Date(`${rightDate}T00:00:00.000Z`);

  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) {
    return null;
  }

  return Math.round((right.getTime() - left.getTime()) / 86400000);
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
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function readLocalCsvRows(ticker) {
  const filePath = path.join(HISTORICAL_PRICES_DIR, `${normalizeTicker(ticker)}.csv`);

  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      rows: [],
      status: "missing"
    };
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);

  if (lines.length < 2) {
    return {
      filePath,
      rows: [],
      status: "empty"
    };
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const columnIndex = Object.fromEntries(headers.map((header, index) => [header, index]));
  const required = ["date", "open", "high", "low", "close", "volume"];

  if (required.some((column) => columnIndex[column] === undefined)) {
    return {
      filePath,
      rows: [],
      status: "invalid-columns"
    };
  }

  const rows = lines
    .slice(1)
    .map((line) => parseCsvLine(line))
    .map((values) => ({
      close: Number(values[columnIndex.close]),
      date: values[columnIndex.date],
      high: Number(values[columnIndex.high]),
      low: Number(values[columnIndex.low]),
      open: Number(values[columnIndex.open]),
      volume: Number(values[columnIndex.volume])
    }))
    .filter((row) =>
      row.date &&
      isFiniteNumber(row.close) &&
      isFiniteNumber(row.high) &&
      isFiniteNumber(row.low) &&
      isFiniteNumber(row.volume)
    )
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));

  return {
    filePath,
    rows,
    status: rows.length ? "ok" : "empty"
  };
}

function pctChange(current, previous) {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous) || previous === 0) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function average(values) {
  const clean = values.filter(isFiniteNumber);

  if (clean.length === 0) {
    return null;
  }

  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function deriveLocalCsvMarketData(ticker) {
  const csv = readLocalCsvRows(ticker);

  if (csv.status !== "ok" || csv.rows.length < 2) {
    return {
      csvStatus: csv.status,
      marketData: null
    };
  }

  const rows = csv.rows;
  const latest = rows[rows.length - 1];
  const fiveDayAgo = rows.length >= 6 ? rows[rows.length - 6] : null;
  const twentyDayAgo = rows.length >= 21 ? rows[rows.length - 21] : null;
  const lookback52w = rows.slice(Math.max(0, rows.length - 252));
  const high52w = Math.max(...lookback52w.map((row) => row.high).filter(isFiniteNumber));
  const priorVolumes = rows.slice(Math.max(0, rows.length - 21), -1).map((row) => row.volume);
  const averageVolume20 = average(priorVolumes);
  const relativeVolume = averageVolume20 ? latest.volume / averageVolume20 : null;

  return {
    csvStatus: csv.status,
    marketData: {
      averageVolume20: averageVolume20 ? Math.round(averageVolume20) : null,
      distanceFrom52wHighPct: high52w ? round(pctChange(latest.close, high52w)) : null,
      dollarVolume: round(latest.close * latest.volume),
      fiftyTwoWeekHigh: isFiniteNumber(high52w) ? round(high52w) : null,
      fiveDayReturnPct: fiveDayAgo ? round(pctChange(latest.close, fiveDayAgo.close)) : null,
      lastDataDate: latest.date,
      price: round(latest.close),
      relativeVolume: round(relativeVolume),
      source: "local-csv",
      twentyDayReturnPct: twentyDayAgo ? round(pctChange(latest.close, twentyDayAgo.close)) : null,
      volume: latest.volume
    }
  };
}

function normalizeCandidateInput(input) {
  if (typeof input === "string") {
    return {
      ticker: normalizeTicker(input)
    };
  }

  if (!input || typeof input !== "object") {
    return {};
  }

  return {
    ...input,
    ticker: normalizeTicker(input.ticker)
  };
}

function collectCandidateInputs(config) {
  const map = new Map();

  config.universeSeeds.forEach((seed) => {
    const candidate = normalizeCandidateInput(seed);

    if (candidate.ticker && !map.has(candidate.ticker)) {
      map.set(candidate.ticker, candidate);
    }
  });

  config.candidates.forEach((input) => {
    const candidate = normalizeCandidateInput(input);

    if (!candidate.ticker) {
      return;
    }

    map.set(candidate.ticker, {
      ...(map.get(candidate.ticker) || {}),
      ...candidate,
      marketData: {
        ...((map.get(candidate.ticker) || {}).marketData || {}),
        ...(candidate.marketData || {})
      }
    });
  });

  return [...map.values()].slice(0, config.maxTickers);
}

function normalizeCatalyst(raw, sourceTag) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const ticker = normalizeTicker(raw.ticker);

  if (!ticker) {
    return null;
  }

  return {
    catalystDate: raw.catalystDate || raw.date || null,
    catalystType: raw.catalystType || raw.type || null,
    notes: raw.notes || raw.catalyst || "",
    source: raw.source || sourceTag || "",
    sourceTag: sourceTag || raw.sourceTag || "config",
    ticker
  };
}

function addCatalyst(catalystsByTicker, raw, sourceTag) {
  const catalyst = normalizeCatalyst(raw, sourceTag);

  if (!catalyst) {
    return;
  }

  const list = catalystsByTicker.get(catalyst.ticker) || [];
  const key = `${catalyst.catalystType || ""}|${catalyst.catalystDate || ""}|${catalyst.source || ""}`;

  if (!list.some((item) => `${item.catalystType || ""}|${item.catalystDate || ""}|${item.source || ""}` === key)) {
    list.push(catalyst);
  }

  catalystsByTicker.set(catalyst.ticker, list);
}

function loadLocalContext() {
  const settings = readJson("settings.json");
  const positions = readJson("positions.json");
  const watchlist = readJson("watchlist.json");
  const earnings = readJson("earnings.json");
  const fda = readJson("fda.json");
  const insiders = readJson("insiders.json");
  const currentDate = getCurrentDateInTimezone(settings.timezone);

  return {
    currentDate,
    earnings,
    fda,
    insiders,
    positions,
    settings,
    watchlist
  };
}

function buildLocalCatalystMap(localContext) {
  const catalystsByTicker = new Map();

  (localContext.earnings.catalysts || []).forEach((item) => addCatalyst(catalystsByTicker, item, "earnings.json"));
  (localContext.fda.catalysts || []).forEach((item) => addCatalyst(catalystsByTicker, item, "fda.json"));
  (localContext.insiders.catalysts || []).forEach((item) => addCatalyst(catalystsByTicker, item, "insiders.json"));
  (localContext.watchlist.watchlist || []).forEach((item) => {
    if (item.catalystType || item.catalystDate || item.catalyst) {
      addCatalyst(
        catalystsByTicker,
        {
          catalystDate: item.catalystDate,
          catalystType: item.catalystType,
          notes: item.catalyst,
          source: item.source,
          ticker: item.ticker
        },
        "watchlist"
      );
    }
  });

  return catalystsByTicker;
}

function isCatalystCurrent(catalyst, currentDate, config) {
  if (!catalyst.catalystDate) {
    return false;
  }

  const delta = daysBetween(currentDate, catalyst.catalystDate);

  if (delta === null) {
    return false;
  }

  return delta >= -config.catalystRecentDays && delta <= config.catalystForwardDays;
}

function hasReboundReason(candidate, currentCatalysts, config) {
  if (!config.requireReboundReason) {
    return true;
  }

  return Boolean(
    (candidate.reboundReason && String(candidate.reboundReason).trim()) ||
    currentCatalysts.length > 0 ||
    (candidate.reasonForRebound && String(candidate.reasonForRebound).trim())
  );
}

function mergeMarketData(localMarketData, explicitMarketData = {}, candidate = {}) {
  const topLevelMarketData = {
    distanceFrom52wHighPct: candidate.distanceFrom52wHighPct,
    dollarVolume: candidate.dollarVolume,
    fiftyTwoWeekHigh: candidate.fiftyTwoWeekHigh,
    fiveDayReturnPct: candidate.fiveDayReturnPct,
    marketCap: candidate.marketCap,
    price: candidate.price,
    relativeVolume: candidate.relativeVolume,
    twentyDayReturnPct: candidate.twentyDayReturnPct,
    volume: candidate.volume
  };
  const cleanTopLevel = Object.fromEntries(
    Object.entries(topLevelMarketData).filter(([, value]) => value !== undefined && value !== null)
  );

  return {
    ...(localMarketData || {}),
    ...(explicitMarketData || {}),
    ...cleanTopLevel
  };
}

function extractRiskProfile(candidate) {
  const fundamentals = candidate.fundamentals || {};
  const riskFlags = candidate.riskFlags || {};

  return {
    crlTerminal: riskFlags.crlTerminal === true || fundamentals.crlTerminal === true,
    debtRisk: Number(fundamentals.debtRisk ?? candidate.debtRisk ?? 0),
    dilutionExtreme: riskFlags.dilutionExtreme === true || fundamentals.dilutionExtreme === true,
    dilutionRisk: Number(fundamentals.dilutionRisk ?? candidate.dilutionRisk ?? 0),
    fraudRisk: riskFlags.fraud === true || fundamentals.fraud === true,
    hasDebtOrDilutionData:
      fundamentals.debtRisk !== undefined ||
      fundamentals.dilutionRisk !== undefined ||
      candidate.debtRisk !== undefined ||
      candidate.dilutionRisk !== undefined ||
      riskFlags.dilutionExtreme !== undefined,
    structuralRisk: Number(fundamentals.structuralRisk ?? candidate.structuralRisk ?? 0)
  };
}

function evaluateDrop(marketData, thresholds) {
  const dropSignals = [];

  if (
    isFiniteNumber(marketData.fiveDayReturnPct) &&
    marketData.fiveDayReturnPct <= thresholds.strongDrop5dPct
  ) {
    dropSignals.push(`5d ${round(marketData.fiveDayReturnPct)}%`);
  }

  if (
    isFiniteNumber(marketData.twentyDayReturnPct) &&
    marketData.twentyDayReturnPct <= thresholds.strongDrop20dPct
  ) {
    dropSignals.push(`20d ${round(marketData.twentyDayReturnPct)}%`);
  }

  if (
    isFiniteNumber(marketData.distanceFrom52wHighPct) &&
    marketData.distanceFrom52wHighPct <= thresholds.minDistanceFrom52wHighPct
  ) {
    dropSignals.push(`distancia 52w high ${round(marketData.distanceFrom52wHighPct)}%`);
  }

  return {
    dropSignals,
    hasStrongDrop: dropSignals.length > 0
  };
}

function scoreDrop(marketData) {
  const fiveDay = isFiniteNumber(marketData.fiveDayReturnPct)
    ? clamp(Math.abs(Math.min(marketData.fiveDayReturnPct, 0)) * 1.5, 0, 15)
    : 0;
  const twentyDay = isFiniteNumber(marketData.twentyDayReturnPct)
    ? clamp(Math.abs(Math.min(marketData.twentyDayReturnPct, 0)), 0, 20)
    : 0;
  const distance = isFiniteNumber(marketData.distanceFrom52wHighPct)
    ? clamp(Math.abs(Math.min(marketData.distanceFrom52wHighPct, 0)) / 3, 0, 15)
    : 0;

  return clamp(fiveDay + twentyDay + distance, 0, 30);
}

function scoreLiquidity(marketData, config) {
  let score = 0;

  if (isFiniteNumber(marketData.dollarVolume)) {
    if (marketData.dollarVolume >= config.minDollarVolume * 3) {
      score += 10;
    } else if (marketData.dollarVolume >= config.minDollarVolume) {
      score += 7;
    } else if (marketData.dollarVolume >= config.minDollarVolume / 2) {
      score += 3;
    }
  }

  if (isFiniteNumber(marketData.relativeVolume)) {
    if (marketData.relativeVolume >= 1.5) {
      score += 6;
    } else if (marketData.relativeVolume >= config.minRelativeVolume) {
      score += 4;
    } else if (marketData.relativeVolume >= 0.5) {
      score += 1;
    }
  }

  if (isFiniteNumber(marketData.marketCap)) {
    if (marketData.marketCap >= config.minMarketCap * 4) {
      score += 4;
    } else if (marketData.marketCap >= config.minMarketCap) {
      score += 2;
    }
  }

  return clamp(score, 0, 20);
}

function scoreCatalysts(currentCatalysts, candidate) {
  if (!currentCatalysts.length) {
    return 0;
  }

  const typeScores = {
    earnings: 10,
    fda: 16,
    insider: 12,
    "unusual-volume-gap": 8
  };
  const bestTypeScore = Math.max(
    ...currentCatalysts.map((catalyst) => typeScores[catalyst.catalystType] || 6)
  );
  const reasonBonus = candidate.reboundReason || candidate.reasonForRebound ? 4 : 0;

  return clamp(bestTypeScore + reasonBonus, 0, 20);
}

function scoreQuality(candidate, riskProfile) {
  let score = 15;

  if (candidate.downside || candidate.invalidation) {
    score += 4;
  }

  if (riskProfile.hasDebtOrDilutionData) {
    score += 2;
  }

  score -= clamp(riskProfile.debtRisk, 0, 5) * 2;
  score -= clamp(riskProfile.dilutionRisk, 0, 5) * 2;
  score -= clamp(riskProfile.structuralRisk, 0, 5) * 3;

  return clamp(score, 0, 25);
}

function deriveFallReason(candidate, marketData, dropSignals) {
  if (candidate.fallReason) {
    return candidate.fallReason;
  }

  if (candidate.reasonForDrop) {
    return candidate.reasonForDrop;
  }

  if (dropSignals.length > 0) {
    return `Caida tecnica detectada: ${dropSignals.join(", ")}.`;
  }

  return "Sin razon de caida documentada.";
}

function deriveReboundReason(candidate, currentCatalysts) {
  if (candidate.reboundReason) {
    return candidate.reboundReason;
  }

  if (candidate.reasonForRebound) {
    return candidate.reasonForRebound;
  }

  if (currentCatalysts.length > 0) {
    const catalyst = currentCatalysts[0];
    return `Catalyst vigente ${catalyst.catalystType || "n/d"} ${catalyst.catalystDate || "sin fecha"}: ${catalyst.notes || catalyst.source || "sin detalle"}.`;
  }

  return "Sin razon de rebote documentada.";
}

function deriveConfidence(score, hardRejectReasons, warnings) {
  if (hardRejectReasons.length > 0 || score < 45) {
    return "low";
  }

  if (score >= 70 && warnings.length <= 1) {
    return "high";
  }

  return "medium";
}

function classifyCandidate(score, hardRejectReasons, warnings, dropEvaluation, currentCatalysts) {
  if (hardRejectReasons.length > 0) {
    return "discard";
  }

  if (!dropEvaluation.hasStrongDrop) {
    return "discard";
  }

  if (score >= 70 && currentCatalysts.length > 0 && warnings.length <= 2) {
    return "reversal candidate";
  }

  if (score >= 45) {
    return "watchlist";
  }

  return "discard";
}

function analyzeCandidate(candidateInput, config, localCatalystsByTicker, currentDate) {
  const ticker = normalizeTicker(candidateInput.ticker);
  const explicitCatalysts = Array.isArray(candidateInput.catalysts) ? candidateInput.catalysts : [];
  const catalystMap = new Map();

  explicitCatalysts.forEach((catalyst) => {
    const normalized = normalizeCatalyst({ ...catalyst, ticker }, "config");

    if (normalized) {
      catalystMap.set(`${normalized.catalystType || ""}|${normalized.catalystDate || ""}|config`, normalized);
    }
  });

  if (config.includeLocalCatalysts) {
    (localCatalystsByTicker.get(ticker) || []).forEach((catalyst) => {
      catalystMap.set(`${catalyst.catalystType || ""}|${catalyst.catalystDate || ""}|${catalyst.sourceTag || ""}`, catalyst);
    });
  }

  const catalysts = [...catalystMap.values()];
  const currentCatalysts = catalysts.filter((catalyst) => isCatalystCurrent(catalyst, currentDate, config));
  const localCsv = config.useLocalCsv ? deriveLocalCsvMarketData(ticker) : { csvStatus: "disabled", marketData: null };
  const marketData = mergeMarketData(localCsv.marketData, candidateInput.marketData, candidateInput);
  const riskProfile = extractRiskProfile(candidateInput);
  const hardRejectReasons = [];
  const warnings = [];

  if (!ticker) {
    hardRejectReasons.push("Ticker invalido.");
  }

  if (!marketData || !isFiniteNumber(marketData.price)) {
    hardRejectReasons.push("Sin precio verificable; no se inventa data.");
  } else if (marketData.price < config.minPrice) {
    hardRejectReasons.push(`Precio bajo minimo (${marketData.price} < ${config.minPrice}).`);
  }

  if (!isFiniteNumber(marketData.dollarVolume)) {
    hardRejectReasons.push("Sin dollar volume; no se puede validar liquidez.");
  } else if (marketData.dollarVolume < config.minDollarVolume) {
    hardRejectReasons.push(`Dollar volume insuficiente (${round(marketData.dollarVolume)} < ${config.minDollarVolume}).`);
  }

  if (!isFiniteNumber(marketData.relativeVolume)) {
    hardRejectReasons.push("Sin volumen relativo; no se puede validar interes real.");
  } else if (marketData.relativeVolume < config.minRelativeVolume) {
    hardRejectReasons.push(`Volumen relativo insuficiente (${round(marketData.relativeVolume)} < ${config.minRelativeVolume}).`);
  }

  if (isFiniteNumber(marketData.marketCap) && marketData.marketCap < config.minMarketCap) {
    hardRejectReasons.push(`Microcap bajo el minimo (${round(marketData.marketCap)} < ${config.minMarketCap}).`);
  } else if (!isFiniteNumber(marketData.marketCap)) {
    warnings.push("Sin market cap; confianza limitada para descartar microcap.");
  }

  if (!currentCatalysts.length && !hasReboundReason(candidateInput, currentCatalysts, config)) {
    hardRejectReasons.push("Sin catalyst vigente ni razon documentada de rebote.");
  }

  if (riskProfile.fraudRisk) {
    hardRejectReasons.push("Caida asociada a fraude o riesgo equivalente.");
  }

  if (riskProfile.dilutionExtreme) {
    hardRejectReasons.push("Dilucion extrema documentada.");
  }

  if (riskProfile.crlTerminal) {
    hardRejectReasons.push("CRL terminal o tesis regulatoria rota.");
  }

  if (riskProfile.structuralRisk >= 4) {
    hardRejectReasons.push("La caida parece estructural, no exagerada.");
  } else if (riskProfile.structuralRisk >= 3) {
    warnings.push("Riesgo estructural moderado; no comprar solo por rebote tecnico.");
  }

  if (!riskProfile.hasDebtOrDilutionData) {
    warnings.push("Sin datos de deuda/dilucion; confianza limitada.");
  }

  const dropEvaluation = evaluateDrop(marketData, config.thresholds);

  if (!dropEvaluation.hasStrongDrop) {
    hardRejectReasons.push("No hay caida fuerte segun umbrales del reversal radar.");
  }

  const scoreBreakdown = {
    catalyst: scoreCatalysts(currentCatalysts, candidateInput),
    drop: scoreDrop(marketData),
    liquidity: scoreLiquidity(marketData, config),
    quality: scoreQuality(candidateInput, riskProfile)
  };
  const rawScore = round(Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0), 2);
  const classification = classifyCandidate(rawScore, hardRejectReasons, warnings, dropEvaluation, currentCatalysts);
  const confidence = deriveConfidence(rawScore, hardRejectReasons, warnings);

  return {
    catalysts,
    classification,
    confidence,
    currentCatalysts,
    downside: candidateInput.downside || "Downside no documentado; requiere definicion antes de operar.",
    fallReason: deriveFallReason(candidateInput, marketData, dropEvaluation.dropSignals),
    hardRejectReasons,
    invalidation: candidateInput.invalidation || "Invalidar si la tesis de rebote no aparece con volumen o si la caida acelera con nueva evidencia negativa.",
    marketData,
    possibleReboundReason: deriveReboundReason(candidateInput, currentCatalysts),
    riskProfile,
    score: rawScore,
    scoreBreakdown,
    sourceStatus: {
      localCsv: localCsv.csvStatus
    },
    ticker,
    warnings
  };
}

function renderMoney(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  if (Math.abs(value) >= 1e9) {
    return `$${round(value / 1e9, 2)}B`;
  }

  if (Math.abs(value) >= 1e6) {
    return `$${round(value / 1e6, 2)}M`;
  }

  return `$${round(value, 2)}`;
}

function renderPercent(value) {
  return isFiniteNumber(value) ? `${round(value, 2)}%` : "n/d";
}

function renderSummary({ analyzedCandidates, config, currentDate, filteredCandidates }) {
  const lines = [
    "# WALY Reversal Radar",
    "",
    `As of: ${currentDate}`,
    "Safety: no orders, no positions writes, no outcomes writes.",
    "",
    "## Config",
    `- maxCandidates: ${config.maxCandidates}`,
    `- minDollarVolume: ${renderMoney(config.minDollarVolume)}`,
    `- minMarketCap: ${renderMoney(config.minMarketCap)}`,
    `- minRelativeVolume: ${config.minRelativeVolume}`,
    "",
    "## Final Candidates"
  ];

  if (filteredCandidates.length === 0) {
    lines.push("- No hay reversal candidates en esta corrida.");
  } else {
    lines.push("| Ticker | Class | Score | Confidence | 5d | 20d | Dist 52w High | RelVol | DollarVol | Why rebound |");
    lines.push("| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |");
    filteredCandidates.forEach((candidate) => {
      const market = candidate.marketData || {};
      lines.push(
        `| ${candidate.ticker} | ${candidate.classification} | ${candidate.score} | ${candidate.confidence} | ${renderPercent(market.fiveDayReturnPct)} | ${renderPercent(market.twentyDayReturnPct)} | ${renderPercent(market.distanceFrom52wHighPct)} | ${market.relativeVolume || "n/d"} | ${renderMoney(market.dollarVolume)} | ${candidate.possibleReboundReason.replace(/\|/g, "/")} |`
      );
    });
  }

  lines.push("");
  lines.push("## Reviewed");
  analyzedCandidates.slice(0, 40).forEach((candidate) => {
    lines.push(
      `- ${candidate.ticker}: ${candidate.classification} | score ${candidate.score} | confidence ${candidate.confidence} | drop: ${candidate.fallReason} | reject: ${candidate.hardRejectReasons[0] || "n/d"}`
    );
  });

  lines.push("");
  lines.push("## Decision Rules");
  lines.push("- La caida sola no habilita A+ ni compra.");
  lines.push("- Sin liquidez, volumen, catalyst o razon documentada de rebote, se descarta.");
  lines.push("- Fraude, dilucion extrema o CRL terminal invalidan el reversal.");

  return `${lines.join("\n")}\n`;
}

function toConsoleReport(result) {
  const candidateLines =
    result.filteredCandidates.length === 0
      ? "- Ninguno."
      : result.filteredCandidates
        .map((candidate) => {
          const market = candidate.marketData || {};
          return `- ${candidate.ticker}: ${candidate.classification} | score ${candidate.score} | confidence ${candidate.confidence} | 5d ${renderPercent(market.fiveDayReturnPct)} | 20d ${renderPercent(market.twentyDayReturnPct)}`;
        })
        .join("\n");

  return [
    "WALY Reversal Radar generado.",
    `Output dir: ${result.outputDir}`,
    `Raw candidates: ${result.rawCandidates.length}`,
    `Final candidates: ${result.filteredCandidates.length}`,
    "",
    "Candidatos:",
    candidateLines
  ].join("\n");
}

function sortCandidates(left, right) {
  if (left.classification !== right.classification) {
    return CLASSIFICATION_ORDER[right.classification] - CLASSIFICATION_ORDER[left.classification];
  }

  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.ticker.localeCompare(right.ticker);
}

function buildSourceStatus(analyzedCandidates, config) {
  return {
    config: {
      candidates: config.candidates.length,
      universeSeeds: config.universeSeeds.length
    },
    localCsv: {
      disabled: config.useLocalCsv !== true,
      missing: analyzedCandidates.filter((candidate) => candidate.sourceStatus.localCsv === "missing").map((candidate) => candidate.ticker),
      ok: analyzedCandidates.filter((candidate) => candidate.sourceStatus.localCsv === "ok").map((candidate) => candidate.ticker)
    },
    localCatalysts: {
      disabled: config.includeLocalCatalysts !== true
    }
  };
}

function runReversalScan(configPath) {
  const inputConfig = readConfig(configPath);
  const config = mergeConfig(inputConfig);
  const localContext = loadLocalContext();
  const localCatalystsByTicker = buildLocalCatalystMap(localContext);
  const outputDir = ensureOutputDir(config.outputDir);
  const candidateInputs = collectCandidateInputs(config);
  const analyzedCandidates = candidateInputs
    .map((candidate) => analyzeCandidate(candidate, config, localCatalystsByTicker, localContext.currentDate))
    .sort(sortCandidates);
  const filteredCandidates = analyzedCandidates
    .filter((candidate) => candidate.classification !== "discard")
    .slice(0, config.maxCandidates);
  const summaryMarkdown = renderSummary({
    analyzedCandidates,
    config,
    currentDate: localContext.currentDate,
    filteredCandidates
  });
  const sourceStatus = buildSourceStatus(analyzedCandidates, config);
  const rawCandidatesPath = writeJsonFile(outputDir, "rawCandidates.json", analyzedCandidates);
  const filteredCandidatesPath = writeJsonFile(outputDir, "filteredCandidates.json", filteredCandidates);
  const sourceStatusPath = writeJsonFile(outputDir, "sourceStatus.json", sourceStatus);
  const summaryPath = writeTextFile(outputDir, "summary.md", summaryMarkdown);
  const result = {
    analyzedCandidates,
    config,
    filteredCandidates,
    outputDir,
    paths: {
      filteredCandidatesPath,
      rawCandidatesPath,
      sourceStatusPath,
      summaryPath
    },
    rawCandidates: analyzedCandidates,
    sourceStatus
  };

  return {
    ...result,
    consoleReport: toConsoleReport(result)
  };
}

module.exports = {
  runReversalScan
};
