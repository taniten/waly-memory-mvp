"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");

const ROOT_DIR = path.resolve(__dirname, "..");
const HISTORICAL_REPLAY_DIR = path.join(BACKTESTS_DIR, "historical-replay");
const RESEARCH_PRICE_DIR = path.join(ROOT_DIR, "historical_prices", "research");
const HISTORICAL_RESEARCH_DIR = path.join(BACKTESTS_DIR, "historical-research");
const GENERATED_SIGNALS_PATH = path.join(HISTORICAL_RESEARCH_DIR, "generated-signals.json");
const PARAMETER_SWEEP_PATH = path.join(HISTORICAL_RESEARCH_DIR, "parameter-sweep.json");
const SIGNAL_TYPE_ANALYSIS_PATH = path.join(HISTORICAL_RESEARCH_DIR, "signal-type-analysis.json");
const V32_RESULTS_PATH = path.join(HISTORICAL_RESEARCH_DIR, "v3-2-signal-quality-backtest", "results.json");
const TRAIN_TEST_ENGINE_PATH = path.join(BACKTESTS_DIR, "7-pillars", "train-test-engine.json");
const EXAMPLE_SIGNALS_PATH = path.join(ROOT_DIR, "examples", "historical-signals.example.json");
const HISTORICAL_CATALYSTS_PATH = path.join(BACKTESTS_DIR, "historical-catalysts", "validated-catalysts.json");
const EXAMPLE_CATALYSTS_PATH = path.join(ROOT_DIR, "examples", "historical-catalysts.example.json");
const TRAIN_START = "2021-01-01";
const TRAIN_END = "2024-12-31";
const TEST_START = "2025-01-01";
const HORIZONS = [7, 20, 30, 60, 90];

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values, decimals = 2) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) {
    return null;
  }

  return round(usable.reduce((sum, value) => sum + value, 0) / usable.length, decimals);
}

function percentage(part, total) {
  if (!total) {
    return null;
  }

  return round((part / total) * 100, 1);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function assertReplayOutput(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(HISTORICAL_REPLAY_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Historical Replay solo puede escribir dentro de backtests/historical-replay/.");
  }
}

function writeReplayFile(fileName, contents) {
  const filePath = path.join(HISTORICAL_REPLAY_DIR, fileName);
  assertReplayOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function writeReplayJson(fileName, value) {
  return writeReplayFile(fileName, `${JSON.stringify(value, null, 2)}\n`);
}

function parseCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}

function parsePriceCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return {
      close: Number(values[index.close]),
      date: values[index.date],
      high: Number(values[index.high]),
      low: Number(values[index.low]),
      open: Number(values[index.open]),
      volume: Number(values[index.volume])
    };
  }).filter((row) =>
    row.date &&
    Number.isFinite(row.open) &&
    Number.isFinite(row.high) &&
    Number.isFinite(row.low) &&
    Number.isFinite(row.close) &&
    Number.isFinite(row.volume)
  ).sort((left, right) => left.date.localeCompare(right.date));
}

function loadPriceHistory() {
  const missingData = [];
  const byTicker = new Map();

  if (!fs.existsSync(RESEARCH_PRICE_DIR)) {
    return {
      byTicker,
      files: [],
      missingData: ["historical_prices/research/*.csv"]
    };
  }

  const files = fs.readdirSync(RESEARCH_PRICE_DIR)
    .filter((fileName) => fileName.toLowerCase().endsWith(".csv"))
    .sort();

  if (!files.length) {
    missingData.push("historical_prices/research/*.csv");
  }

  files.forEach((fileName) => {
    const ticker = path.basename(fileName, ".csv").toUpperCase();
    const rows = parsePriceCsv(path.join(RESEARCH_PRICE_DIR, fileName));
    if (!rows.length) {
      missingData.push(`${ticker}: empty price csv`);
    }
    byTicker.set(ticker, rows);
  });

  return {
    byTicker,
    files,
    missingData
  };
}

function loadSignals() {
  const generated = readJsonIfExists(GENERATED_SIGNALS_PATH);

  if (generated && Array.isArray(generated.signals)) {
    return {
      source: formatRelative(GENERATED_SIGNALS_PATH),
      signals: generated.signals,
      usedFallback: false
    };
  }

  const example = readJsonIfExists(EXAMPLE_SIGNALS_PATH);
  return {
    source: example ? formatRelative(EXAMPLE_SIGNALS_PATH) : null,
    signals: example && Array.isArray(example.signals) ? example.signals : [],
    usedFallback: Boolean(example)
  };
}

