"use strict";

const { normalizeTicker } = require("./validators");

const MODES = new Set(["production", "demo"]);
const DEMO_TICKERS = new Set(["DEMO", "TEST", "MOON"]);

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return MODES.has(mode) ? mode : "production";
}

function findFlagValue(args, flagName) {
  const equalsPrefix = `${flagName}=`;
  const equalsMatch = args.find((arg) => arg.startsWith(equalsPrefix));

  if (equalsMatch) {
    return equalsMatch.slice(equalsPrefix.length);
  }

  const index = args.indexOf(flagName);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }

  return null;
}

function parseRuntimeOptions(args = []) {
  const mode =
    args.includes("--demo")
      ? "demo"
      : args.includes("--production")
        ? "production"
        : normalizeMode(findFlagValue(args, "--mode") || process.env.WALY_MODE);

  return {
    mode,
    useExamples: mode === "demo" || args.includes("--use-examples") || args.includes("--demo-examples")
  };
}

function resolveRuntimeMode(options = {}) {
  return normalizeMode(options.mode || process.env.WALY_MODE);
}

function shouldUseDemoExamples(options = {}) {
  return resolveRuntimeMode(options) === "demo" || options.useExamples === true;
}

function isDemoTicker(ticker) {
  return DEMO_TICKERS.has(normalizeTicker(ticker));
}

function buildRealTickerSet(inputs = {}) {
  const tickers = new Set();
  const positions = inputs.positions && Array.isArray(inputs.positions.positions)
    ? inputs.positions.positions
    : [];
  const watchlist = inputs.watchlist && Array.isArray(inputs.watchlist.watchlist)
    ? inputs.watchlist.watchlist
    : [];

  positions.concat(watchlist).forEach((item) => {
    const ticker = normalizeTicker(item && item.ticker);
    if (ticker) {
      tickers.add(ticker);
    }
  });

  return tickers;
}

function productionAllowsTicker(ticker, realTickers, { realOnly = false } = {}) {
  const normalized = normalizeTicker(ticker);

  if (!normalized) {
    return false;
  }

  if (realOnly) {
    return realTickers.has(normalized);
  }

  return !isDemoTicker(normalized) || realTickers.has(normalized);
}

module.exports = {
  DEMO_TICKERS,
  buildRealTickerSet,
  isDemoTicker,
  normalizeMode,
  parseRuntimeOptions,
  productionAllowsTicker,
  resolveRuntimeMode,
  shouldUseDemoExamples
};
