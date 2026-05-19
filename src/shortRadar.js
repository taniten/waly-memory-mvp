"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, readJson } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const HISTORICAL_PRICES_DIR = path.join(ROOT_DIR, "historical_prices");

const DEFAULT_CONFIG = {
  includeLocalCatalysts: true,
  maxCandidates: 3,
  maxTickers: 50,
  minDollarVolume: 10000000,
  minMarketCap: 250000000,
  minPrice: 2,
  minRelativeVolume: 1.0,
  outputDir: "backtests/short-radar",
  useLocalCsv: true,
  thresholds: {
    gapUpPct: 10,
    highSqueezeRiskShortInterestPct: 20,
    overextended20dPct: 40,
    overextended5dPct: 20
  },
  candidates: [],
  universeSeeds: []
};

const CLASSIFICATION_ORDER = {
  "direct-short-candidate": 4,
  "put-spread-candidate": 3,
  "short-watch": 2,
  "no-short": 1,
  discard: 0
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
    maxCandidates: Math.min(Math.max(Number(input.maxCandidates) || DEFAULT_CONFIG.maxCandidates, 0), 3),
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
    throw new Error("outputDir debe estar dentro de backtests/ para mantener short-scan read-only.");
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

function normalizeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeLower(value) {
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

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
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
      isFiniteNumber(row.open) &&
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
  const previous = rows[rows.length - 2];
  const fiveDayAgo = rows.length > 5 ? rows[rows.length - 6] : null;
  const twentyDayAgo = rows.length > 20 ? rows[rows.length - 21] : null;
  const recentRows = rows.slice(-20);
  const high52w = Math.max(...rows.slice(-252).map((row) => row.high));
  const recentHigh = Math.max(...recentRows.map((row) => row.high));
  const avgVolume20 = recentRows.reduce((sum, row) => sum + row.volume, 0) / recentRows.length;
  const relativeVolume = avgVolume20 > 0 ? latest.volume / avgVolume20 : null;

  return {
    csvStatus: csv.status,
    marketData: {
      distanceFrom52wHighPct: high52w ? round(pctChange(latest.close, high52w)) : null,
      distanceFromRecentHighPct: recentHigh ? round(pctChange(latest.close, recentHigh)) : null,
      dollarVolume: round(latest.close * latest.volume),
      fiftyTwoWeekHigh: isFiniteNumber(high52w) ? round(high52w) : null,
      fiveDayReturnPct: fiveDayAgo ? round(pctChange(latest.close, fiveDayAgo.close)) : null,
      gapUpPct: previous ? round(pctChange(latest.open, previous.close)) : null,
      lastDataDate: latest.date,
      oneDayReturnPct: previous ? round(pctChange(latest.close, previous.close)) : null,
      price: round(latest.close),
      recentHigh: isFiniteNumber(recentHigh) ? round(recentHigh) : null,
      relativeVolume: round(relativeVolume),
      source: "local-csv",
      twentyDayReturnPct: twentyDayAgo ? round(pctChange(latest.close, twentyDayAgo.close)) : null,
      volume: latest.volume
    }
  };
}

function mergeMarketData(localMarketData, explicitMarketData, topLevel) {
  const source = {
    ...(localMarketData || {}),
    ...(explicitMarketData || {}),
    price: coerceNumber((explicitMarketData && explicitMarketData.price) ?? topLevel.lastPrice ?? topLevel.price) ??
      (localMarketData && localMarketData.price),
    oneDayReturnPct: coerceNumber((explicitMarketData && explicitMarketData.oneDayReturnPct) ?? topLevel.oneDayReturnPct) ??
      (localMarketData && localMarketData.oneDayReturnPct),
    fiveDayReturnPct: coerceNumber((explicitMarketData && explicitMarketData.fiveDayReturnPct) ?? topLevel.fiveDayReturnPct) ??
      (localMarketData && localMarketData.fiveDayReturnPct),
    twentyDayReturnPct: coerceNumber((explicitMarketData && explicitMarketData.twentyDayReturnPct) ?? topLevel.twentyDayReturnPct) ??
      (localMarketData && localMarketData.twentyDayReturnPct),
    gapUpPct: coerceNumber((explicitMarketData && explicitMarketData.gapUpPct) ?? topLevel.gapUpPct) ??
      (localMarketData && localMarketData.gapUpPct),
    distanceFrom52wHighPct: coerceNumber((explicitMarketData && explicitMarketData.distanceFrom52wHighPct) ?? topLevel.distanceFrom52wHighPct) ??
      (localMarketData && localMarketData.distanceFrom52wHighPct),
    distanceFromRecentHighPct: coerceNumber((explicitMarketData && explicitMarketData.distanceFromRecentHighPct) ?? topLevel.distanceFromRecentHighPct) ??
      (localMarketData && localMarketData.distanceFromRecentHighPct),
    relativeVolume: coerceNumber((explicitMarketData && explicitMarketData.relativeVolume) ?? topLevel.relativeVolume) ??
      (localMarketData && localMarketData.relativeVolume),
    dollarVolume: coerceNumber((explicitMarketData && explicitMarketData.dollarVolume) ?? topLevel.dollarVolume) ??
      (localMarketData && localMarketData.dollarVolume),
    marketCap: coerceNumber((explicitMarketData && explicitMarketData.marketCap) ?? topLevel.marketCap) ??
      (localMarketData && localMarketData.marketCap)
  };

  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
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
    notes: raw.notes || raw.catalyst || raw.description || "",
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
  const currentDate = getCurrentDateInTimezone(settings.timezone);

  return {
    currentDate,
    earnings,
    fda,
    positions,
    settings,
    watchlist
  };
}

function buildLocalCatalystMap(localContext) {
  const catalystsByTicker = new Map();

  (localContext.earnings.catalysts || []).forEach((item) => addCatalyst(catalystsByTicker, item, "earnings.json"));
  (localContext.fda.catalysts || []).forEach((item) => addCatalyst(catalystsByTicker, item, "fda.json"));
  (localContext.positions.positions || []).forEach((item) => {
    if (item.catalystType || item.catalystDate || item.catalyst) {
      addCatalyst(catalystsByTicker, item, "positions");
    }
  });
  (localContext.watchlist.watchlist || []).forEach((item) => {
    if (item.catalystType || item.catalystDate || item.catalyst) {
      addCatalyst(catalystsByTicker, item, "watchlist");
    }
  });

  return catalystsByTicker;
}

function isCatalystNear(catalyst, currentDate) {
  if (!catalyst.catalystDate) {
    return false;
  }

  const delta = daysBetween(currentDate, catalyst.catalystDate);
  return delta !== null && delta >= -10 && delta <= 45;
}

function isBearishCatalyst(catalyst) {
  const text = [
    catalyst.catalystType,
    catalyst.notes,
    catalyst.source
  ].join(" ").toLowerCase();

  return (
    text.includes("shelf") ||
    text.includes("atm") ||
    text.includes("dilution") ||
    text.includes("dilucion") ||
    text.includes("crl") ||
    text.includes("guidance cut") ||
    text.includes("miss") ||
    text.includes("offering")
  );
}

function extractCatalysts(candidateInput, localCatalystsByTicker, currentDate, config) {
  const ticker = normalizeTicker(candidateInput.ticker);
  const catalystMap = new Map();

  (Array.isArray(candidateInput.catalysts) ? candidateInput.catalysts : []).forEach((catalyst) => {
    const normalized = normalizeCatalyst({ ...catalyst, ticker }, "config");

    if (normalized) {
      catalystMap.set(`${normalized.catalystType || ""}|${normalized.catalystDate || ""}|config`, normalized);
    }
  });

  if (candidateInput.shelfOrAtm || candidateInput.dilutionRisk || candidateInput.guidanceRisk) {
    const localRisk = normalizeCatalyst(
      {
        catalystDate: candidateInput.catalystDate || currentDate,
        catalystType: "local-risk",
        notes: [
          candidateInput.shelfOrAtm ? "shelf/ATM/dilution risk" : "",
          candidateInput.dilutionRisk ? "dilution risk" : "",
          candidateInput.guidanceRisk ? "guidance risk" : ""
        ].filter(Boolean).join("; "),
        ticker
      },
      "config"
    );

    if (localRisk) {
      catalystMap.set(`local-risk|${localRisk.catalystDate || ""}|config`, localRisk);
    }
  }

  if (config.includeLocalCatalysts) {
    (localCatalystsByTicker.get(ticker) || []).forEach((catalyst) => {
      catalystMap.set(`${catalyst.catalystType || ""}|${catalyst.catalystDate || ""}|${catalyst.sourceTag || ""}`, catalyst);
    });
  }

  const catalysts = [...catalystMap.values()];
  const nearbyCatalysts = catalysts.filter((catalyst) => isCatalystNear(catalyst, currentDate));
  const bearishCatalysts = nearbyCatalysts.filter(isBearishCatalyst);
  const positiveOrUnknownCatalysts = nearbyCatalysts.filter((catalyst) => !isBearishCatalyst(catalyst));

  return {
    bearishCatalysts,
    catalysts,
    nearbyCatalysts,
    positiveOrUnknownCatalysts
  };
}

function evaluateOverextension(marketData, thresholds) {
  const signals = [];

  if (isFiniteNumber(marketData.oneDayReturnPct) && marketData.oneDayReturnPct >= thresholds.gapUpPct) {
    signals.push(`1d +${round(marketData.oneDayReturnPct)}%`);
  }

  if (isFiniteNumber(marketData.fiveDayReturnPct) && marketData.fiveDayReturnPct >= thresholds.overextended5dPct) {
    signals.push(`5d +${round(marketData.fiveDayReturnPct)}%`);
  }

  if (isFiniteNumber(marketData.twentyDayReturnPct) && marketData.twentyDayReturnPct >= thresholds.overextended20dPct) {
    signals.push(`20d +${round(marketData.twentyDayReturnPct)}%`);
  }

  if (isFiniteNumber(marketData.gapUpPct) && marketData.gapUpPct >= thresholds.gapUpPct) {
    signals.push(`gap up +${round(marketData.gapUpPct)}%`);
  }

  if (isFiniteNumber(marketData.distanceFrom52wHighPct) && marketData.distanceFrom52wHighPct >= -5) {
    signals.push("cerca de 52w high");
  }

  if (isFiniteNumber(marketData.distanceFromRecentHighPct) && marketData.distanceFromRecentHighPct >= -3) {
    signals.push("cerca de rango alto reciente");
  }

  if (isFiniteNumber(marketData.relativeVolume) && marketData.relativeVolume >= 1.5) {
    signals.push(`relvol ${round(marketData.relativeVolume)}`);
  }

  return {
    isOverextended: signals.length > 0,
    signals
  };
}

function evaluateLiquidity(marketData, config) {
  const hardRejectReasons = [];
  const warnings = [];

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
    hardRejectReasons.push("Sin volumen relativo; no se puede validar operabilidad.");
  } else if (marketData.relativeVolume < config.minRelativeVolume) {
    hardRejectReasons.push(`Volumen relativo insuficiente (${round(marketData.relativeVolume)} < ${config.minRelativeVolume}).`);
  }

  if (!isFiniteNumber(marketData.marketCap)) {
    hardRejectReasons.push("Sin market cap; no se valida riesgo de microcap.");
  } else if (marketData.marketCap < config.minMarketCap) {
    hardRejectReasons.push(`Market cap bajo minimo (${round(marketData.marketCap)} < ${config.minMarketCap}).`);
  }

  return {
    hardRejectReasons,
    warnings
  };
}