function loadCatalysts() {
  const validated = readJsonIfExists(HISTORICAL_CATALYSTS_PATH);
  const fallback = validated ? null : readJsonIfExists(EXAMPLE_CATALYSTS_PATH);
  const source = validated ? HISTORICAL_CATALYSTS_PATH : EXAMPLE_CATALYSTS_PATH;
  const rows = ((validated && validated.catalysts) || (fallback && fallback.catalysts) || [])
    .filter((row) =>
      row &&
      row.ticker &&
      row.knownFromDate &&
      row.catalystDate &&
      (!row.errors || row.errors.length === 0)
    )
    .map((row) => ({
      catalystDate: row.catalystDate,
      catalystId: row.catalystId || `${row.ticker}-${row.catalystDate}`,
      catalystType: row.catalystType || "other",
      expectedEvent: row.expectedEvent || null,
      knownFromDate: row.knownFromDate,
      source: row.source || null,
      ticker: String(row.ticker).trim().toUpperCase()
    }))
    .sort((left, right) =>
      left.ticker.localeCompare(right.ticker) ||
      left.knownFromDate.localeCompare(right.knownFromDate) ||
      left.catalystDate.localeCompare(right.catalystDate)
    );
  const byTicker = new Map();

  rows.forEach((row) => {
    const list = byTicker.get(row.ticker) || [];
    list.push(row);
    byTicker.set(row.ticker, list);
  });

  return {
    byTicker,
    rows,
    source: rows.length ? formatRelative(source) : null
  };
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) {
    return null;
  }

  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function matchCatalyst(signal, catalystsByTicker) {
  const candidates = catalystsByTicker.get(signal.ticker) || [];
  const match = candidates.find((row) =>
    row.knownFromDate <= signal.signalDate &&
    signal.signalDate <= row.catalystDate
  );

  if (!match) {
    return {
      catalystDate: null,
      catalystId: null,
      catalystLookaheadSafe: false,
      catalystSource: null,
      catalystType: null,
      daysToCatalyst: null,
      expectedEvent: null,
      hasKnownCatalyst: false
    };
  }

  return {
    catalystDate: match.catalystDate,
    catalystId: match.catalystId,
    catalystLookaheadSafe: true,
    catalystSource: match.source,
    catalystType: match.catalystType,
    daysToCatalyst: daysBetween(signal.signalDate, match.catalystDate),
    expectedEvent: match.expectedEvent,
    hasKnownCatalyst: true
  };
}

function findIndexByDate(rows, dateText) {
  return rows.findIndex((row) => row.date === dateText);
}

function previousAverageVolume(rows, signalIndex, lookback = 20) {
  const start = Math.max(0, signalIndex - lookback);
  const sample = rows.slice(start, signalIndex).map((row) => row.volume).filter(Number.isFinite);
  return sample.length >= Math.min(lookback, signalIndex) && sample.length > 0 ? average(sample, 0) : null;
}

function resultPct(exitPrice, entryPrice) {
  if (!Number.isFinite(exitPrice) || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return null;
  }

  return round(((exitPrice - entryPrice) / entryPrice) * 100, 2);
}

function futureResult(rows, signalIndex, entryPrice, horizon) {
  const future = rows[signalIndex + horizon];
  return future ? resultPct(future.close, entryPrice) : null;
}

function futurePathStats(rows, signalIndex, entryPrice) {
  const futureRows = rows.slice(signalIndex + 1, signalIndex + 91);
  if (!futureRows.length || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      daysToMaxMove: null,
      maxDrawdown: null,
      maxUpside: null
    };
  }

  let minDrawdown = null;
  let maxUpside = null;
  let daysToMaxMove = null;

  futureRows.forEach((row, index) => {
    const drawdown = resultPct(row.low, entryPrice);
    const upside = resultPct(row.high, entryPrice);

    if (drawdown !== null && (minDrawdown === null || drawdown < minDrawdown)) {
      minDrawdown = drawdown;
    }

    if (upside !== null && (maxUpside === null || upside > maxUpside)) {
      maxUpside = upside;
      daysToMaxMove = index + 1;
    }
  });

  return {
    daysToMaxMove,
    maxDrawdown: minDrawdown,
    maxUpside
  };
}

function dayReturn(rows, signalIndex) {
  if (signalIndex <= 0) {
    return null;
  }

  return resultPct(rows[signalIndex].close, rows[signalIndex - 1].close);
}

function hasKnownCatalyst(signal, catalyst) {
  return Boolean(catalyst && catalyst.hasKnownCatalyst) ||
    Boolean(signal.catalystType || signal.catalystDate || signal.catalyst || signal.catalystWindow);
}

