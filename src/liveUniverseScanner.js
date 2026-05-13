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
const LEVEL_1_SOURCES = new Set(["yahoo-chart", "nasdaq", "nasdaq-earnings", "sec", "openfda"]);
const LEVEL_2_SOURCES = new Set(["finviz", "openinsider"]);

function readConfig(configPath) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  return JSON.parse(raw);
}

function mergeConfig(input = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    maxCandidates: Math.min(input.maxCandidates || DEFAULT_CONFIG.maxCandidates, 3),
    maxTickers: Math.min(input.maxTickers || DEFAULT_CONFIG.maxTickers, 50),
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

  config.universeSeeds.forEach((item) => {
    if (typeof item === "string") {
      addSeed(seeds, item, "config");
      return;
    }

    if (item && typeof item === "object") {
      addSeed(seeds, item.ticker, item.source || "config", item);
    }
  });

  if (config.includeEtfs) {
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

  for (const ticker of tickers) {
    try {
      const response = await requestJson(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, {
        query: {
          interval: "1d",
          range: "3mo"
        },
        timeoutMs: options.timeoutMs || 20000
      });

      results.push({
        data: toYahooMarketData(ticker, response.json),
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
  addSource(candidate, "yahoo-chart");

  const unusualVolume =
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
    return candidate;
  }

  if (!hasAnyCatalyst || !priceOk || !dollarVolumeOk || pumpExtended) {
    candidate.classification = "descartada";
    return candidate;
  }

  if (hasLevel1Catalyst && relativeVolumeOk && downsideClear && crowdingOk) {
    candidate.classification = "A+";
    return candidate;
  }

  if (hasLevel1Catalyst && (relativeVolumeOk || nearCatalyst) && downsideClear) {
    candidate.classification = "A";
    return candidate;
  }

  candidate.classification = "vigilancia";
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
      `- ${sourceName}: ${status.status}${status.count !== undefined ? ` | count ${status.count}` : ""}${status.message ? ` | ${status.message}` : ""}`
    );
    (status.errors || []).slice(0, 5).forEach((error) => {
      lines.push(`- ${sourceName} error ${error.ticker || "n/d"}: ${error.error}`);
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
        `- ${candidate.ticker}: ${candidate.classification} | price ${market.price || "n/d"} | relVol ${market.relativeVolume || "n/d"} | day ${renderPercent(market.dayChangePct)} | ${candidate.rejectReasons[0] || "sin descarte duro"}`
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
      return `- ${sourceName}: ${status.status}${count}${status.message ? ` | ${status.message}` : ""}`;
    })
    .join("\n");
  const candidateLines =
    result.filteredCandidates.length === 0
      ? "- Ninguno."
      : result.filteredCandidates
        .map((candidate) => {
          const market = candidate.marketData || {};
          return `- ${candidate.ticker}: ${candidate.classification} | score ${candidate.walyScore} | price ${market.price || "n/d"} | relVol ${market.relativeVolume || "n/d"}`;
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
    const yahoo = await safeSource(sourceStatusMap, "yahoo", () => fetchYahooMarketData(tickers));
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
