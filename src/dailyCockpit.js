"use strict";

const fs = require("fs");
const path = require("path");
const { runOpportunityRouter } = require("./opportunityRouter");
const { runPortfolioReview } = require("./portfolioEngine");
const { BACKTESTS_DIR, DATA_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "daily-cockpit");
const POSITIONS_PATH = path.join(DATA_DIR, "positions.json");
const WATCHLIST_PATH = path.join(DATA_DIR, "watchlist.json");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const TICKERS = ["VKTX", "VRDN", "OCS", "VERA", "MNKD", "ACHV"];
const VERA_TRIGGER = {
  maxPrice: 34.5,
  minDollarVolume: 10000000,
  minRelativeVolume: 1.25
};

function round(value, decimals = 3) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function ensureOutputDir() {
  const resolved = path.resolve(OUTPUT_DIR);
  const relative = path.relative(BACKTESTS_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("daily-cockpit solo puede escribir dentro de backtests/.");
  }

  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function formatMoney(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `$${round(value, 2).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

function formatNumber(value, decimals = 3) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return round(value, decimals).toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals
  });
}

function formatPct(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${round(value, 2).toFixed(2)}%`;
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

function toEasternTimestamp(unixSeconds) {
  if (!Number.isInteger(unixSeconds) || unixSeconds <= 0) {
    return null;
  }

  return new Date(unixSeconds * 1000)
    .toLocaleString("sv-SE", {
      hour12: false,
      timeZone: "America/New_York"
    })
    .replace("T", " ");
}

function validateMarketData(ticker, marketData) {
  const numericFields = [
    "lastPrice",
    "previousClose",
    "dayChangePct",
    "volume",
    "averageVolume20",
    "relativeVolume",
    "dollarVolume"
  ];

  numericFields.forEach((field) => {
    if (!isFiniteNumber(marketData[field])) {
      throw new Error(`${ticker}: market data invalida en ${field}.`);
    }
  });

  if (marketData.lastPrice <= 0 || marketData.previousClose <= 0) {
    throw new Error(`${ticker}: precio invalido recibido desde Yahoo.`);
  }
}

async function fetchJson(url) {
  if (typeof fetch !== "function") {
    throw new Error("Node fetch no esta disponible para daily-cockpit.");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al consultar ${url}`);
  }

  return response.json();
}

function average(values) {
  const clean = values.filter((value) => isFiniteNumber(value));
  if (!clean.length) {
    return null;
  }

  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

async function fetchYahooMarketData(ticker) {
  const encodedTicker = encodeURIComponent(ticker);
  const intraday = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodedTicker}?range=1d&interval=1m&includePrePost=true`
  );
  const monthly = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodedTicker}?range=1mo&interval=1d`
  );
  const intradayResult = intraday && intraday.chart && intraday.chart.result && intraday.chart.result[0];
  const monthlyResult = monthly && monthly.chart && monthly.chart.result && monthly.chart.result[0];
  const meta = intradayResult && intradayResult.meta;
  const volumes =
    monthlyResult &&
    monthlyResult.indicators &&
    monthlyResult.indicators.quote &&
    monthlyResult.indicators.quote[0] &&
    Array.isArray(monthlyResult.indicators.quote[0].volume)
      ? monthlyResult.indicators.quote[0].volume.filter((value) => isFiniteNumber(value))
      : [];
  const completedVolumes = volumes.length > 1 ? volumes.slice(0, -1) : volumes;
  const averageVolume20 = average(completedVolumes.slice(-20));

  if (!meta) {
    throw new Error(`${ticker}: Yahoo no devolvio metadata de precio.`);
  }

  const lastPrice = Number(meta.regularMarketPrice);
  const previousClose = Number(meta.previousClose);
  const volume = Number(meta.regularMarketVolume);
  const marketData = {
    source: "yahoo-chart",
    sourceTag: "yahoo-chart",
    price: round(lastPrice, 4),
    previousClose: round(previousClose, 4),
    dayChangePct: round(((lastPrice - previousClose) / previousClose) * 100, 2),
    volume,
    averageVolume20: averageVolume20 ? Math.round(averageVolume20) : null,
    relativeVolume: averageVolume20 ? round(volume / averageVolume20, 3) : null,
    dollarVolume: round(lastPrice * volume, 2),
    lastDataDate: `${toEasternTimestamp(Number(meta.regularMarketTime)) || new Date().toISOString()} -04:00`,
    dayHigh: round(Number(meta.regularMarketDayHigh), 4),
    dayLow: round(Number(meta.regularMarketDayLow), 4)
  };

  validateMarketData(ticker, {
    lastPrice: marketData.price,
    previousClose: marketData.previousClose,
    dayChangePct: marketData.dayChangePct,
    volume: marketData.volume,
    averageVolume20: marketData.averageVolume20,
    relativeVolume: marketData.relativeVolume,
    dollarVolume: marketData.dollarVolume
  });

  return marketData;
}

async function fetchAllMarketData() {
  const entries = [];

  for (const ticker of TICKERS) {
    const marketData = await fetchYahooMarketData(ticker);
    entries.push([ticker, marketData]);
  }

  return Object.fromEntries(entries);
}

function assertPositionInvariants(before, after) {
  const beforeByTicker = new Map((before.positions || []).map((position) => [normalizeTicker(position.ticker), position]));

  (after.positions || []).forEach((position) => {
    const ticker = normalizeTicker(position.ticker);
    const original = beforeByTicker.get(ticker);

    if (!original) {
      return;
    }

    if (position.quantity !== original.quantity) {
      throw new Error(`${ticker}: daily-cockpit no puede modificar quantity.`);
    }

    if (position.avgPrice !== original.avgPrice) {
      throw new Error(`${ticker}: daily-cockpit no puede modificar avgPrice.`);
    }
  });
}

function updatePositionsMarketData(positions, marketDataByTicker) {
  return {
    ...positions,
    positions: (positions.positions || []).map((position) => {
      const ticker = normalizeTicker(position.ticker);
      const marketData = marketDataByTicker[ticker];

      if (!marketData) {
        return position;
      }

      return {
        ...position,
        lastPrice: marketData.price,
        marketData
      };
    })
  };
}

function updateWatchlistMarketData(watchlist, marketDataByTicker) {
  return {
    ...watchlist,
    watchlist: (watchlist.watchlist || []).map((item) => {
      const ticker = normalizeTicker(item.ticker);
      const marketData = marketDataByTicker[ticker];

      if (!marketData) {
        return item;
      }

      return {
        ...item,
        lastPrice: marketData.price,
        marketData
      };
    })
  };
}

function buildPortfolioRows(positions) {
  return (positions.positions || []).map((position) => {
    const price = isFiniteNumber(position.lastPrice) ? position.lastPrice : null;
    const avgPrice = isFiniteNumber(position.avgPrice) ? position.avgPrice : null;
    const quantity = isFiniteNumber(position.quantity) ? position.quantity : null;
    const market = position.marketData || {};
    const plUsd = isFiniteNumber(price) && isFiniteNumber(avgPrice) && isFiniteNumber(quantity)
      ? (price - avgPrice) * quantity
      : null;
    const plPct = isFiniteNumber(price) && isFiniteNumber(avgPrice) && avgPrice > 0 ? ((price / avgPrice) - 1) * 100 : null;

    return {
      action: "mantener",
      avgPrice,
      dayChangePct: market.dayChangePct,
      dollarVolume: market.dollarVolume,
      lastPrice: price,
      plPct: round(plPct, 2),
      plUsd: round(plUsd, 2),
      quantity,
      relativeVolume: market.relativeVolume,
      ticker: normalizeTicker(position.ticker),
      timestamp: market.lastDataDate,
      value: isFiniteNumber(price) && isFiniteNumber(quantity) ? round(price * quantity, 2) : null,
      volume: market.volume,
      averageVolume20: market.averageVolume20
    };
  });
}

function buildWatchlistRows(watchlist) {
  return (watchlist.watchlist || []).map((item) => {
    const market = item.marketData || {};

    return {
      dayChangePct: market.dayChangePct,
      dollarVolume: market.dollarVolume,
      lastPrice: item.lastPrice,
      rank: item.setupRank || "n/d",
      relativeVolume: market.relativeVolume,
      status: item.status,
      ticker: normalizeTicker(item.ticker),
      timestamp: market.lastDataDate,
      volume: market.volume,
      averageVolume20: market.averageVolume20
    };
  });
}

function uniqueTickers(ideas) {
  const seen = new Set();
  const tickers = [];

  ideas.forEach((idea) => {
    const ticker = normalizeTicker(idea && idea.ticker);
    if (!ticker || seen.has(ticker)) {
      return;
    }

    seen.add(ticker);
    tickers.push(ticker);
  });

  return tickers;
}

function evaluateVeraTrigger(watchlistRows) {
  const vera = watchlistRows.find((item) => item.ticker === "VERA");
  const checks = {
    price: Boolean(vera && isFiniteNumber(vera.lastPrice) && vera.lastPrice <= VERA_TRIGGER.maxPrice),
    relativeVolume: Boolean(
      vera && isFiniteNumber(vera.relativeVolume) && vera.relativeVolume >= VERA_TRIGGER.minRelativeVolume
    ),
    dollarVolume: Boolean(
      vera && isFiniteNumber(vera.dollarVolume) && vera.dollarVolume >= VERA_TRIGGER.minDollarVolume
    )
  };

  return {
    checks,
    passed: checks.price && checks.relativeVolume && checks.dollarVolume,
    thresholds: VERA_TRIGGER,
    ticker: "VERA",
    values: vera || null
  };
}

function buildDecision({ operables, manualCandidates, veraTrigger }) {
  if (veraTrigger.passed) {
    return "revisar VERA manualmente; el comando no opera ni prepara ejecucion automatica.";
  }

  if (operables.length > 0) {
    return `esperar ejecucion manual; router marco operables (${operables.join(", ")}), pero daily-cockpit no opera.`;
  }

  if (manualCandidates.length > 0) {
    return `esperar; candidatos manuales (${manualCandidates.join(", ")}) sin trigger completo.`;
  }

  return "esperar; no hay trigger completo ni operables.";
}

function renderPortfolioTable(rows) {
  const lines = [
    "| Ticker | Qty | Avg | Last | Day % | Vol | AvgVol | RelVol | $Vol | P/L aprox | Accion |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"
  ];

  rows.forEach((row) => {
    lines.push(
      `| ${row.ticker} | ${formatNumber(row.quantity, 0)} | ${formatNumber(row.avgPrice, 2)} | ${formatNumber(row.lastPrice, 3)} | ${formatPct(row.dayChangePct)} | ${formatNumber(row.volume, 0)} | ${formatNumber(row.averageVolume20, 0)} | ${formatNumber(row.relativeVolume, 3)} | ${formatMoney(row.dollarVolume)} | ${formatMoney(row.plUsd)} / ${formatPct(row.plPct)} | ${row.action} |`
    );
  });

  return lines.join("\n");
}

function renderWatchlistTable(rows) {
  const lines = [
    "| Ticker | Estado | Rank | Last | Day % | Vol | AvgVol | RelVol | $Vol |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|"
  ];

  rows.forEach((row) => {
    lines.push(
      `| ${row.ticker} | ${row.status || "n/d"} | ${row.rank} | ${formatNumber(row.lastPrice, 3)} | ${formatPct(row.dayChangePct)} | ${formatNumber(row.volume, 0)} | ${formatNumber(row.averageVolume20, 0)} | ${formatNumber(row.relativeVolume, 3)} | ${formatMoney(row.dollarVolume)} |`
    );
  });

  return lines.join("\n");
}

function renderSummary(result) {
  const lines = [];

  lines.push("# WALY Daily Cockpit");
  lines.push("");
  lines.push(`Fecha local: ${result.currentDate}`);
  lines.push(`Generado: ${result.generatedAt}`);
  lines.push("Modo: read-only; no opera, no usa IBKR, no usa Binance, no toca outcomes.");
  lines.push("");
  lines.push("## Cartera");
  lines.push(renderPortfolioTable(result.portfolio));
  lines.push("");
  lines.push("## Watchlist");
  lines.push(renderWatchlistTable(result.watchlist));
  lines.push("");
  lines.push("## Router");
  lines.push(`- Operables: ${result.router.operables.length ? result.router.operables.join(", ") : "ninguna"}`);
  lines.push(
    `- Manual candidates: ${result.router.manualCandidates.length ? result.router.manualCandidates.join(", ") : "ninguna"}`
  );
  lines.push(`- Watch: ${result.router.watch.length ? result.router.watch.join(", ") : "ninguna"}`);
  lines.push("");
  lines.push("## VERA Trigger");
  lines.push(`- Price <= ${VERA_TRIGGER.maxPrice}: ${result.veraTrigger.checks.price ? "si" : "no"}`);
  lines.push(
    `- Relative volume >= ${VERA_TRIGGER.minRelativeVolume}: ${result.veraTrigger.checks.relativeVolume ? "si" : "no"}`
  );
  lines.push(
    `- Dollar volume >= ${formatMoney(VERA_TRIGGER.minDollarVolume)}: ${result.veraTrigger.checks.dollarVolume ? "si" : "no"}`
  );
  lines.push(`- Resultado: ${result.veraTrigger.passed ? "cumple" : "no cumple"}`);
  lines.push("");
  lines.push("## Decision WALY");
  lines.push(`- ${result.decision}`);
  lines.push("");
  lines.push("## Confirmaciones");
  result.confirmations.forEach((confirmation) => lines.push(`- ${confirmation}`));

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  return [
    "# WALY Daily Cockpit",
    "",
    "Cartera:",
    renderPortfolioTable(result.portfolio),
    "",
    "Watchlist:",
    renderWatchlistTable(result.watchlist),
    "",
    `Operables: ${result.router.operables.length ? result.router.operables.join(", ") : "ninguna"}`,
    `Manual candidates: ${result.router.manualCandidates.length ? result.router.manualCandidates.join(", ") : "ninguna"}`,
    `Decision WALY: ${result.decision}`,
    `VERA trigger: ${result.veraTrigger.passed ? "cumple" : "no cumple"}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no outcomes, no commit, no push.",
    `latest.json: ${formatRelative(result.paths.latestJsonPath)}`,
    `summary.md: ${formatRelative(result.paths.summaryPath)}`
  ].join("\n");
}