function scoreSignal({ avgVolume, catalyst, dayMove, dollarVolume, relVol, signal }) {
  const missingData = [];
  const redFlags = [];
  let catalystScore = 0;
  let volumeLiquidityScore = 0;
  let timingScore = 0;
  let riskPenalty = 0;
  const socialScore = Number.isFinite(signal.socialScore) ? Math.max(0, Math.min(10, signal.socialScore)) : 0;
  const portfolioFitScore = 8;
  const catalystType = catalyst && catalyst.hasKnownCatalyst ? catalyst.catalystType : signal.catalystType;

  if (hasKnownCatalyst(signal, catalyst)) {
    catalystScore += 12;
    if ((catalyst && catalyst.catalystDate) || signal.catalystDate || signal.catalystWindow) {
      catalystScore += 6;
    }
    if (/fda|pdufa|phase|readout|earnings|insider|m&a/i.test([
      catalystType,
      signal.signalType,
      signal.notes
    ].filter(Boolean).join(" "))) {
      catalystScore += 5;
    }
  } else {
    missingData.push("historical catalyst");
  }

  catalystScore = Math.min(25, catalystScore);

  if (Number.isFinite(relVol)) {
    if (relVol >= 2) {
      volumeLiquidityScore += 8;
      timingScore += 5;
    } else if (relVol > 1.25) {
      volumeLiquidityScore += 6;
      timingScore += 4;
    } else if (relVol >= 0.75) {
      volumeLiquidityScore += 4;
      timingScore += 2;
    } else {
      volumeLiquidityScore += 1;
      riskPenalty -= 3;
      redFlags.push("RelVol bajo");
    }
  } else {
    missingData.push("relVol");
  }

  if (Number.isFinite(dollarVolume)) {
    if (dollarVolume >= 25000000) {
      volumeLiquidityScore += 8;
      timingScore += 4;
    } else if (dollarVolume >= 10000000) {
      volumeLiquidityScore += 6;
      timingScore += 3;
    } else if (dollarVolume >= 2000000) {
      volumeLiquidityScore += 3;
      timingScore += 1;
    } else {
      riskPenalty -= 5;
      redFlags.push("dollarVolume bajo");
    }
  } else {
    missingData.push("dollarVolume");
  }

  if (Number.isFinite(dayMove)) {
    if (dayMove > 12) {
      riskPenalty -= 4;
      redFlags.push("extended/parabolic dayMove");
    } else if (dayMove >= 2) {
      timingScore += 3;
    } else if (dayMove >= 0) {
      timingScore += 1;
    }
  } else {
    missingData.push("dayMove");
  }

  if (!Number.isFinite(avgVolume)) {
    missingData.push("avgVolume");
  }

  if (/drawdown-from-52w-high/i.test(signal.signalType || "")) {
    riskPenalty -= 2;
    redFlags.push("drawdown setup requiere filtro");
  }

  const totalScore = Math.max(
    0,
    Math.min(100, round(catalystScore + volumeLiquidityScore + timingScore + portfolioFitScore + socialScore + riskPenalty, 1))
  );

  return {
    classification: classify(totalScore, hasKnownCatalyst(signal, catalyst)),
    components: {
      catalystScore,
      portfolioFitScore,
      riskPenalty,
      socialScore,
      timingScore: Math.min(15, timingScore),
      volumeLiquidityScore: Math.min(20, volumeLiquidityScore)
    },
    missingData: [...new Set(missingData)],
    redFlags: [...new Set(redFlags)],
    totalScore
  };
}

function classify(totalScore, hasCatalyst) {
  if (hasCatalyst && totalScore >= 55) {
    return "A_candidate";
  }

  if (totalScore >= 35) {
    return "B_watch";
  }

  if (totalScore >= 20) {
    return "C_research";
  }

  return "discard";
}

function relVolBucket(relVol) {
  if (!Number.isFinite(relVol)) {
    return "missing";
  }

  if (relVol < 0.75) {
    return "<0.75";
  }

  if (relVol <= 1.25) {
    return "0.75-1.25";
  }

  if (relVol < 2) {
    return "1.25-2";
  }

  return ">=2";
}

function dollarVolumeBucket(dollarVolume) {
  if (!Number.isFinite(dollarVolume)) {
    return "missing";
  }

  if (dollarVolume < 2000000) {
    return "<2m";
  }

  if (dollarVolume < 10000000) {
    return "2m-10m";
  }

  if (dollarVolume < 25000000) {
    return "10m-25m";
  }

  return ">=25m";
}

function drawdownBucket(maxDrawdown) {
  if (!Number.isFinite(maxDrawdown)) {
    return "missing";
  }

  if (maxDrawdown <= -30) {
    return "<=-30%";
  }

  if (maxDrawdown <= -15) {
    return "-30%..-15%";
  }

  if (maxDrawdown <= -7) {
    return "-15%..-7%";
  }

  return ">-7%";
}

function trainTestSplit(signalDate) {
  if (signalDate >= TRAIN_START && signalDate <= TRAIN_END) {
    return "train";
  }

  if (signalDate >= TEST_START) {
    return "test";
  }

  return "out_of_range";
}

function normalizeSignal(rawSignal, index) {
  const ticker = String(rawSignal.ticker || "").trim().toUpperCase();
  const signalDate = String(rawSignal.signalDate || rawSignal.date || "").slice(0, 10);

  return {
    ...rawSignal,
    replayId: `${ticker}-${signalDate}-${rawSignal.signalType || "unknown"}-${index}`.toLowerCase(),
    signalDate,
    signalType: rawSignal.signalType || rawSignal.sourceKind || "unknown",
    ticker
  };
}

