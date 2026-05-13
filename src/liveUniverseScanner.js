"use strict";

const fs = require("fs");
const path = require("path");
const { requestJson } = require("./connectors/http");
const { fetchSavedFinvizScreens } = require("./connectors/finviz");
const { fetchSavedOpenInsiderScreens } = require("./connectors/openinsider");
const { fetchRecentFdaCatalysts } = require("./connectors/openfda");
const { fetchRecentInsiderCatalysts, fetchTickerMap } = require("./connectors/sec");
const { loadState } = require("./state");
const { BACKTESTS_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const DEFAULT_CONFIG = {
  allowNetwork: false,
  dryRun: true,
  includeBiotech: true,
  includeEarnings: true,
  includeEtfs: true,
  includeInsiders: true,
  maxCandidates: 3,
  maxTickers: 50,
  minDollarVolume: 10000000,
  minPrice: 2,
  minRelativeVolume: 1.25,
  outputDir: "backtests/live-universe-scan",
  seedMode: "local-plus-config",
  useLocalCsvFallback: false,
  yahooCacheTtlMinutes: 15,
  yahooMaxRetries: 2,
  yahooRequestDelayMs: 2000,
  yahooRetryBaseDelayMs: 5000,
  sourcesEnabled: {
    earnings: true,
    finviz: false,
    nasdaq: true,
    openfda: true,
    openinsider: false,
    sec: true,
    yahoo: true
  },
  universeSeeds: []
};

const ETF_SEEDS = ["SPY", "QQQ", "IWM", "XBI"];
const HISTORICAL_PRICES_DIR = path.resolve(__dirname, "..", "historical_prices");
const LEVEL_1_SOURCES = new Set(["yahoo-chart", "yahoo-chart-cache", "nasdaq", "nasdaq-earnings", "sec", "openfda"]);
const LEVEL_2_SOURCES = new Set(["finviz", "openinsider"]);

function readConfig(configPath) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return JSON.parse(raw);
}

function mergeConfig(input = {}) {
  const seedMode = input.seedMode === "config-only" ? "config-only" : DEFAULT_CONFIG.seedMode;

  return {
    ...DEFAULT_CONFIG,
    ...input,
    maxCandidates: Math.min(input.maxCandidates || DEFAULT_CONFIG.maxCandidates, 3),
    maxTickers: Math.min(input.maxTickers || DEFAULT_CONFIG.maxTickers, 50),
    seedMode,
    useLocalCsvFallback: input.useLocalCsvFallback === true,
    yahooCacheTtlMinutes: normalizeNonNegativeInteger(input.yahooCacheTtlMinutes, DEFAULT_CONFIG.yahooCacheTtlMinutes),
    yahooMaxRetries: normalizeNonNegativeInteger(input.yahooMaxRetries, DEFAULT_CONFIG.yahooMaxRetries),
    yahooRequestDelayMs: normalizeNonNegativeInteger(input.yahooRequestDelayMs, DEFAULT_CONFIG.yahooRequestDelayMs),
    yahooRetryBaseDelayMs: normalizeNonNegativeInteger(input.yahooRetryBaseDelayMs, DEFAULT_CONFIG.yahooRetryBaseDelayMs),
    sourcesEnabled: {
      ...DEFAULT_CONFIG.sourcesEnabled,
      ...(input.sourcesEnabled || {})
    },
    universeSeeds: Array.isArray(input.universeSeeds) ? input.universeSeeds : []
  };
}