function evaluateSqueezeRisk(candidateInput, marketData, config) {
  const reasons = [];
  let score = 0;

  const shortInterestPct = coerceNumber(candidateInput.shortInterestPct || (candidateInput.shortData && candidateInput.shortData.shortInterestPct));
  const floatShares = coerceNumber(candidateInput.floatShares || (candidateInput.shortData && candidateInput.shortData.floatShares));
  const borrowFeePct = coerceNumber(candidateInput.borrowFeePct || (candidateInput.shortData && candidateInput.shortData.borrowFeePct));
  const socialVolumeScore = coerceNumber(candidateInput.socialVolumeScore || (candidateInput.social && candidateInput.social.volumeScore));

  if (isFiniteNumber(shortInterestPct) && shortInterestPct >= config.thresholds.highSqueezeRiskShortInterestPct) {
    score += 2;
    reasons.push(`short interest alto ${round(shortInterestPct)}%`);
  }

  if (isFiniteNumber(floatShares) && floatShares > 0 && floatShares < 50000000) {
    score += 1;
    reasons.push("float chico");
  }

  if (candidateInput.hardToBorrow === true || (isFiniteNumber(borrowFeePct) && borrowFeePct >= 10)) {
    score += 2;
    reasons.push(candidateInput.hardToBorrow === true ? "hard to borrow" : `borrow caro ${round(borrowFeePct)}%`);
  }

  if (isFiniteNumber(socialVolumeScore) && socialVolumeScore >= 4) {
    score += 1;
    reasons.push("volumen social alto");
  }

  if (isFiniteNumber(marketData.fiveDayReturnPct) && marketData.fiveDayReturnPct >= config.thresholds.overextended5dPct) {
    score += 1;
    reasons.push("tendencia alcista fuerte 5d");
  }

  if (isFiniteNumber(marketData.twentyDayReturnPct) && marketData.twentyDayReturnPct >= config.thresholds.overextended20dPct) {
    score += 1;
    reasons.push("tendencia alcista fuerte 20d");
  }

  const label = score >= 3 ? "high" : score >= 1 ? "medium" : "low";

  return {
    label,
    reasons,
    score,
    shortInterestPct
  };
}