function replaySignal(signal, priceRows, catalystsByTicker, index) {
  const missingData = [];
  const catalyst = matchCatalyst(signal, catalystsByTicker);

  if (!signal.ticker) {
    missingData.push("ticker");
  }

  if (!signal.signalDate) {
    missingData.push("signalDate");
  }

  if (!priceRows || !priceRows.length) {
    missingData.push("historical price csv");
    return {
      availableDataOnly: true,
      catalystDate: catalyst.catalystDate,
      catalystId: catalyst.catalystId,
      catalystLookaheadSafe: catalyst.catalystLookaheadSafe,
      catalystScore: catalyst.hasKnownCatalyst ? 18 : 0,
      catalystSource: catalyst.catalystSource,
      catalystType: catalyst.catalystType,
      classification: "discard",
      daysToCatalyst: catalyst.daysToCatalyst,
      hasKnownCatalyst: catalyst.hasKnownCatalyst,
      missingData,
      replayId: signal.replayId,
      signalDate: signal.signalDate,
      signalType: signal.signalType,
      ticker: signal.ticker,
      totalScore: 0
    };
  }

  const signalIndex = findIndexByDate(priceRows, signal.signalDate);
  if (signalIndex < 0) {
    missingData.push("price row at signalDate");
    return {
      availableDataOnly: true,
      catalystDate: catalyst.catalystDate,
      catalystId: catalyst.catalystId,
      catalystLookaheadSafe: catalyst.catalystLookaheadSafe,
      catalystScore: catalyst.hasKnownCatalyst ? 18 : 0,
      catalystSource: catalyst.catalystSource,
      catalystType: catalyst.catalystType,
      classification: "discard",
      daysToCatalyst: catalyst.daysToCatalyst,
      hasKnownCatalyst: catalyst.hasKnownCatalyst,
      missingData,
      replayId: signal.replayId,
      signalDate: signal.signalDate,
      signalType: signal.signalType,
      ticker: signal.ticker,
      totalScore: 0
    };
  }

  const priceRow = priceRows[signalIndex];
  const avgVolume = Number.isFinite(signal.details && signal.details.avgVolume20)
    ? signal.details.avgVolume20
    : previousAverageVolume(priceRows, signalIndex);
  const relVol = Number.isFinite(signal.details && signal.details.relativeVolume)
    ? signal.details.relativeVolume
    : Number.isFinite(avgVolume) && avgVolume > 0 ? round(priceRow.volume / avgVolume, 3) : null;
  const dollarVolume = round(priceRow.close * priceRow.volume, 2);
  const move = dayReturn(priceRows, signalIndex);
  const score = scoreSignal({
    avgVolume,
    catalyst,
    dayMove: move,
    dollarVolume,
    relVol,
    signal
  });
  const pathStats = futurePathStats(priceRows, signalIndex, priceRow.close);
  const result = {
    availableDataOnly: true,
    avgVolume,
    catalystDate: catalyst.catalystDate,
    catalystId: catalyst.catalystId,
    catalystLookaheadSafe: catalyst.catalystLookaheadSafe,
    catalystScore: score.components.catalystScore,
    catalystSource: catalyst.catalystSource,
    catalystType: catalyst.catalystType,
    classification: score.classification,
    components: score.components,
    dayMove: move,
    daysToMaxMove: pathStats.daysToMaxMove,
    daysToCatalyst: catalyst.daysToCatalyst,
    dollarVolume,
    expectedCatalystEvent: catalyst.expectedEvent,
    hasKnownCatalyst: catalyst.hasKnownCatalyst,
    maxDrawdown: pathStats.maxDrawdown,
    maxUpside: pathStats.maxUpside,
    missingData: [...new Set([...missingData, ...score.missingData])],
    priceAtSignal: priceRow.close,
    redFlags: score.redFlags,
    relVol,
    replayId: signal.replayId,
    result7d: futureResult(priceRows, signalIndex, priceRow.close, 7),
    result20d: futureResult(priceRows, signalIndex, priceRow.close, 20),
    result30d: futureResult(priceRows, signalIndex, priceRow.close, 30),
    result60d: futureResult(priceRows, signalIndex, priceRow.close, 60),
    result90d: futureResult(priceRows, signalIndex, priceRow.close, 90),
    signalDate: signal.signalDate,
    signalType: signal.signalType,
    sourceKind: signal.sourceKind || "historical-research",
    split: trainTestSplit(signal.signalDate),
    ticker: signal.ticker,
    totalScore: score.totalScore,
    volume: priceRow.volume
  };

  if (index !== undefined) {
    result.sourceIndex = index;
  }

  return result;
}

function payoffRatio(rows) {
  const wins = rows.map((row) => row.result30d).filter((value) => Number.isFinite(value) && value > 0);
  const losses = rows.map((row) => row.result30d).filter((value) => Number.isFinite(value) && value < 0);
  const avgWin = average(wins);
  const avgLoss = average(losses);

  if (avgWin === null || avgLoss === null || avgLoss === 0) {
    return null;
  }

  return round(avgWin / Math.abs(avgLoss), 2);
}

function performanceStats(rows) {
  const completed30 = rows.filter((row) => Number.isFinite(row.result30d));

  return {
    avgMaxDrawdown: average(rows.map((row) => row.maxDrawdown)),
    avgMaxUpside: average(rows.map((row) => row.maxUpside)),
    avgResult20d: average(rows.map((row) => row.result20d)),
    avgResult30d: average(rows.map((row) => row.result30d)),
    avgResult60d: average(rows.map((row) => row.result60d)),
    avgResult7d: average(rows.map((row) => row.result7d)),
    avgResult90d: average(rows.map((row) => row.result90d)),
    count: rows.length,
    completed30: completed30.length,
    payoffRatio30d: payoffRatio(rows),
    winRate30d: percentage(completed30.filter((row) => row.result30d > 0).length, completed30.length)
  };
}

function groupBy(rows, keyFn) {
  const groups = {};

  rows.forEach((row) => {
    const key = keyFn(row);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(row);
  });

  return Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [
    key,
    performanceStats(values)
  ]));
}