function ensureOutputDir(outputDir) {
  const requested = path.resolve(process.cwd(), outputDir || DEFAULT_CONFIG.outputDir);
  const relativeToBacktests = path.relative(BACKTESTS_DIR, requested);

  if (relativeToBacktests.startsWith("..") || path.isAbsolute(relativeToBacktests)) {
    throw new Error("outputDir debe estar dentro de backtests/ para mantener el scanner read-only.");
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

function normalizeNonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseMagnitude(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value || "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  const match = text.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);

  if (!match) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const multipliers = {
    B: 1e9,
    K: 1e3,
    M: 1e6,
    T: 1e12
  };

  return Number(match[1]) * (multipliers[(match[2] || "").toUpperCase()] || 1);
}

function shiftDate(dateOnly, dayOffset) {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function compareDateOnly(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}

function sourceStatus(status, message, extra = {}) {
  return {
    message: message || "",
    status,
    ...extra
  };
}

function parseCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}

function isRateLimitError(error) {
  const message = String((error && error.message) || "");
  return Number(error && error.statusCode) === 429 || message.includes("HTTP 429");
}

function getYahooCacheDir(outputDir) {
  const cacheDir = path.join(outputDir, "cache", "yahoo");
  fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function getYahooCacheFilePath(cacheDir, ticker) {
  return path.join(cacheDir, `${normalizeTicker(ticker)}.json`);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function readYahooCache(cacheDir, ticker, ttlMinutes) {
  if (!ttlMinutes || ttlMinutes <= 0) {
    return null;
  }

  const filePath = getYahooCacheFilePath(cacheDir, ticker);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const payload = readJsonSafe(filePath);

  if (!payload || !payload.cachedAt || !payload.marketData) {
    return null;
  }

  const ageMs = Date.now() - new Date(payload.cachedAt).getTime();

  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMinutes * 60 * 1000) {
    return null;
  }

  return {
    cachedAt: payload.cachedAt,
    source: "yahoo-cache",
    sourceTag: "yahoo-chart-cache",
    ...payload.marketData
  };
}

function writeYahooCache(cacheDir, ticker, marketData) {
  const filePath = getYahooCacheFilePath(cacheDir, ticker);
  const payload = {
    cachedAt: new Date().toISOString(),
    marketData: {
      averageVolume20: isFiniteNumber(marketData.averageVolume20) ? marketData.averageVolume20 : null,
      dayChangePct: isFiniteNumber(marketData.dayChangePct) ? marketData.dayChangePct : null,
      dollarVolume: isFiniteNumber(marketData.dollarVolume) ? marketData.dollarVolume : null,
      fiveDayReturnPct: isFiniteNumber(marketData.fiveDayReturnPct) ? marketData.fiveDayReturnPct : null,
      gapPct: isFiniteNumber(marketData.gapPct) ? marketData.gapPct : null,
      lastDataDate: marketData.lastDataDate || null,
      previousClose: isFiniteNumber(marketData.previousClose) ? marketData.previousClose : null,
      price: isFiniteNumber(marketData.price) ? marketData.price : null,
      relativeVolume: isFiniteNumber(marketData.relativeVolume) ? marketData.relativeVolume : null,
      volume: isFiniteNumber(marketData.volume) ? marketData.volume : null
    },
    ticker
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readLocalCsvMarketData(ticker) {
  const filePath = path.join(HISTORICAL_PRICES_DIR, `${normalizeTicker(ticker)}.csv`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);

  if (lines.length < 3) {
    return null;
  }

  const headers = parseCsvLine(lines[0]);
  const columnIndex = Object.fromEntries(headers.map((header, index) => [header.toLowerCase(), index]));
  const requiredColumns = ["date", "open", "close", "volume"];

  if (requiredColumns.some((column) => columnIndex[column] === undefined)) {
    return null;
  }

  const rows = lines
    .slice(1)
    .map((line) => parseCsvLine(line))
    .map((values) => ({
      close: Number(values[columnIndex.close]),
      date: values[columnIndex.date],
      open: Number(values[columnIndex.open]),
      volume: Number(values[columnIndex.volume])
    }))
    .filter((row) => row.date && isFiniteNumber(row.close) && isFiniteNumber(row.volume));

  if (rows.length < 2) {
    return null;
  }

  rows.sort((left, right) => String(left.date).localeCompare(String(right.date)));

  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const priorVolumes = rows.slice(Math.max(0, rows.length - 21), -1).map((row) => row.volume).filter(isFiniteNumber);
  const averageVolume20 =
    priorVolumes.length > 0
      ? priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length
      : null;
  const dayChangePct = previous && previous.close ? ((latest.close - previous.close) / previous.close) * 100 : null;
  const gapPct = previous && previous.close && latest.open ? ((latest.open - previous.close) / previous.close) * 100 : null;
  const relativeVolume = latest && averageVolume20 ? latest.volume / averageVolume20 : null;
  const dollarVolume = latest.close * latest.volume;
  const fiveDayAgo = rows.length >= 6 ? rows[rows.length - 6] : null;
  const fiveDayReturnPct =
    fiveDayAgo && fiveDayAgo.close ? ((latest.close - fiveDayAgo.close) / fiveDayAgo.close) * 100 : null;

  return {
    averageVolume20: averageVolume20 ? Math.round(averageVolume20) : null,
    dayChangePct: round(dayChangePct),
    dollarVolume: round(dollarVolume),
    fiveDayReturnPct: round(fiveDayReturnPct),
    gapPct: round(gapPct),
    lastDataDate: latest.date,
    previousClose: round(previous.close),
    price: round(latest.close),
    relativeVolume: round(relativeVolume),
    source: "local-csv-fallback",
    sourceTag: "local-csv-fallback",
    volume: latest.volume
  };
}

function isSourceEnabled(config, sourceName) {
  return config.sourcesEnabled[sourceName] !== false;
}

function getConnectorConfig(state) {
  const connectors = state.settings.connectors || {};

  return {
    finviz: {
      apiToken: process.env.FINVIZ_API_TOKEN || ((connectors.finviz || {}).apiToken || ""),
      enabled: (connectors.finviz || {}).enabled !== false,
      savedScreens: (connectors.finviz || {}).savedScreens || [],
      timeoutMs: (connectors.finviz || {}).timeoutMs || 20000
    },
    openfda: {
      apiKey: process.env.OPENFDA_API_KEY || ((connectors.openfda || {}).apiKey || ""),
      baseUrl: (connectors.openfda || {}).baseUrl || "https://api.fda.gov",
      companyMap: (connectors.openfda || {}).companyMap || {},
      enabled: (connectors.openfda || {}).enabled !== false,
      limitPerCompany: (connectors.openfda || {}).limitPerCompany || 5,
      maxCompaniesPerSync: (connectors.openfda || {}).maxCompaniesPerSync || 15,
      timeoutMs: (connectors.openfda || {}).timeoutMs || 20000
    },
    openinsider: {
      enabled: (connectors.openinsider || {}).enabled !== false,
      savedScreens: (connectors.openinsider || {}).savedScreens || [],
      timeoutMs: (connectors.openinsider || {}).timeoutMs || 20000,
      userAgent: (connectors.openinsider || {}).userAgent || "Mozilla/5.0"
    },
    sec: {
      baseUrl: (connectors.sec || {}).baseUrl || "https://data.sec.gov",
      enabled: (connectors.sec || {}).enabled !== false,
      formTypes: (connectors.sec || {}).formTypes || ["4", "4/A"],
      maxTickersPerSync: (connectors.sec || {}).maxTickersPerSync || 25,
      requestDelayMs: (connectors.sec || {}).requestDelayMs || 150,
      tickerMapUrl: (connectors.sec || {}).tickerMapUrl || "https://www.sec.gov/files/company_tickers_exchange.json",
      timeoutMs: (connectors.sec || {}).timeoutMs || 20000,
      userAgent:
        process.env.SEC_USER_AGENT ||
        ((connectors.sec || {}).userAgent || "WALY Outlier Hunt/1.3 research@local.dev")
    }
  };
}

function addSeed(seeds, ticker, source, metadata = {}) {
  const normalizedTicker = normalizeTicker(ticker);

  if (!normalizedTicker) {
    return;
  }

  if (!seeds.has(normalizedTicker)) {
    seeds.set(normalizedTicker, {
      sources: [],
      ticker: normalizedTicker
    });
  }

  const seed = seeds.get(normalizedTicker);
  seed.sources.push(source);
  Object.assign(seed, metadata);
}

function collectUniverseSeeds(state, config) {
  const seeds = new Map();
  const useLocalSeeds = config.seedMode !== "config-only";

  if (useLocalSeeds) {
    (state.positions.positions || []).forEach((position) => {
      addSeed(seeds, position.ticker, "position", {
        localContext: position
      });
    });

    (state.watchlist.watchlist || []).forEach((item) => {
      addSeed(seeds, item.ticker, "watchlist", {
        localContext: item
      });
    });

    (state.socialSignals.signals || []).forEach((signal) => {
      addSeed(seeds, signal.ticker, "local-social");
    });
  }

  config.universeSeeds.forEach((item) => {
    if (typeof item === "string") {
      addSeed(seeds, item, "config");
      return;
    }

    if (item && typeof item === "object") {
      addSeed(seeds, item.ticker, item.source || "config", item);
    }
  });

  if (useLocalSeeds && config.includeEtfs) {
    ETF_SEEDS.forEach((ticker) => {
      addSeed(seeds, ticker, "tactical-etf", {
        assetType: "etf"
      });
    });
  }

  return [...seeds.values()]
    .map((seed) => ({
      ...seed,
      sources: [...new Set(seed.sources)]
    }))
    .slice(0, config.maxTickers);
}

function createCandidate(seed) {
  return {
    assetType: seed.assetType || "equity",
    catalysts: [],
    classification: "descartada",
    companyName: seed.companyName || "",
    discoveryReasons: [],
    errors: [],
    filterStatus: {},
    localContext: seed.localContext || null,
    marketData: null,
    rejectReasons: [],
    sourceLevels: {
      level1: [],
      level2: [],
      local: seed.sources || []
    },
    sourceTags: [...(seed.sources || [])],
    ticker: seed.ticker,
    walyScore: 0
  };
}

function ensureCandidate(candidateMap, ticker, seed = {}) {
  const normalizedTicker = normalizeTicker(ticker);

  if (!normalizedTicker) {
    return null;
  }

  if (!candidateMap.has(normalizedTicker)) {
    candidateMap.set(
      normalizedTicker,
      createCandidate({
        ...seed,
        ticker: normalizedTicker
      })
    );
  }

  return candidateMap.get(normalizedTicker);
}

function addSource(candidate, sourceName) {
  if (!candidate || !sourceName) {
    return;
  }

  candidate.sourceTags.push(sourceName);

  if (LEVEL_1_SOURCES.has(sourceName)) {
    candidate.sourceLevels.level1.push(sourceName);
  } else if (LEVEL_2_SOURCES.has(sourceName)) {
    candidate.sourceLevels.level2.push(sourceName);
  }
}

function addCatalyst(candidate, catalyst) {
  if (!candidate || !catalyst) {
    return;
  }

  candidate.catalysts.push(catalyst);
  addSource(candidate, catalyst.sourceTag);
}

function applyLocalContext(candidate) {
  const local = candidate.localContext;

  if (!local) {
    return;
  }

  candidate.companyName = candidate.companyName || local.companyName || "";
  candidate.discoveryReasons.push("Ya existe en memoria local WALY.");

  if (local.catalyst || local.catalystType || local.catalystDate) {
    candidate.catalysts.push({
      catalystDate: local.catalystDate || local.catalystWindow || null,
      catalystType: local.catalystType || null,
      decisive: false,
      notes: local.catalyst || "Catalyst local pendiente de reverificacion live.",
      source: local.source || "WALY local memory",
      sourceLevel: "local",
      sourceTag: "local-memory"
    });
    candidate.sourceTags.push("local-memory");
  }

  candidate.localScores = {
    crowdingRisk: local.crowdingRisk,
    downsideClarity: local.downsideClarity,
    liquidityQuality: local.liquidityQuality
  };
}

function extractYahooSeries(result) {
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];

  if (!quote || !timestamps.length) {
    return [];
  }

  return timestamps
    .map((timestamp, index) => ({
      close: quote.close && quote.close[index],
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      high: quote.high && quote.high[index],
      low: quote.low && quote.low[index],
      open: quote.open && quote.open[index],
      volume: quote.volume && quote.volume[index]
    }))
    .filter((row) => isFiniteNumber(row.close) && isFiniteNumber(row.volume));
}

function toYahooMarketData(ticker, chartResult) {
  const result = chartResult && chartResult.chart && chartResult.chart.result && chartResult.chart.result[0];

  if (!result) {
    throw new Error(`Yahoo chart sin result para ${ticker}.`);
  }

  const meta = result.meta || {};
  const series = extractYahooSeries(result);
  const latest = [...series].reverse().find((row) => isFiniteNumber(row.close) && isFiniteNumber(row.volume));
  const previous = series.length >= 2 ? series[series.length - 2] : null;
  const priorVolumes = series.slice(Math.max(0, series.length - 21), -1).map((row) => row.volume).filter(isFiniteNumber);
  const averageVolume20 =
    priorVolumes.length > 0
      ? priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length
      : null;
  const price =
    isFiniteNumber(meta.regularMarketPrice) ? meta.regularMarketPrice
    : latest && isFiniteNumber(latest.close) ? latest.close
    : null;
  const previousClose =
    isFiniteNumber(meta.chartPreviousClose) ? meta.chartPreviousClose
    : previous && isFiniteNumber(previous.close) ? previous.close
    : null;
  const open = latest && isFiniteNumber(latest.open) ? latest.open : null;
  const dayChangePct = price && previousClose ? ((price - previousClose) / previousClose) * 100 : null;
  const gapPct = open && previousClose ? ((open - previousClose) / previousClose) * 100 : null;
  const relativeVolume = latest && averageVolume20 ? latest.volume / averageVolume20 : null;
  const dollarVolume = price && latest ? price * latest.volume : null;
  const fiveDayAgo = series.length >= 6 ? series[series.length - 6] : null;
  const fiveDayReturnPct =
    price && fiveDayAgo && isFiniteNumber(fiveDayAgo.close) ? ((price - fiveDayAgo.close) / fiveDayAgo.close) * 100 : null;

  return {
    averageVolume20: averageVolume20 ? Math.round(averageVolume20) : null,
    dayChangePct: round(dayChangePct),
    dollarVolume: round(dollarVolume),
    fiveDayReturnPct: round(fiveDayReturnPct),
    gapPct: round(gapPct),
    lastDataDate: latest ? latest.date : null,
    price: round(price),
    previousClose: round(previousClose),
    relativeVolume: round(relativeVolume),
    volume: latest ? latest.volume : null
  };
}

async function fetchYahooMarketData(tickers, options = {}) {
  const results = [];
  const errors = [];
  const tickersCached = [];
  const tickersFailed = [];
  const tickersFallbackUsed = [];
  const tickersRateLimited = [];
  const tickersSuccess = [];
  const cacheDir = getYahooCacheDir(options.outputDir || path.resolve(process.cwd(), DEFAULT_CONFIG.outputDir));
  const requestDelayMs = normalizeNonNegativeInteger(options.requestDelayMs, DEFAULT_CONFIG.yahooRequestDelayMs);
  const maxRetries = normalizeNonNegativeInteger(options.maxRetries, DEFAULT_CONFIG.yahooMaxRetries);
  const retryBaseDelayMs = normalizeNonNegativeInteger(options.retryBaseDelayMs, DEFAULT_CONFIG.yahooRetryBaseDelayMs);
  const cacheTtlMinutes = normalizeNonNegativeInteger(options.cacheTtlMinutes, DEFAULT_CONFIG.yahooCacheTtlMinutes);

  for (let index = 0; index < tickers.length; index += 1) {
    const ticker = tickers[index];
    const cached = readYahooCache(cacheDir, ticker, cacheTtlMinutes);

    if (cached) {
      results.push({
        data: cached,
        ticker
      });
      tickersCached.push(ticker);
      continue;
    }

    let lastError = null;
    let rateLimited = false;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await requestJson(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, {
          query: {
            interval: "1d",
            range: "3mo"
          },
          timeoutMs: options.timeoutMs || 20000
        });
        const marketData = {
          source: "yahoo-chart",
          sourceTag: "yahoo-chart",
          ...toYahooMarketData(ticker, response.json)
        };

        writeYahooCache(cacheDir, ticker, marketData);
        results.push({
          data: marketData,
          ticker
        });
        tickersSuccess.push(ticker);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;

        if (isRateLimitError(error)) {
          rateLimited = true;

          if (attempt < maxRetries) {
            await sleep(retryBaseDelayMs * (attempt + 1));
            continue;
          }
        }

        break;
      }
    }

    if (lastError) {
      if (rateLimited) {
        tickersRateLimited.push(ticker);
      }

      if (options.useLocalCsvFallback) {
        const fallbackData = readLocalCsvMarketData(ticker);

        if (fallbackData) {
          results.push({
            data: fallbackData,
            ticker
          });
          tickersFallbackUsed.push(ticker);
          errors.push({
            error: lastError.message,
            fallbackUsed: true,
            ticker
          });
        } else {
          tickersFailed.push(ticker);
          errors.push({
            error: lastError.message,
            ticker
          });
        }
      } else {
        tickersFailed.push(ticker);
        errors.push({
          error: lastError.message,
          ticker
        });
      }
    }

    if (index < tickers.length - 1 && requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }
  }

  const usableCount = results.length;
  const status =
    usableCount === 0 && errors.length > 0 ? "error"
    : errors.length > 0 ? "partial"
    : tickersCached.length > 0 && tickersSuccess.length === 0 ? "cached"
    : "ok";

  return {
    count: usableCount,
    errors,
    results,
    status,
    tickersCached,
    tickersFailed,
    tickersFallbackUsed,
    tickersRateLimited,
    tickersSuccess
  };
}

function extractNasdaqRows(json) {
  if (json && json.data && Array.isArray(json.data.rows)) {
    return json.data.rows;
  }

  if (json && json.data && json.data.calendar && Array.isArray(json.data.calendar.rows)) {
    return json.data.calendar.rows;
  }

  return [];
}

function getNasdaqValue(data, key) {
  const summary = data && data.summaryData;
  const value = summary && summary[key] && summary[key].value;

  if (value === undefined || value === null || value === "N/A") {
    return null;
  }

  return value;
}

async function fetchNasdaqSummary(tickers, options = {}) {
  const results = [];
  const errors = [];

  for (const ticker of tickers) {
    try {
      const response = await requestJson(`https://api.nasdaq.com/api/quote/${ticker}/summary`, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0"
        },
        query: {
          assetclass: "stocks"
        },
        timeoutMs: options.timeoutMs || 20000
      });
      const data = response.json && response.json.data;

      results.push({
        data: {
          marketCap: parseMagnitude(getNasdaqValue(data, "Market Cap")),
          rawMarketCap: getNasdaqValue(data, "Market Cap"),
          rawShortInterest: getNasdaqValue(data, "Short Interest")
        },
        ticker
      });
    } catch (error) {
      errors.push({
        error: error.message,
        ticker
      });
    }
  }

  return {
    errors,
    results
  };
}