function hasBorrowData(candidateInput) {
  return Boolean(
    candidateInput.borrowData ||
      candidateInput.locateAvailable === true ||
      candidateInput.locateAvailable === false ||
      candidateInput.hardToBorrow === true ||
      candidateInput.hardToBorrow === false ||
      candidateInput.shortBorrowAvailable === true ||
      candidateInput.shortBorrowAvailable === false ||
      isFiniteNumber(coerceNumber(candidateInput.borrowFeePct))
  );
}

function scoreShortSetup(overextension, squeezeRisk, catalystRisk, marketData, optionsAvailable) {
  let score = 0;

  score += overextension.signals.length * 2;

  if (isFiniteNumber(marketData.relativeVolume) && marketData.relativeVolume >= 1.5) {
    score += 2;
  }

  if (catalystRisk.bearishCatalysts.length > 0) {
    score += 2;
  }

  if (optionsAvailable) {
    score += 1;
  }

  if (squeezeRisk.label === "high") {
    score -= 3;
  } else if (squeezeRisk.label === "medium") {
    score -= 1;
  }

  return round(Math.max(0, score));
}

function classifyCandidate({ candidateInput, catalystRisk, hardRejectReasons, localCsv, marketData, overextension, score, squeezeRisk }) {
  const optionsAvailable = candidateInput.optionsAvailable === true;
  const borrowKnown = hasBorrowData(candidateInput);
  const warnings = [];

  if (hardRejectReasons.length > 0) {
    return {
      allowedVehicle: "no-trade",
      classification: "discard",
      maxLossVehicle: "manual review required",
      warnings
    };
  }

  if (!overextension.isOverextended) {
    return {
      allowedVehicle: "no-trade",
      classification: "no-short",
      maxLossVehicle: "manual review required",
      warnings: ["No hay overextension suficiente para short setup."]
    };
  }

  if (localCsv.csvStatus !== "ok" && !candidateInput.marketData) {
    return {
      allowedVehicle: "manual-review",
      classification: "short-watch",
      maxLossVehicle: "manual review required",
      warnings: ["Datos locales incompletos; maximo short-watch."]
    };
  }

  if (catalystRisk.positiveOrUnknownCatalysts.length > 0) {
    warnings.push("Catalyst positivo o no-confirmado cercano bloquea direct-short.");
  }

  if (!borrowKnown) {
    warnings.push("Sin borrow/hardToBorrow data: direct-short bloqueado.");
  }

  if (squeezeRisk.label === "high") {
    warnings.push("Squeeze risk alto: direct-short bloqueado.");
  }

  if (optionsAvailable && score >= 4) {
    return {
      allowedVehicle: "put-spread",
      classification: "put-spread-candidate",
      maxLossVehicle: "defined-risk only",
      warnings
    };
  }

  if (
    borrowKnown &&
    squeezeRisk.label === "low" &&
    catalystRisk.positiveOrUnknownCatalysts.length === 0 &&
    score >= 5
  ) {
    return {
      allowedVehicle: "manual-review",
      classification: "direct-short-candidate",
      maxLossVehicle: "manual review required",
      warnings: [...warnings, "Direct-short requiere revision manual; no es vehiculo default."]
    };
  }

  const directShortBlocked = warnings.some((warning) => warning.includes("direct-short bloqueado"));

  return {
    allowedVehicle: optionsAvailable ? "put-spread" : "manual-review",
    classification: "short-watch",
    maxLossVehicle: directShortBlocked ? "direct-short blocked" : optionsAvailable ? "defined-risk only" : "manual review required",
    warnings
  };
}

