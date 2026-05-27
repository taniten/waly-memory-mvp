"use strict";

const path = require("path");
const {
  OUTPUT_DIR,
  buildTickerUniverse,
  clamp,
  coerceNumber,
  firstValue,
  formatRelative,
  getMergedValue,
  isBiotechCatalyst,
  readCoreInputs,
  round,
  writePillarJson
} = require("./realSignalLog");
const { buildTimingPayload } = require("./timingEngine");

function estimatePortfolio(inputs) {
  const totalCapital = coerceNumber(inputs.settings && inputs.settings.portfolio && inputs.settings.portfolio.totalCapitalEstimate);
  const cash = coerceNumber(inputs.settings && inputs.settings.portfolio && inputs.settings.portfolio.cashEstimate);
  const positions = ((inputs.positions && inputs.positions.positions) || []).map((position) => {
    const quantity = coerceNumber(position.quantity);
    const price = coerceNumber(firstValue(position.lastPrice, position.marketData && position.marketData.price, position.avgPrice));
    const value = typeof quantity === "number" && typeof price === "number" ? quantity * price : null;

    return {
      isBiotechCatalyst: isBiotechCatalyst({
        inPortfolio: true,
        position,
        raw: position,
        ticker: position.ticker,
        watchlist: null
      }),
      price,
      quantity,
      ticker: position.ticker,
      value
    };
  });
  const exposureTotal = positions.reduce((sum, row) => sum + (typeof row.value === "number" ? Math.abs(row.value) : 0), 0);
  const biotechExposure = positions.reduce(
    (sum, row) => sum + (row.isBiotechCatalyst && typeof row.value === "number" ? Math.abs(row.value) : 0),
    0
  );

  return {
    biotechCatalystExposurePct: totalCapital ? round((biotechExposure / totalCapital) * 100, 2) : null,
    cash,
    exposureTotal,
    exposureTotalPct: totalCapital ? round((exposureTotal / totalCapital) * 100, 2) : null,
    positions,
    totalCapital
  };
}

function maxPctForClassification(classification, timingStatus, inPortfolio) {
  if (/^A\+/.test(classification) && timingStatus === "trigger_confirmed") {
    return inPortfolio ? 0 : 8;
  }

  if (classification === "A candidate") {
    return timingStatus === "trigger_confirmed" ? 5 : 3;
  }

  if (classification === "B watch") {
    return timingStatus === "trigger_confirmed" ? 2 : 0;
  }

  return 0;
}

function sizingActionFor({ classification, currentPositionPct, maxNewPositionPct, redFlags, timingStatus }) {
  if (currentPositionPct >= 28 || redFlags.includes("posicion grande actual")) {
    return "no_add";
  }

  if (timingStatus === "extended_risk") {
    return "no_add";
  }

  if (currentPositionPct > 0) {
    return "hold";
  }

  if (maxNewPositionPct <= 0) {
    return classification === "discard" ? "no_add" : "no_add";
  }

  if (maxNewPositionPct <= 2) {
    return "tiny_probe";
  }

  if (maxNewPositionPct <= 5) {
    return "small_position";
  }

  return "normal_position";
}