function quartiles(rows) {
  const scored = rows.filter((row) => Number.isFinite(row.totalScore)).slice()
    .sort((left, right) => right.totalScore - left.totalScore);
  const size = Math.max(1, Math.floor(scored.length / 4));

  return {
    bottomQuartile: scored.slice(-size),
    topQuartile: scored.slice(0, size)
  };
}

function compareHighLow(rows) {
  const { bottomQuartile, topQuartile } = quartiles(rows);
  const top = performanceStats(topQuartile);
  const bottom = performanceStats(bottomQuartile);

  return {
    bottomQuartile: bottom,
    edge: {
      avgResult30dSpread: top.avgResult30d !== null && bottom.avgResult30d !== null
        ? round(top.avgResult30d - bottom.avgResult30d, 2)
        : null,
      maxDrawdownImproved: top.avgMaxDrawdown !== null && bottom.avgMaxDrawdown !== null
        ? top.avgMaxDrawdown > bottom.avgMaxDrawdown
        : null,
      payoffRatioImproved: top.payoffRatio30d !== null && bottom.payoffRatio30d !== null
        ? top.payoffRatio30d > bottom.payoffRatio30d
        : null,
      topBeatsBottom: top.avgResult30d !== null && bottom.avgResult30d !== null
        ? top.avgResult30d > bottom.avgResult30d
        : null,
      winRateImproved: top.winRate30d !== null && bottom.winRate30d !== null
        ? top.winRate30d > bottom.winRate30d
        : null
    },
    topQuartile: top
  };
}

function compareAWithBC(rows) {
  const aRows = rows.filter((row) => row.classification === "A_candidate");
  const bcRows = rows.filter((row) => ["B_watch", "C_research"].includes(row.classification));
  const aStats = performanceStats(aRows);
  const bcStats = performanceStats(bcRows);

  return {
    aCandidate: aStats,
    bAndC: bcStats,
    edge: {
      aBeatsBC: aStats.avgResult30d !== null && bcStats.avgResult30d !== null
        ? aStats.avgResult30d > bcStats.avgResult30d
        : null,
      avgResult30dSpread: aStats.avgResult30d !== null && bcStats.avgResult30d !== null
        ? round(aStats.avgResult30d - bcStats.avgResult30d, 2)
        : null
    }
  };
}

function buildPerformance(rows) {
  return {
    byCatalystPresence: groupBy(rows, (row) => row.hasKnownCatalyst ? "with_catalyst" : "without_catalyst"),
    byCatalystType: groupBy(rows.filter((row) => row.hasKnownCatalyst), (row) => row.catalystType || "unknown"),
    byClassification: groupBy(rows, (row) => row.classification || "missing"),
    byDollarVolumeBucket: groupBy(rows, (row) => dollarVolumeBucket(row.dollarVolume)),
    byDrawdownBucket: groupBy(rows, (row) => drawdownBucket(row.maxDrawdown)),
    byRelVolBucket: groupBy(rows, (row) => relVolBucket(row.relVol)),
    bySignalType: groupBy(rows, (row) => row.signalType || "unknown"),
    highVsLowScore: compareHighLow(rows),
    overall: performanceStats(rows),
    scoreCategoryEdge: compareAWithBC(rows)
  };
}

function edgeVerdict(edge) {
  const positives = [
    edge.highVsLowScore.edge.topBeatsBottom,
    edge.highVsLowScore.edge.maxDrawdownImproved,
    edge.highVsLowScore.edge.winRateImproved,
    edge.highVsLowScore.edge.payoffRatioImproved,
    edge.scoreCategoryEdge.edge.aBeatsBC
  ].filter((value) => value === true).length;
  const known = [
    edge.highVsLowScore.edge.topBeatsBottom,
    edge.highVsLowScore.edge.maxDrawdownImproved,
    edge.highVsLowScore.edge.winRateImproved,
    edge.highVsLowScore.edge.payoffRatioImproved,
    edge.scoreCategoryEdge.edge.aBeatsBC
  ].filter((value) => value !== null).length;

  if (known === 0) {
    return "missingData: no hay muestra suficiente para afirmar edge.";
  }

  if (positives >= 3) {
    return "WALY score muestra edge inicial, pendiente de out-of-sample mas estricto.";
  }

  if (positives >= 1) {
    return "WALY score muestra edge mixto; usar solo como filtro de research.";
  }

  return "WALY score no demuestra edge con esta muestra local.";
}

function falsePositives(rows) {
  return rows
    .filter((row) => row.totalScore >= 35 && Number.isFinite(row.result30d) && row.result30d < -10)
    .sort((left, right) => left.result30d - right.result30d)
    .slice(0, 15);
}

function falseNegatives(rows) {
  return rows
    .filter((row) => row.totalScore < 35 && Number.isFinite(row.result30d) && row.result30d > 20)
    .sort((left, right) => right.result30d - left.result30d)
    .slice(0, 15);
}

function topSignals(rows) {
  return rows
    .filter((row) => Number.isFinite(row.result30d))
    .slice()
    .sort((left, right) => right.totalScore - left.totalScore || right.result30d - left.result30d)
    .slice(0, 25);
}