function deriveBearishReason(candidateInput, overextension, catalystRisk) {
  const explicit = normalizeText(candidateInput.shortThesis || candidateInput.bearishReason || candidateInput.thesis);

  if (explicit) {
    return explicit;
  }

  const parts = [];

  if (overextension.signals.length > 0) {
    parts.push(`Overextension: ${overextension.signals.join(", ")}`);
  }

  if (catalystRisk.bearishCatalysts.length > 0) {
    parts.push("Catalyst bajista local documentado.");
  }

  return parts.length ? parts.join(" ") : "Sin razon bajista suficiente; no se inventa tesis.";
}

function deriveInvalidation(candidateInput, overextension) {
  const explicit = normalizeText(candidateInput.invalidation);

  if (explicit) {
    return explicit;
  }

  if (overextension.signals.length > 0) {
    return "Invalidar si rompe maximo reciente con volumen y mantiene momentum alcista.";
  }

  return "Invalidar si aparece catalyst positivo verificable o no hay confirmacion bajista local.";
}

function analyzeCandidate(candidateInput, config, localCatalystsByTicker, currentDate) {
  const ticker = normalizeTicker(candidateInput.ticker);
  const localCsv = config.useLocalCsv ? deriveLocalCsvMarketData(ticker) : { csvStatus: "disabled", marketData: null };
  const marketData = mergeMarketData(localCsv.marketData, candidateInput.marketData, candidateInput);
  const catalystRisk = extractCatalysts(candidateInput, localCatalystsByTicker, currentDate, config);
  const liquidity = evaluateLiquidity(marketData, config);
  const overextension = evaluateOverextension(marketData, config.thresholds);
  const squeezeRisk = evaluateSqueezeRisk(candidateInput, marketData, config);
  const hardRejectReasons = [...liquidity.hardRejectReasons];
  const warnings = [...liquidity.warnings];

  if (!ticker) {
    hardRejectReasons.push("Ticker invalido.");
  }

  if (!overextension.isOverextended && hardRejectReasons.length === 0) {
    warnings.push("Sin overextension suficiente.");
  }

  const score = scoreShortSetup(
    overextension,
    squeezeRisk,
    catalystRisk,
    marketData,
    candidateInput.optionsAvailable === true
  );
  const classified = classifyCandidate({
    candidateInput,
    catalystRisk,
    hardRejectReasons,
    localCsv,
    marketData,
    overextension,
    score,
    squeezeRisk
  });

  return {
    allowedVehicle: classified.allowedVehicle,
    bearishReason: deriveBearishReason(candidateInput, overextension, catalystRisk),
    catalystRisk: {
      bearishCatalysts: catalystRisk.bearishCatalysts,
      nearbyCatalysts: catalystRisk.nearbyCatalysts,
      positiveOrUnknownCatalysts: catalystRisk.positiveOrUnknownCatalysts
    },
    classification: classified.classification,
    direction: "short",
    hardRejectReasons,
    invalidation: deriveInvalidation(candidateInput, overextension),
    marketData,
    maxLossVehicle: classified.maxLossVehicle,
    optionsAvailable: candidateInput.optionsAvailable === true,
    overextension,
    score,
    shortInterestPct: squeezeRisk.shortInterestPct,
    sourceStatus: {
      localCsv: localCsv.csvStatus
    },
    squeezeRisk,
    ticker,
    warnings: [...warnings, ...classified.warnings]
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
    "# WALY Short Radar",
    "",
    `As of: ${currentDate}`,
    "Safety: no orders, no IBKR, no Binance, no positions writes, no outcomes writes.",
    "",
    "## Config",
    `- maxCandidates: ${config.maxCandidates}`,
    `- minDollarVolume: ${renderMoney(config.minDollarVolume)}`,
    `- minMarketCap: ${renderMoney(config.minMarketCap)}`,
    `- minRelativeVolume: ${config.minRelativeVolume}`,
    "",
    "## Candidatos finales 0-3"
  ];

  if (filteredCandidates.length === 0) {
    lines.push("- No hay short candidates en esta corrida.");
  } else {
    lines.push("| Ticker | Class | Score | Vehicle | Max loss | Squeeze | 5d | 20d | RelVol | Bearish reason | Invalidation |");
    lines.push("| --- | --- | ---: | --- | --- | --- | ---: | ---: | ---: | --- | --- |");
    filteredCandidates.forEach((candidate) => {
      const market = candidate.marketData || {};
      lines.push(
        `| ${candidate.ticker} | ${candidate.classification} | ${candidate.score} | ${candidate.allowedVehicle} | ${candidate.maxLossVehicle} | ${candidate.squeezeRisk.label} | ${renderPercent(market.fiveDayReturnPct)} | ${renderPercent(market.twentyDayReturnPct)} | ${market.relativeVolume || "n/d"} | ${candidate.bearishReason.replace(/\|/g, "/")} | ${candidate.invalidation.replace(/\|/g, "/")} |`
      );
    });
  }

  lines.push("");
  lines.push("## Descartes y bloqueos");
  analyzedCandidates.slice(0, 80).forEach((candidate) => {
    const reject = candidate.hardRejectReasons[0] || candidate.warnings[0] || "n/d";
    lines.push(
      `- ${candidate.ticker}: ${candidate.classification} | vehicle ${candidate.allowedVehicle} | squeeze ${candidate.squeezeRisk.label} | reject/block: ${reject}`
    );
  });

  lines.push("");
  lines.push("## Reglas de seguridad");
  lines.push("- Sin liquidez completa, se descarta.");
  lines.push("- Sin borrow/hardToBorrow data, direct-short queda bloqueado.");
  lines.push("- Squeeze risk alto bloquea direct-short.");
  lines.push("- Catalyst positivo cercano bloquea direct-short.");
  lines.push("- Sin optionsAvailable=true, no se propone put spread.");
  lines.push("- Short directo nunca es vehiculo automatico; requiere revision manual.");

  return `${lines.join("\n")}\n`;
}