async function runDailyCockpit() {
  const settings = readJsonFile(SETTINGS_PATH);
  const originalPositions = readJsonFile(POSITIONS_PATH);
  const originalWatchlist = readJsonFile(WATCHLIST_PATH);
  const marketDataByTicker = await fetchAllMarketData();
  const updatedPositions = updatePositionsMarketData(originalPositions, marketDataByTicker);
  const updatedWatchlist = updateWatchlistMarketData(originalWatchlist, marketDataByTicker);

  assertPositionInvariants(originalPositions, updatedPositions);

  const portfolioReview = runPortfolioReview();
  const opportunityRouter = runOpportunityRouter({
    outputDir: OUTPUT_DIR,
    writeOutputs: false
  });
  const portfolio = buildPortfolioRows(updatedPositions);
  const watchlist = buildWatchlistRows(updatedWatchlist);
  const operables = uniqueTickers(opportunityRouter.routedIdeas.filter((idea) => idea.decision === "operate"));
  const manualCandidates = uniqueTickers(
    opportunityRouter.routedIdeas.filter((idea) => idea.decision === "manual-candidate")
  );
  const watch = uniqueTickers(opportunityRouter.routedIdeas.filter((idea) => idea.decision === "watch"));
  const veraTrigger = evaluateVeraTrigger(watchlist);
  const decision = buildDecision({
    manualCandidates,
    operables,
    veraTrigger
  });
  const outputDir = ensureOutputDir();
  const latestJsonPath = path.join(outputDir, "latest.json");
  const summaryPath = path.join(outputDir, "summary.md");
  const result = {
    confirmations: [
      "No ejecuta ordenes.",
      "No usa IBKR para ejecutar.",
      "No usa Binance.",
      "No toca outcomes.",
      "No modifica quantity ni avgPrice.",
      "No modifica data/positions.json.",
      "No modifica data/watchlist.json.",
      "Market data se usa solo para output del cockpit.",
      "Opportunity-router corrio en modo no-write; salida persistida solo en daily-cockpit."
    ],
    currentDate: getCurrentDateInTimezone(settings.timezone),
    decision,
    generatedAt: new Date().toISOString(),
    marketData: marketDataByTicker,
    mode: "read-only",
    paths: {
      latestJsonPath,
      outputDir,
      summaryPath
    },
    portfolio,
    portfolioReview: {
      riskWarnings: portfolioReview.analysis.riskWarnings,
      totalCapital: portfolioReview.analysis.capital.totalCapital
    },
    router: {
      manualCandidates,
      operables,
      routedIdeasCount: opportunityRouter.routedIdeas.length,
      watch
    },
    tickers: TICKERS,
    veraTrigger,
    watchlist
  };
  const summaryMarkdown = renderSummary(result);

  writeJsonFile(latestJsonPath, result);
  fs.writeFileSync(summaryPath, summaryMarkdown, "utf8");

  return {
    ...result,
    consoleReport: renderConsoleReport(result),
    summaryMarkdown
  };
}

module.exports = {
  runDailyCockpit
};