async function fetchNasdaqEarnings(tickers, options = {}) {
  const catalysts = [];
  const errors = [];

  for (const ticker of tickers) {
    try {
      const response = await requestJson("https://api.nasdaq.com/api/calendar/earnings", {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": "Mozilla/5.0"
        },
        query: {
          symbol: ticker
        },
        timeoutMs: options.timeoutMs || 20000
      });
      const rows = extractNasdaqRows(response.json);

      rows.forEach((row) => {
        const symbol = normalizeTicker(row.symbol || row.ticker || ticker);

        if (symbol !== ticker) {
          return;
        }

        catalysts.push({
          catalystDate: row.date || row.reportDate || row.earningsDate || null,
          catalystType: "earnings",
          decisive: true,
          notes: `Nasdaq earnings calendar | ${row.time || row.timeOfDay || "time n/d"}`,
          source: "Nasdaq earnings calendar",
          sourceLevel: "level1",
          sourceTag: "nasdaq-earnings",
          ticker
        });
      });
    } catch (error) {
      errors.push({
        error: error.message,
        ticker
      });
    }
  }

  return {
    catalysts,
    errors
  };
}

function applyYahooData(candidate, data, config) {
  candidate.marketData = {
    ...(candidate.marketData || {}),
    ...data
  };
  addSource(candidate, data.sourceTag || "yahoo-chart");

  const unusualVolume =
    data.sourceTag !== "local-csv-fallback" &&
    isFiniteNumber(data.relativeVolume) &&
    data.relativeVolume >= config.minRelativeVolume &&
    (
      Math.abs(data.dayChangePct || 0) >= 4 ||
      Math.abs(data.gapPct || 0) >= 3
    );

  if (unusualVolume) {
    addCatalyst(candidate, {
      catalystDate: data.lastDataDate,
      catalystType: "unusual-volume-gap",
      decisive: true,
      notes: `Yahoo chart confirma volumen relativo ${data.relativeVolume}x y movimiento ${data.dayChangePct}%.`,
      source: "Yahoo Finance chart endpoint",
      sourceLevel: "level1",
      sourceTag: "yahoo-chart"
    });
  }
}