function toConsoleReport(result) {
  const candidateLines =
    result.filteredCandidates.length === 0
      ? "- Ninguno."
      : result.filteredCandidates
        .map((candidate) => {
          const market = candidate.marketData || {};
          return `- ${candidate.ticker}: ${candidate.classification} | ${candidate.allowedVehicle} | score ${candidate.score} | squeeze ${candidate.squeezeRisk.label} | 5d ${renderPercent(market.fiveDayReturnPct)} | 20d ${renderPercent(market.twentyDayReturnPct)}`;
        })
        .join("\n");

  const discardLines = result.rawCandidates
    .filter((candidate) => candidate.classification === "discard" || candidate.classification === "no-short")
    .slice(0, 5)
    .map((candidate) => `- ${candidate.ticker}: ${candidate.hardRejectReasons[0] || candidate.warnings[0] || "sin bloqueo principal"}`)
    .join("\n") || "- Sin descartes.";

  return [
    "WALY Short Radar generado.",
    `Output dir: ${result.outputDir}`,
    `Raw candidates: ${result.rawCandidates.length}`,
    `Final candidates: ${result.filteredCandidates.length}`,
    "",
    "Candidatos finales:",
    candidateLines,
    "",
    "Descartes principales:",
    discardLines
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

function runShortScan(configPath) {
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
    .filter((candidate) => !["discard", "no-short"].includes(candidate.classification))
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
  runShortScan
};
