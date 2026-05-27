"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, DATA_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "7-pillars");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const POSITIONS_PATH = path.join(DATA_DIR, "positions.json");
const WATCHLIST_PATH = path.join(DATA_DIR, "watchlist.json");
const DAILY_COCKPIT_PATH = path.join(BACKTESTS_DIR, "daily-cockpit", "latest.json");
const SOCIAL_RADAR_PATH = path.join(BACKTESTS_DIR, "social-radar", "latest.json");
const SELECTOR_ENGINE_PATH = path.join(BACKTESTS_DIR, "selector-engine", "latest.json");
const PARAMETER_SWEEP_PATH = path.join(BACKTESTS_DIR, "historical-research", "parameter-sweep.json");
const SIGNAL_TYPE_ANALYSIS_PATH = path.join(BACKTESTS_DIR, "historical-research", "signal-type-analysis.json");
const V32_RESULTS_PATH = path.join(
  BACKTESTS_DIR,
  "historical-research",
  "v3-2-signal-quality-backtest",
  "results.json"
);
const EXAMPLE_OUTCOMES_PATH = path.join(EXAMPLES_DIR, "outcomes.example.json");
const REAL_SIGNAL_LOG_PATH = path.join(OUTPUT_DIR, "real-signal-log.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${formatRelative(filePath)}: ${error.message}`);
    }

    throw error;
  }
}

function assertPillarOutput(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("7-pillars solo puede escribir dentro de backtests/7-pillars/.");
  }
}