function applyNasdaqSummary(candidate, data) {
  candidate.marketData = {
    ...(candidate.marketData || {}),
    marketCap: data.marketCap || (candidate.marketData && candidate.marketData.marketCap) || null,
    rawMarketCap: data.rawMarketCap || null,
    rawShortInterest: data.rawShortInterest || null
  };
  addSource(candidate, "nasdaq");
}

function applyDiscoveryCandidate(candidate, discoveryCandidate, sourceTag) {
  candidate.companyName = candidate.companyName || discoveryCandidate.companyName || "";
  candidate.discoveryReasons.push(...(discoveryCandidate.discoveryReasons || []));
  candidate.marketData = {
    ...(candidate.marketData || {}),
    dayChangePct: discoveryCandidate.dayChangePct || (candidate.marketData && candidate.marketData.dayChangePct) || null,
    dollarVolume: discoveryCandidate.dollarVolume || (candidate.marketData && candidate.marketData.dollarVolume) || null,
    marketCap: discoveryCandidate.marketCap || (candidate.marketData && candidate.marketData.marketCap) || null,
    price: discoveryCandidate.lastPrice || (candidate.marketData && candidate.marketData.price) || null,
    volume: discoveryCandidate.volume || (candidate.marketData && candidate.marketData.volume) || null
  };
  addSource(candidate, sourceTag);

  if (discoveryCandidate.catalystType) {
    candidate.catalysts.push({
      catalystDate: discoveryCandidate.catalystDate || null,
      catalystType: discoveryCandidate.catalystType,
      decisive: false,
      notes: discoveryCandidate.notes || `${sourceTag} discovery.`,
      source: sourceTag,
      sourceLevel: "level2",
      sourceTag
    });
  }
}