function renderStats(stats) {
  return [
    `count ${stats.count}`,
    `avg30 ${stats.avgResult30d === null ? "n/d" : `${stats.avgResult30d}%`}`,
    `win30 ${stats.winRate30d === null ? "n/d" : `${stats.winRate30d}%`}`,
    `dd ${stats.avgMaxDrawdown === null ? "n/d" : `${stats.avgMaxDrawdown}%`}`,
    `payoff ${stats.payoffRatio30d === null ? "n/d" : stats.payoffRatio30d}`
  ].join(" | ");
}

function renderTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function renderGroupedPerformance(groups) {
  return renderTable(
    ["Grupo", "Count", "Avg 30d", "Win 30d", "Avg DD", "Payoff"],
    Object.entries(groups).map(([key, stats]) => [
      key,
      stats.count,
      stats.avgResult30d === null ? "n/d" : `${stats.avgResult30d}%`,
      stats.winRate30d === null ? "n/d" : `${stats.winRate30d}%`,
      stats.avgMaxDrawdown === null ? "n/d" : `${stats.avgMaxDrawdown}%`,
      stats.payoffRatio30d === null ? "n/d" : stats.payoffRatio30d
    ])
  );
}

function renderSummary(payload) {
  const train = payload.trainTest.train.performance;
  const test = payload.trainTest.test.performance;
  const lines = [];

  lines.push("# WALY Historical Replay Engine v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: research-only. No opera, no usa IBKR, no usa Binance, no envia ordenes y no usa red.");
  lines.push("");
  lines.push("## Cantidad de senales evaluadas");
  lines.push(`- Evaluadas: ${payload.summary.evaluatedSignals}`);
  lines.push(`- Input signals: ${payload.summary.inputSignals}`);
  lines.push(`- Con catalyst historico valido: ${payload.summary.signalsWithCatalyst}`);
  lines.push(`- Sin catalyst historico valido: ${payload.summary.signalsWithoutCatalyst}`);
  lines.push(`- Missing data rows: ${payload.summary.rowsWithMissingData}`);
  lines.push("");
  lines.push("## Train results");
  lines.push(`- ${renderStats(train.overall)}`);
  lines.push(`- Score alto vs bajo: ${train.highVsLowScore.edge.topBeatsBottom === null ? "n/d" : train.highVsLowScore.edge.topBeatsBottom ? "score alto supera score bajo" : "score alto no supera score bajo"}`);
  lines.push("");
  lines.push("## Test results");
  lines.push(`- ${renderStats(test.overall)}`);
  lines.push(`- Score alto vs bajo: ${test.highVsLowScore.edge.topBeatsBottom === null ? "n/d" : test.highVsLowScore.edge.topBeatsBottom ? "score alto supera score bajo" : "score alto no supera score bajo"}`);
  lines.push("");
  lines.push("## Ranking por score");
  lines.push(renderTable(
    ["Ticker", "Fecha", "Tipo", "Score", "Clase", "30d", "DD", "Missing"],
    payload.topSignals.slice(0, 15).map((row) => [
      row.ticker,
      row.signalDate,
      row.signalType,
      row.totalScore,
      row.classification,
      row.result30d === null ? "n/d" : `${row.result30d}%`,
      row.maxDrawdown === null ? "n/d" : `${row.maxDrawdown}%`,
      row.missingData.join("; ") || "ninguna"
    ])
  ));
  lines.push("");
  lines.push("## Performance por categoria");
  lines.push(renderGroupedPerformance(payload.performance.byClassification));
  lines.push("");
  lines.push("## Performance catalyst vs no catalyst");
  lines.push(renderGroupedPerformance(payload.performance.byCatalystPresence));
  lines.push("");
  lines.push("## Performance por tipo de catalyst");
  lines.push(Object.keys(payload.performance.byCatalystType).length
    ? renderGroupedPerformance(payload.performance.byCatalystType)
    : "- Sin senales con catalyst historico valido.");
  lines.push("");
  lines.push("## Performance por tipo de senal");
  lines.push(renderGroupedPerformance(payload.performance.bySignalType));
  lines.push("");
  lines.push("## WALY score agrega edge");
  lines.push(`- Verdict: ${payload.edge.verdict}`);
  lines.push(`- Top quartile vs bottom spread 30d: ${payload.performance.highVsLowScore.edge.avgResult30dSpread === null ? "n/d" : `${payload.performance.highVsLowScore.edge.avgResult30dSpread}%`}`);
  lines.push(`- A_candidate vs B/C spread 30d: ${payload.performance.scoreCategoryEdge.edge.avgResult30dSpread === null ? "n/d" : `${payload.performance.scoreCategoryEdge.edge.avgResult30dSpread}%`}`);
  lines.push(`- Reduce drawdown: ${payload.performance.highVsLowScore.edge.maxDrawdownImproved === null ? "n/d" : payload.performance.highVsLowScore.edge.maxDrawdownImproved ? "si" : "no"}`);
  lines.push(`- Mejora win rate: ${payload.performance.highVsLowScore.edge.winRateImproved === null ? "n/d" : payload.performance.highVsLowScore.edge.winRateImproved ? "si" : "no"}`);
  lines.push(`- Mejora payoff ratio: ${payload.performance.highVsLowScore.edge.payoffRatioImproved === null ? "n/d" : payload.performance.highVsLowScore.edge.payoffRatioImproved ? "si" : "no"}`);
  lines.push("");
  lines.push("## Principales falsos positivos");
  lines.push(payload.falsePositives.length ? payload.falsePositives.slice(0, 10).map((row) => `- ${row.ticker} ${row.signalDate} ${row.signalType}: score ${row.totalScore}, 30d ${row.result30d}%`).join("\n") : "- Ninguno con regla actual.");
  lines.push("");
  lines.push("## Principales falsos negativos");
  lines.push(payload.falseNegatives.length ? payload.falseNegatives.slice(0, 10).map((row) => `- ${row.ticker} ${row.signalDate} ${row.signalType}: score ${row.totalScore}, 30d ${row.result30d}%`).join("\n") : "- Ninguno con regla actual.");
  lines.push("");
  lines.push("## Reglas que deben ajustarse");
  payload.rulesToAdjust.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Advertencia de limitaciones historicas");
  payload.limitations.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Confirmacion");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function renderSignalMarkdown(title, rows) {
  const lines = [title, ""];

  if (!rows.length) {
    lines.push("- Sin filas.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(renderTable(
    ["Ticker", "Fecha", "Tipo", "Score", "Clase", "7d", "30d", "90d", "DD", "Upside", "Flags"],
    rows.map((row) => [
      row.ticker,
      row.signalDate,
      row.signalType,
      row.totalScore,
      row.classification,
      row.result7d === null ? "n/d" : `${row.result7d}%`,
      row.result30d === null ? "n/d" : `${row.result30d}%`,
      row.result90d === null ? "n/d" : `${row.result90d}%`,
      row.maxDrawdown === null ? "n/d" : `${row.maxDrawdown}%`,
      row.maxUpside === null ? "n/d" : `${row.maxUpside}%`,
      row.redFlags.join("; ") || "ninguna"
    ])
  ));

  return `${lines.join("\n")}\n`;
}