function buildSizingRow(item, selectorRow, timingRow, portfolio) {
  const price = firstValue(item.marketData.price, selectorRow && selectorRow.marketData && selectorRow.marketData.price);
  const current = portfolio.positions.find((row) => row.ticker === item.ticker);
  const currentPositionUSD = current && typeof current.value === "number" ? round(Math.abs(current.value), 2) : 0;
  const currentPositionPct = portfolio.totalCapital ? round((currentPositionUSD / portfolio.totalCapital) * 100, 2) : null;
  const classification = selectorRow ? selectorRow.classification : "missing";
  const redFlags = [];

  if (currentPositionPct !== null && currentPositionPct >= 25) {
    redFlags.push("posicion grande actual");
  }

  if (portfolio.biotechCatalystExposurePct !== null && portfolio.biotechCatalystExposurePct > 65 && isBiotechCatalyst(item)) {
    redFlags.push("exposicion catalyst/biotech >65%");
  }

  if (!selectorRow) {
    redFlags.push("selectorScore missing");
  }

  if (!timingRow || timingRow.status !== "trigger_confirmed") {
    redFlags.push("timing no confirmado");
  }

  let maxNewPositionPct = maxPctForClassification(
    classification,
    timingRow ? timingRow.status : "no_timing",
    item.inPortfolio
  );

  if (portfolio.biotechCatalystExposurePct !== null && portfolio.biotechCatalystExposurePct > 65 && isBiotechCatalyst(item)) {
    maxNewPositionPct = Math.min(maxNewPositionPct, 0);
  }

  if (item.inPortfolio && currentPositionPct !== null && currentPositionPct >= 25) {
    maxNewPositionPct = 0;
  }

  const suggestedSizeUSD = portfolio.totalCapital && maxNewPositionPct > 0
    ? round((portfolio.totalCapital * maxNewPositionPct) / 100, 2)
    : 0;
  const suggestedShares = typeof price === "number" && price > 0 && suggestedSizeUSD > 0
    ? Math.floor(suggestedSizeUSD / price)
    : 0;
  const sizingAction = sizingActionFor({
    classification,
    currentPositionPct: currentPositionPct || 0,
    maxNewPositionPct,
    redFlags,
    timingStatus: timingRow ? timingRow.status : "no_timing"
  });

  return {
    biotechCatalystExposurePct: portfolio.biotechCatalystExposurePct,
    cashEstimate: portfolio.cash,
    classification,
    currentPositionPct,
    currentPositionUSD,
    exposureTotalPct: portfolio.exposureTotalPct,
    maxNewPositionPct,
    missingData: [
      !selectorRow ? "selectorEngine" : null,
      !timingRow ? "timingEngine" : null,
      typeof price !== "number" ? "price" : null,
      typeof portfolio.totalCapital !== "number" ? "totalCapital" : null,
      typeof portfolio.cash !== "number" ? "cash" : null
    ].filter(Boolean),
    price: typeof price === "number" ? price : null,
    redFlags: [...new Set(redFlags)],
    selectorScore: selectorRow ? selectorRow.totalScore : null,
    sizingAction,
    suggestedShares,
    suggestedSizeUSD,
    ticker: item.ticker,
    timingStatus: timingRow ? timingRow.status : "no_timing",
    totalCapitalEstimate: portfolio.totalCapital
  };
}

function buildSizingPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const timing = options.timingPayload || buildTimingPayload({ inputs }).payload;
  const timingByTicker = new Map(timing.rows.map((row) => [row.ticker, row]));
  const selectorByTicker = new Map(((inputs.selectorEngine && inputs.selectorEngine.ranking) || []).map((row) => [row.ticker, row]));
  const portfolio = estimatePortfolio(inputs);
  const rows = buildTickerUniverse(inputs)
    .filter((item) => item.inPortfolio || item.inWatchlist || item.selector)
    .map((item) => buildSizingRow(item, selectorByTicker.get(item.ticker), timingByTicker.get(item.ticker), portfolio))
    .sort((left, right) => right.suggestedSizeUSD - left.suggestedSizeUSD || left.ticker.localeCompare(right.ticker));
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "read-only-research",
    notes: [
      "No opera y no prepara ordenes.",
      "Sizing es una sugerencia de revision, no un ticket.",
      "Biotech/catalyst concentrado o timing no confirmado bloquea agregar."
    ],
    portfolio,
    rows,
    summary: {
      addsSuggested: rows.filter((row) => row.suggestedSizeUSD > 0).length,
      reduceRiskSuggested: rows.filter((row) => row.sizingAction === "reduce_risk").length,
      total: rows.length
    }
  };

  return {
    inputs,
    payload
  };
}

function renderConsoleReport(payload) {
  const top = payload.rows.slice(0, 6).map((row) => `${row.ticker}:${row.sizingAction}:$${row.suggestedSizeUSD}`);

  return [
    "WALY Sizing Engine generado.",
    `Tickers: ${payload.summary.total} | addsSuggested=${payload.summary.addsSuggested}`,
    `Sizing: ${top.join(" | ") || "ninguno"}`,
    `Output: ${formatRelative(path.join(OUTPUT_DIR, "sizing-engine.json"))}`,
    "Confirmacion: no ordenes, no IBKR, no Binance."
  ].join("\n");
}

function runSizingEngine(options = {}) {
  const { inputs, payload } = buildSizingPayload(options);
  let outputPath = null;

  if (options.writeOutput !== false) {
    outputPath = writePillarJson("sizing-engine.json", payload);
  }

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
  buildSizingPayload,
  runSizingEngine
};