function writePillarJson(fileName, value) {
  const filePath = path.join(OUTPUT_DIR, fileName);
  assertPillarOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writePillarText(fileName, value) {
  const filePath = path.join(OUTPUT_DIR, fileName);
  assertPillarOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
  return filePath;
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
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

  return Math.max(min, Math.min(max, value));
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

function firstText(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim().length > 0);
  return value ? value.trim() : "";
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
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

function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(dateText, currentDateText) {
  const date = parseDateOnly(dateText);
  const currentDate = parseDateOnly(currentDateText);

  if (!date || !currentDate) {
    return null;
  }

  return Math.round((date.getTime() - currentDate.getTime()) / 86400000);
}

function normalizeMarketData(raw) {
  const source = raw || {};
  const price = coerceNumber(firstValue(source.price, source.lastPrice));

  return {
    averageVolume20: coerceNumber(source.averageVolume20),
    dayChangePct: coerceNumber(source.dayChangePct),
    dayHigh: coerceNumber(source.dayHigh),
    dayLow: coerceNumber(source.dayLow),
    dollarVolume: coerceNumber(source.dollarVolume),
    lastDataDate: source.lastDataDate || source.timestamp || null,
    price,
    previousClose: coerceNumber(source.previousClose),
    relativeVolume: coerceNumber(source.relativeVolume),
    source: source.source || source.sourceTag || null,
    volume: coerceNumber(source.volume)
  };
}

function readCoreInputs() {
  const settings = readJson(SETTINGS_PATH);

  return {
    currentDate: getCurrentDateInTimezone(settings.timezone),
    dailyCockpit: readJsonIfExists(DAILY_COCKPIT_PATH),
    exampleOutcomes: readJsonIfExists(EXAMPLE_OUTCOMES_PATH),
    parameterSweep: readJsonIfExists(PARAMETER_SWEEP_PATH),
    positions: readJson(POSITIONS_PATH),
    selectorEngine: readJsonIfExists(SELECTOR_ENGINE_PATH),
    settings,
    signalTypeAnalysis: readJsonIfExists(SIGNAL_TYPE_ANALYSIS_PATH),
    socialRadar: readJsonIfExists(SOCIAL_RADAR_PATH),
    v32Results: readJsonIfExists(V32_RESULTS_PATH),
    watchlist: readJson(WATCHLIST_PATH)
  };
}

function indexByTicker(items) {
  const index = new Map();

  (items || []).forEach((item) => {
    const ticker = normalizeTicker(item && item.ticker);
    if (ticker && !index.has(ticker)) {
      index.set(ticker, item);
    }
  });

  return index;
}

function selectorIndex(selectorEngine) {
  return indexByTicker((selectorEngine && selectorEngine.ranking) || []);
}

function socialIndex(socialRadar) {
  const byTicker = new Map();

  ((socialRadar && socialRadar.mentions) || []).forEach((mention) => {
    const ticker = normalizeTicker(mention && mention.ticker);
    if (!ticker) {
      return;
    }

    const rows = byTicker.get(ticker) || [];
    rows.push(mention);
    byTicker.set(ticker, rows);
  });

  return byTicker;
}

function buildTickerUniverse(inputs) {
  const positions = indexByTicker((inputs.positions && inputs.positions.positions) || []);
  const watchlist = indexByTicker((inputs.watchlist && inputs.watchlist.watchlist) || []);
  const selector = selectorIndex(inputs.selectorEngine);
  const social = socialIndex(inputs.socialRadar);
  const dailyPortfolio = indexByTicker((inputs.dailyCockpit && inputs.dailyCockpit.portfolio) || []);
  const dailyWatchlist = indexByTicker((inputs.dailyCockpit && inputs.dailyCockpit.watchlist) || []);
  const tickers = new Set([
    ...positions.keys(),
    ...watchlist.keys(),
    ...selector.keys(),
    ...social.keys(),
    ...dailyPortfolio.keys(),
    ...dailyWatchlist.keys()
  ]);

  return [...tickers].sort().map((ticker) => {
    const position = positions.get(ticker) || null;
    const watch = watchlist.get(ticker) || null;
    const selectorRow = selector.get(ticker) || null;
    const dailyRow =
      (inputs.dailyCockpit && inputs.dailyCockpit.marketData && inputs.dailyCockpit.marketData[ticker]) ||
      dailyPortfolio.get(ticker) ||
      dailyWatchlist.get(ticker) ||
      null;
    const raw = position || watch || selectorRow || {};
    const marketData = normalizeMarketData(dailyRow || raw.marketData || selectorRow && selectorRow.marketData || {});

    return {
      dailyRow,
      inPortfolio: Boolean(position),
      inWatchlist: Boolean(watch),
      marketData,
      position,
      raw,
      selector: selectorRow,
      socialMentions: social.get(ticker) || [],
      ticker,
      watchlist: watch
    };
  });
}

function getItemText(item) {
  return [
    item.ticker,
    getMergedText(item, "status"),
    getMergedText(item, "setupRank"),
    getMergedText(item, "setupType"),
    getMergedText(item, "thesis"),
    getMergedText(item, "rationale"),
    getMergedText(item, "catalyst"),
    getMergedText(item, "notes"),
    getMergedText(item, "invalidation")
  ].join(" ");
}

function getMergedText(item, fieldName) {
  return firstText(
    item.position && item.position[fieldName],
    item.watchlist && item.watchlist[fieldName],
    item.selector && item.selector[fieldName],
    item.raw && item.raw[fieldName]
  );
}

function getMergedValue(item, fieldName) {
  return firstValue(
    item.position && item.position[fieldName],
    item.watchlist && item.watchlist[fieldName],
    item.selector && item.selector[fieldName],
    item.raw && item.raw[fieldName]
  );
}

function isBiotechCatalyst(item) {
  const text = getItemText(item).toLowerCase();
  return /biotech|biopharma|pharma|therapeutic|clinical|phase|pdufa|fda|drug|readout/.test(text);
}

function chooseSignalSource(item) {
  if (item.inPortfolio || item.dailyRow) {
    return "cockpit";
  }

  if (item.socialMentions.length > 0 && !item.inWatchlist) {
    return "social";
  }

  if (item.selector) {
    return "selector";
  }

  if (item.inWatchlist) {
    return "manual";
  }

  return "historical";
}

function signalStatus(item) {
  const status = getMergedText(item, "status").toLowerCase();
  const classification = item.selector ? String(item.selector.classification || "").toLowerCase() : "";

  if (status === "descartar" || classification === "discard") {
    return "invalid";
  }

  if (item.inPortfolio) {
    return "active";
  }

  return "pending";
}

function buildSignal(item) {
  const catalystDate = getMergedText(item, "catalystDate") ||
    (item.selector && item.selector.context && item.selector.context.catalystDate) ||
    null;
  const thesis = firstText(
    getMergedText(item, "thesis"),
    getMergedText(item, "rationale"),
    item.selector && item.selector.mainReason,
    item.socialMentions[0] && item.socialMentions[0].thesis
  );
  const detectedAt = firstText(
    getMergedText(item, "lastReviewedAt"),
    getMergedText(item, "executedAt"),
    item.marketData.lastDataDate,
    item.socialMentions[0] && item.socialMentions[0].date
  ) || null;

  return {
    catalystDate,
    catalystType: firstText(
      getMergedText(item, "catalystType"),
      item.selector && item.selector.context && item.selector.context.catalystKind,
      item.socialMentions[0] && item.socialMentions[0].catalyst ? "social-only" : ""
    ) || null,
    detectedAt,
    initialPrice: firstValue(item.marketData.price, getMergedValue(item, "lastPrice"), item.socialMentions[0] && item.socialMentions[0].initialPrice) || null,
    maxDrawdown: null,
    result7d: null,
    result30d: null,
    result60d: null,
    result90d: null,
    selectorScore: item.selector ? item.selector.totalScore : null,
    signalId: `${item.ticker}-${chooseSignalSource(item)}-${detectedAt || "no-date"}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
    source: chooseSignalSource(item),
    status: signalStatus(item),
    thesis: thesis || "missingData: thesis",
    ticker: item.ticker,
    verdict: signalStatus(item) === "invalid" ? "invalid" : "pending"
  };
}

function buildPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const signals = buildTickerUniverse(inputs).map(buildSignal);
  const payload = {
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No toca data/social_signals.json.",
      "No toca outcomes reales.",
      "Salida research-only en backtests/7-pillars/."
    ],
    generatedAt: new Date().toISOString(),
    inputs: {
      dailyCockpit: inputs.dailyCockpit ? formatRelative(DAILY_COCKPIT_PATH) : null,
      positions: formatRelative(POSITIONS_PATH),
      selectorEngine: inputs.selectorEngine ? formatRelative(SELECTOR_ENGINE_PATH) : null,
      socialRadar: inputs.socialRadar ? formatRelative(SOCIAL_RADAR_PATH) : null,
      watchlist: formatRelative(WATCHLIST_PATH)
    },
    mode: "read-only-research",
    signals,
    summary: {
      active: signals.filter((signal) => signal.status === "active").length,
      invalid: signals.filter((signal) => signal.status === "invalid").length,
      pending: signals.filter((signal) => signal.status === "pending").length,
      total: signals.length
    }
  };

  return {
    inputs,
    payload
  };
}

function renderConsoleReport(payload) {
  return [
    "WALY Real Signal Log generado.",
    `Signals: ${payload.summary.total} | active=${payload.summary.active} | pending=${payload.summary.pending} | invalid=${payload.summary.invalid}`,
    `Output: ${formatRelative(REAL_SIGNAL_LOG_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no outcomes reales."
  ].join("\n");
}

function runRealSignalLog(options = {}) {
  const { inputs, payload } = buildPayload(options);
  const outputPath = writePillarJson("real-signal-log.json", payload);

  return {
    ...payload,
    inputsRaw: inputs,
    paths: {
      outputPath
    },
    consoleReport: renderConsoleReport(payload)
  };
}

module.exports = {
  BACKTESTS_DIR,
  DATA_DIR,
  DAILY_COCKPIT_PATH,
  OUTPUT_DIR,
  PARAMETER_SWEEP_PATH,
  POSITIONS_PATH,
  REAL_SIGNAL_LOG_PATH,
  SELECTOR_ENGINE_PATH,
  SETTINGS_PATH,
  SIGNAL_TYPE_ANALYSIS_PATH,
  SOCIAL_RADAR_PATH,
  V32_RESULTS_PATH,
  WATCHLIST_PATH,
  buildPayload,
  buildTickerUniverse,
  clamp,
  coerceNumber,
  daysUntil,
  firstText,
  firstValue,
  formatRelative,
  getCurrentDateInTimezone,
  getItemText,
  getMergedText,
  getMergedValue,
  isBiotechCatalyst,
  normalizeMarketData,
  parseDateOnly,
  readCoreInputs,
  readJsonIfExists,
  round,
  runRealSignalLog,
  writePillarJson,
  writePillarText
};