function rulesToAdjust(payload) {
  const rules = [];

  if (payload.performance.highVsLowScore.edge.topBeatsBottom === false) {
    rules.push("Revisar pesos del score: top quartile no supera bottom quartile en 30d.");
  }

  if (payload.performance.scoreCategoryEdge.aCandidate.count === 0) {
    rules.push("No hay A_candidate historicos con data local; falta catalyst historico explicito antes de validar esa clase.");
  } else if (payload.performance.scoreCategoryEdge.edge.aBeatsBC === false) {
    rules.push("A_candidate no supera B/C; endurecer thresholds de catalyst, liquidez o timing.");
  }

  if ((payload.performance.byRelVolBucket["<0.75"] || {}).avgResult30d > (payload.performance.byRelVolBucket[">=2"] || {}).avgResult30d) {
    rules.push("RelVol alto no domina la muestra; revisar penalizacion de RelVol bajo antes de usarlo como gate duro.");
  }

  if (!rules.length) {
    rules.push("Mantener score como research-only y exigir out-of-sample antes de convertirlo en gate operativo.");
  }

  return rules;
}

function buildPayload() {
  const prices = loadPriceHistory();
  const signalInput = loadSignals();
  const catalysts = loadCatalysts();
  const parameterSweep = readJsonIfExists(PARAMETER_SWEEP_PATH);
  const signalTypeAnalysis = readJsonIfExists(SIGNAL_TYPE_ANALYSIS_PATH);
  const v32Results = readJsonIfExists(V32_RESULTS_PATH);
  const trainTestEngine = readJsonIfExists(TRAIN_TEST_ENGINE_PATH);
  const missingData = [...prices.missingData];
  const signals = signalInput.signals.map(normalizeSignal);

  if (!signalInput.signals.length) {
    missingData.push("historical signals");
  }

  if (!parameterSweep) {
    missingData.push(formatRelative(PARAMETER_SWEEP_PATH));
  }

  if (!signalTypeAnalysis) {
    missingData.push(formatRelative(SIGNAL_TYPE_ANALYSIS_PATH));
  }

  if (!v32Results) {
    missingData.push(formatRelative(V32_RESULTS_PATH));
  }

  if (!trainTestEngine) {
    missingData.push(formatRelative(TRAIN_TEST_ENGINE_PATH));
  }

  const replayRows = signals.map((signal, index) =>
    replaySignal(signal, prices.byTicker.get(signal.ticker), catalysts.byTicker, index)
  );
  const evaluatedRows = replayRows.filter((row) =>
    Number.isFinite(row.priceAtSignal) &&
    ["train", "test"].includes(row.split)
  );
  const trainRows = evaluatedRows.filter((row) => row.split === "train");
  const testRows = evaluatedRows.filter((row) => row.split === "test");
  const performance = buildPerformance(evaluatedRows);
  const trainPerformance = buildPerformance(trainRows);
  const testPerformance = buildPerformance(testRows);
  const positives = falsePositives(evaluatedRows);
  const negatives = falseNegatives(evaluatedRows);
  const payload = {
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No usa red.",
      "No modifica positions.",
      "No modifica outcomes.",
      "No modifica data/*.json ni data/social_signals.json.",
      "Output solo en backtests/historical-replay/.",
      "No commit.",
      "No push."
    ],
    edge: {
      verdict: edgeVerdict(performance)
    },
    falseNegatives: negatives,
    falsePositives: positives,
    generatedAt: new Date().toISOString(),
    inputs: {
      historicalCatalysts: catalysts.source,
      historicalCatalystsCount: catalysts.rows.length,
      generatedSignals: signalInput.source,
      parameterSweep: parameterSweep ? formatRelative(PARAMETER_SWEEP_PATH) : null,
      priceCsvDir: fs.existsSync(RESEARCH_PRICE_DIR) ? formatRelative(RESEARCH_PRICE_DIR) : null,
      priceCsvFiles: prices.files.length,
      signalTypeAnalysis: signalTypeAnalysis ? formatRelative(SIGNAL_TYPE_ANALYSIS_PATH) : null,
      trainTestEngine: trainTestEngine ? formatRelative(TRAIN_TEST_ENGINE_PATH) : null,
      usedExampleFallback: signalInput.usedFallback,
      v32Results: v32Results ? formatRelative(V32_RESULTS_PATH) : null
    },
    limitations: [
      "El score historico usa proxies diarios, no intradia.",
      "CatalystScore solo suma si el catalyst estaba explicitamente en la senal historica.",
      "SocialScore queda en 0 salvo dato historico explicito.",
      "PortfolioFit es neutral porque no hay cartera historica punto-en-tiempo.",
      "Resultados futuros se calculan despues del score y no alimentan la decision.",
      "Los CSV locales determinan la cobertura; faltantes quedan como missingData."
    ],
    missingData: [...new Set([
      ...missingData,
      ...replayRows.flatMap((row) => (row.missingData || []).map((item) => `${row.ticker || "n/d"} ${row.signalDate || "n/d"}: ${item}`))
    ])],
    mode: "research-only-no-lookahead",
    performance,
    replayRows,
    summary: {
      evaluatedSignals: evaluatedRows.length,
      signalsWithCatalyst: evaluatedRows.filter((row) => row.hasKnownCatalyst).length,
      signalsWithoutCatalyst: evaluatedRows.filter((row) => !row.hasKnownCatalyst).length,
      inputSignals: signals.length,
      rowsWithMissingData: replayRows.filter((row) => row.missingData && row.missingData.length > 0).length,
      testSignals: testRows.length,
      trainSignals: trainRows.length
    },
    topSignals: topSignals(evaluatedRows),
    trainTest: {
      ranges: {
        test: `${TEST_START}..latest available`,
        train: `${TRAIN_START}..${TRAIN_END}`
      },
      test: {
        performance: testPerformance,
        rows: testRows.length
      },
      train: {
        performance: trainPerformance,
        rows: trainRows.length
      }
    }
  };

  payload.rulesToAdjust = rulesToAdjust(payload);

  return payload;
}