function applySecMetadata(candidate, company) {
  if (!company) {
    return;
  }

  candidate.companyName = candidate.companyName || company.companyName || "";
  candidate.exchange = company.exchange || candidate.exchange || "";
}

function applyCatalystFeed(candidateMap, catalysts, sourceTag, decisive = true) {
  catalysts.forEach((catalyst) => {
    const candidate = ensureCandidate(candidateMap, catalyst.ticker);

    if (!candidate) {
      return;
    }

    addCatalyst(candidate, {
      catalystDate: catalyst.catalystDate || null,
      catalystType: catalyst.catalystType || null,
      decisive,
      metadata: catalyst.metadata || {},
      notes: catalyst.notes || catalyst.source || `${sourceTag} catalyst`,
      source: catalyst.source || sourceTag,
      sourceLevel: decisive ? "level1" : "level2",
      sourceTag,
      ticker: candidate.ticker
    });
  });
}

function isNearCatalyst(candidate, currentDate) {
  return candidate.catalysts.some((catalyst) => {
    if (!catalyst.catalystDate) {
      return false;
    }

    return compareDateOnly(catalyst.catalystDate, shiftDate(currentDate, -7)) >= 0 &&
      compareDateOnly(catalyst.catalystDate, shiftDate(currentDate, 45)) <= 0;
  });
}

function analyzeCandidate(candidate, config, currentDate) {
  candidate.sourceTags = [...new Set(candidate.sourceTags)];
  candidate.sourceLevels.level1 = [...new Set(candidate.sourceLevels.level1)];
  candidate.sourceLevels.level2 = [...new Set(candidate.sourceLevels.level2)];
  candidate.sourceLevels.local = [...new Set(candidate.sourceLevels.local)];
  candidate.discoveryReasons = [...new Set(candidate.discoveryReasons.filter(Boolean))];

  const market = candidate.marketData || {};
  const localScores = candidate.localScores || {};
  const hasMarketData = isFiniteNumber(market.price);
  const usesFallbackMarketData = market.sourceTag === "local-csv-fallback";
  const priceOk = hasMarketData && market.price >= config.minPrice;
  const dollarVolumeOk = isFiniteNumber(market.dollarVolume) && market.dollarVolume >= config.minDollarVolume;
  const relativeVolumeOk = isFiniteNumber(market.relativeVolume) && market.relativeVolume >= config.minRelativeVolume;
  const hasLevel1Catalyst = candidate.catalysts.some((catalyst) => catalyst.decisive === true);
  const hasAnyCatalyst = candidate.catalysts.length > 0;
  const hasInsider = candidate.catalysts.some((catalyst) => catalyst.catalystType === "insider");
  const hasFda = candidate.catalysts.some((catalyst) => catalyst.catalystType === "fda");
  const hasEarnings = candidate.catalysts.some((catalyst) => catalyst.catalystType === "earnings");
  const nearCatalyst = isNearCatalyst(candidate, currentDate);
  const pumpExtended =
    isFiniteNumber(market.dayChangePct) &&
    Math.abs(market.dayChangePct) >= 25 ||
    isFiniteNumber(market.fiveDayReturnPct) &&
    market.fiveDayReturnPct >= 50;
  const downsideClear = !isFiniteNumber(localScores.downsideClarity) || localScores.downsideClarity >= 3;
  const crowdingOk = !isFiniteNumber(localScores.crowdingRisk) || localScores.crowdingRisk <= 3;

  candidate.filterStatus = {
    crowdingOk,
    dollarVolumeOk,
    fallbackUsed: usesFallbackMarketData,
    hasAnyCatalyst,
    hasLevel1Catalyst,
    hasMarketData,
    nearCatalyst,
    noPumpExtended: !pumpExtended,
    priceOk,
    relativeVolumeOk
  };

  const score =
    (hasLevel1Catalyst ? 30 : hasAnyCatalyst ? 10 : 0) +
    (priceOk ? 10 : 0) +
    (dollarVolumeOk ? 20 : 0) +
    (relativeVolumeOk ? 15 : 0) +
    (nearCatalyst ? 10 : 0) +
    (hasFda ? 10 : 0) +
    (hasInsider ? 6 : 0) +
    (hasEarnings ? 5 : 0) +
    (downsideClear ? 5 : -10) +
    (crowdingOk ? 5 : -10) -
    (pumpExtended ? 25 : 0);

  candidate.walyScore = score;

  if (!hasAnyCatalyst) {
    candidate.rejectReasons.push("Sin catalyst verificable o discovery catalyst.");
  }

  if (!hasMarketData) {
    candidate.rejectReasons.push("Sin market data live usable.");
  }

  if (hasMarketData && !priceOk) {
    candidate.rejectReasons.push(`Precio debajo de minPrice ${config.minPrice}.`);
  }

  if (hasMarketData && !dollarVolumeOk) {
    candidate.rejectReasons.push(`Dollar volume debajo de ${config.minDollarVolume}.`);
  }

  if (pumpExtended) {
    candidate.rejectReasons.push("Estructura demasiado extendida; posible pump/chase.");
  }

  if (!hasMarketData && config.dryRun) {
    candidate.classification = hasAnyCatalyst ? "vigilancia" : "descartada";
    candidate.rejectReasons.push("Dry-run sin precio live; no se eleva a A/A+.");
    candidate.rejectReasons = [...new Set(candidate.rejectReasons)];
    return candidate;
  }

  if (!hasAnyCatalyst || !priceOk || !dollarVolumeOk || pumpExtended) {
    candidate.classification = "descartada";
    candidate.rejectReasons = [...new Set(candidate.rejectReasons)];
    return candidate;
  }

  if (usesFallbackMarketData) {
    candidate.classification = "vigilancia";
    candidate.rejectReasons.push("Usa local-csv fallback; no cuenta como live real y no habilita A+.");
    candidate.rejectReasons = [...new Set(candidate.rejectReasons)];
    return candidate;
  }

  if (hasLevel1Catalyst && relativeVolumeOk && downsideClear && crowdingOk) {
    candidate.classification = "A+";
    candidate.rejectReasons = [...new Set(candidate.rejectReasons)];
    return candidate;
  }

  if (hasLevel1Catalyst && (relativeVolumeOk || nearCatalyst) && downsideClear) {
    candidate.classification = "A";
    candidate.rejectReasons = [...new Set(candidate.rejectReasons)];
    return candidate;
  }

  candidate.classification = "vigilancia";
  candidate.rejectReasons = [...new Set(candidate.rejectReasons)];
  return candidate;
}

async function safeSource(statusMap, sourceName, action) {
  try {
    const result = await action();
    statusMap[sourceName] = sourceStatus("ok", "", {
      count:
        Array.isArray(result.results) ? result.results.length
        : Array.isArray(result.catalysts) ? result.catalysts.length
        : Array.isArray(result.candidates) ? result.candidates.length
        : undefined,
      errors: result.errors || []
    });
    return result;
  } catch (error) {
    statusMap[sourceName] = sourceStatus("error", error.message);
    return null;
  }
}