function writeOutputs(payload) {
  const resultsPath = writeReplayJson("results.json", payload);
  const trainTestSummaryPath = writeReplayJson("train-test-summary.json", {
    edge: payload.edge,
    generatedAt: payload.generatedAt,
    summary: payload.summary,
    test: payload.trainTest.test,
    train: payload.trainTest.train
  });
  const summaryPath = writeReplayFile("summary.md", renderSummary(payload));
  const finalTopSignalsPath = writeReplayFile("top-signals.md", renderSignalMarkdown("# Top Historical Replay Signals", payload.topSignals));
  const failureCasesPath = writeReplayFile(
    "failure-cases.md",
    [
      renderSignalMarkdown("# False Positives", payload.falsePositives),
      renderSignalMarkdown("# False Negatives", payload.falseNegatives)
    ].join("\n")
  );

  return {
    failureCasesPath,
    resultsPath,
    summaryPath,
    topSignalsPath: finalTopSignalsPath,
    trainTestSummaryPath
  };
}

function renderConsoleReport(payload, paths) {
  const highLow = payload.performance.highVsLowScore.edge;
  const aVsBc = payload.performance.scoreCategoryEdge.edge;

  return [
    "WALY Historical Replay Engine v1 generado.",
    `Signals evaluadas: ${payload.summary.evaluatedSignals} / input ${payload.summary.inputSignals}`,
    `Catalyst validos: ${payload.summary.signalsWithCatalyst} | sin catalyst=${payload.summary.signalsWithoutCatalyst}`,
    `Train: ${renderStats(payload.trainTest.train.performance.overall)}`,
    `Test: ${renderStats(payload.trainTest.test.performance.overall)}`,
    `Score alto supera score bajo: ${highLow.topBeatsBottom === null ? "n/d" : highLow.topBeatsBottom ? "si" : "no"}`,
    `A_candidate supera B/C: ${aVsBc.aBeatsBC === null ? "n/d" : aVsBc.aBeatsBC ? "si" : "no"}`,
    `Verdict: ${payload.edge.verdict}`,
    `results.json: ${formatRelative(paths.resultsPath)}`,
    `summary.md: ${formatRelative(paths.summaryPath)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no red, no commit, no push."
  ].join("\n");
}

function runHistoricalReplayEngine(options = {}) {
  const payload = buildPayload();
  let paths = {
    failureCasesPath: null,
    resultsPath: null,
    summaryPath: null,
    topSignalsPath: null,
    trainTestSummaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = writeOutputs(payload);
  }

  return {
    ...payload,
    consoleReport: renderConsoleReport(payload, paths),
    paths
  };
}

module.exports = {
  buildPayload,
  runHistoricalReplayEngine
};