function markSkippedSources(statusMap, config) {
  Object.keys(DEFAULT_CONFIG.sourcesEnabled).forEach((sourceName) => {
    if (statusMap[sourceName]) {
      return;
    }

    if (!isSourceEnabled(config, sourceName)) {
      statusMap[sourceName] = sourceStatus("disabled", "Fuente deshabilitada por config.");
      return;
    }

    if (!config.allowNetwork) {
      statusMap[sourceName] = sourceStatus("skipped", "allowNetwork=false; no se consulto red.");
    }
  });
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

function renderSummary({ analyzedCandidates, config, currentDate, filteredCandidates, sourceStatusMap, universeSeeds }) {
  const lines = [
    "# WALY Live Universe Scan",
    "",
    `As of: ${currentDate}`,
    `Mode: ${config.dryRun ? "dry-run" : "live read-only"}`,
    "Safety: no orders, no portfolio writes, no watchlist writes.",
    "",
    "## Source Status"
  ];

  Object.entries(sourceStatusMap).forEach(([sourceName, status]) => {
    lines.push(
      `- ${sourceName}: ${status.status}${status.count !== undefined ? ` | count ${status.count}` : ""}${status.tickersSuccess ? ` | live ${status.tickersSuccess.length}` : ""}${status.tickersCached ? ` | cache ${status.tickersCached.length}` : ""}${status.tickersFallbackUsed ? ` | fallback ${status.tickersFallbackUsed.length}` : ""}${status.tickersRateLimited ? ` | rate_limited ${status.tickersRateLimited.length}` : ""}${status.tickersFailed ? ` | failed ${status.tickersFailed.length}` : ""}${status.message ? ` | ${status.message}` : ""}`
    );
    (status.errors || []).slice(0, 8).forEach((error) => {
      lines.push(`- ${sourceName} error ${error.ticker || "n/d"}: ${error.error}${error.fallbackUsed ? " | fallback local-csv usado" : ""}`);
    });
  });

  lines.push("");
  lines.push("## Universe");
  lines.push(`- Seeds evaluados: ${universeSeeds.length}`);
  lines.push(`- maxTickers: ${config.maxTickers}`);
  lines.push(`- maxCandidates final: ${config.maxCandidates}`);
  lines.push("");
  lines.push("## Final Candidates");

  if (filteredCandidates.length === 0) {
    lines.push("- No hay candidatos WALY finales en esta corrida.");
  } else {
    lines.push("| Ticker | Class | Price | RelVol | DollarVol | Catalyst | Why |");
    lines.push("| --- | --- | ---: | ---: | ---: | --- | --- |");
    filteredCandidates.forEach((candidate) => {
      const market = candidate.marketData || {};
      const catalyst = candidate.catalysts[0] || {};
      lines.push(
        `| ${candidate.ticker} | ${candidate.classification} | ${market.price || "n/d"} | ${market.relativeVolume || "n/d"} | ${renderMoney(market.dollarVolume)} | ${catalyst.catalystType || "n/d"} | ${(candidate.discoveryReasons[0] || candidate.rejectReasons[0] || "n/d").replace(/\|/g, "/")} |`
      );
    });
  }

  lines.push("");
  lines.push("## Discarded / Watch");
  analyzedCandidates
    .filter((candidate) => !filteredCandidates.includes(candidate))
    .slice(0, 20)
    .forEach((candidate) => {
      const market = candidate.marketData || {};
      lines.push(
        `- ${candidate.ticker}: ${candidate.classification} | source ${market.source || "n/d"} | price ${market.price || "n/d"} | relVol ${market.relativeVolume || "n/d"} | day ${renderPercent(market.dayChangePct)} | ${candidate.rejectReasons[0] || "sin descarte duro"}`
      );
    });

  lines.push("");
  lines.push("## Decision");
  lines.push("- Scanner read-only. WALY no opera automaticamente ni modifica cartera.");
  lines.push("- Social/Nivel 2 queda como discovery; la conviccion exige Nivel 1.");

  return `${lines.join("\n")}\n`;
}

function toConsoleReport(result) {
  const sourceLines = Object.entries(result.sourceStatus)
    .map(([sourceName, status]) => {
      const count = status.count !== undefined ? ` | count ${status.count}` : "";
      const live = status.tickersSuccess ? ` | live ${status.tickersSuccess.length}` : "";
      const cache = status.tickersCached ? ` | cache ${status.tickersCached.length}` : "";
      const fallback = status.tickersFallbackUsed ? ` | fallback ${status.tickersFallbackUsed.length}` : "";
      const rateLimited = status.tickersRateLimited ? ` | rate_limited ${status.tickersRateLimited.length}` : "";
      const failed = status.tickersFailed ? ` | failed ${status.tickersFailed.length}` : "";
      return `- ${sourceName}: ${status.status}${count}${live}${cache}${fallback}${rateLimited}${failed}${status.message ? ` | ${status.message}` : ""}`;
    })
    .join("\n");
  const candidateLines =
    result.filteredCandidates.length === 0
      ? "- Ninguno."
      : result.filteredCandidates
        .map((candidate) => {
          const market = candidate.marketData || {};
          return `- ${candidate.ticker}: ${candidate.classification} | score ${candidate.walyScore} | source ${market.source || "n/d"} | price ${market.price || "n/d"} | relVol ${market.relativeVolume || "n/d"}`;
        })
        .join("\n");

  return [
    "WALY live universe scan generado.",
    `Output dir: ${result.outputDir}`,
    `Raw candidates: ${result.rawCandidates.length}`,
    `Final candidates: ${result.filteredCandidates.length}`,
    "",
    "Fuentes:",
    sourceLines,
    "",
    "Candidatos WALY:",
    candidateLines
  ].join("\n");
}

async function runLiveUniverseScan(configPath) {
  const inputConfig = readConfig(configPath);
  const config = mergeConfig(inputConfig);
  const state = loadState();
  const connectorConfig = getConnectorConfig(state);
  const outputDir = ensureOutputDir(config.outputDir);
  const sourceStatusMap = {};
  const universeSeeds = collectUniverseSeeds(state, config);
  const candidateMap = new Map();

  universeSeeds.forEach((seed) => {
    const candidate = ensureCandidate(candidateMap, seed.ticker, seed);
    applyLocalContext(candidate);
  });

  const tickers = universeSeeds.map((seed) => seed.ticker);

  if (config.allowNetwork && isSourceEnabled(config, "yahoo")) {
    const yahoo = await fetchYahooMarketData(tickers, {
      cacheTtlMinutes: config.yahooCacheTtlMinutes,
      maxRetries: config.yahooMaxRetries,
      outputDir,
      requestDelayMs: config.yahooRequestDelayMs,
      retryBaseDelayMs: config.yahooRetryBaseDelayMs,
      useLocalCsvFallback: config.useLocalCsvFallback
    });
    sourceStatusMap.yahoo = sourceStatus(yahoo.status, "", {
      count: yahoo.count,
      errors: yahoo.errors || [],
      tickersCached: yahoo.tickersCached || [],
      tickersFailed: yahoo.tickersFailed || [],
      tickersFallbackUsed: yahoo.tickersFallbackUsed || [],
      tickersRateLimited: yahoo.tickersRateLimited || [],
      tickersSuccess: yahoo.tickersSuccess || []
    });
    ((yahoo && yahoo.results) || []).forEach((item) => {
      const candidate = ensureCandidate(candidateMap, item.ticker);
      applyYahooData(candidate, item.data, config);
    });
  }

  if (config.allowNetwork && isSourceEnabled(config, "nasdaq")) {
    const nasdaq = await safeSource(sourceStatusMap, "nasdaq", () => fetchNasdaqSummary(tickers));
    ((nasdaq && nasdaq.results) || []).forEach((item) => {
      const candidate = ensureCandidate(candidateMap, item.ticker);
      applyNasdaqSummary(candidate, item.data);
    });
  }

  if (config.allowNetwork && isSourceEnabled(config, "earnings") && config.includeEarnings) {
    const earnings = await safeSource(sourceStatusMap, "earnings", () => fetchNasdaqEarnings(tickers));
    applyCatalystFeed(candidateMap, (earnings && earnings.catalysts) || [], "nasdaq-earnings", true);
  }

  let tickerMap = new Map();

  if (config.allowNetwork && isSourceEnabled(config, "sec") && config.includeInsiders) {
    const sec = await safeSource(sourceStatusMap, "sec", async () => {
      tickerMap = await fetchTickerMap(connectorConfig.sec);
      const catalysts = await fetchRecentInsiderCatalysts(connectorConfig.sec, tickers, {
        lookbackDate: shiftDate(state.currentDate, -30)
      });

      return {
        catalysts: catalysts.catalysts || [],
        results: catalysts.catalysts || [],
        tickerMap
      };
    });
    tickerMap = (sec && sec.tickerMap) || tickerMap;
    candidateMap.forEach((candidate) => applySecMetadata(candidate, tickerMap.get(candidate.ticker)));
    applyCatalystFeed(candidateMap, (sec && sec.catalysts) || [], "sec", true);
  }

  if (config.allowNetwork && isSourceEnabled(config, "openfda") && config.includeBiotech) {
    const fdaCompanies = tickers.map((ticker) => ({
      companyName: (tickerMap.get(ticker) && tickerMap.get(ticker).companyName) || "",
      sponsorName: connectorConfig.openfda.companyMap[ticker] || "",
      ticker
    }));
    const openfda = await safeSource(sourceStatusMap, "openfda", () =>
      fetchRecentFdaCatalysts(connectorConfig.openfda, fdaCompanies, {
        lookbackDate: shiftDate(state.currentDate, -60)
      })
    );
    applyCatalystFeed(candidateMap, (openfda && openfda.catalysts) || [], "openfda", true);
  }

  if (config.allowNetwork && isSourceEnabled(config, "finviz")) {
    const finviz = await safeSource(sourceStatusMap, "finviz", () => fetchSavedFinvizScreens(connectorConfig.finviz));
    ((finviz && finviz.candidates) || []).forEach((item) => {
      const candidate = ensureCandidate(candidateMap, item.ticker);
      applyDiscoveryCandidate(candidate, item, "finviz");
    });
  }

  if (config.allowNetwork && isSourceEnabled(config, "openinsider")) {
    const openinsider = await safeSource(sourceStatusMap, "openinsider", () =>
      fetchSavedOpenInsiderScreens(connectorConfig.openinsider)
    );
    ((openinsider && openinsider.candidates) || []).forEach((item) => {
      const candidate = ensureCandidate(candidateMap, item.ticker);
      applyDiscoveryCandidate(candidate, item, "openinsider");
    });
  }

  markSkippedSources(sourceStatusMap, config);

  const analyzedCandidates = [...candidateMap.values()]
    .map((candidate) => analyzeCandidate(candidate, config, state.currentDate))
    .sort((left, right) => {
      if (left.classification !== right.classification) {
        const order = {
          "A+": 4,
          A: 3,
          vigilancia: 2,
          descartada: 1
        };

        return order[right.classification] - order[left.classification];
      }

      if (left.walyScore !== right.walyScore) {
        return right.walyScore - left.walyScore;
      }

      return left.ticker.localeCompare(right.ticker);
    });
  const filteredCandidates = analyzedCandidates
    .filter((candidate) => candidate.classification !== "descartada")
    .slice(0, config.maxCandidates);
  const summaryMarkdown = renderSummary({
    analyzedCandidates,
    config,
    currentDate: state.currentDate,
    filteredCandidates,
    sourceStatusMap,
    universeSeeds
  });
  const sourceStatusPath = writeJsonFile(outputDir, "sourceStatus.json", sourceStatusMap);
  const rawCandidatesPath = writeJsonFile(outputDir, "rawCandidates.json", analyzedCandidates);
  const filteredCandidatesPath = writeJsonFile(outputDir, "filteredCandidates.json", filteredCandidates);
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
    sourceStatus: sourceStatusMap,
    universeSeeds
  };

  return {
    ...result,
    consoleReport: toConsoleReport(result)
  };
}

module.exports = {
  runLiveUniverseScan
};
