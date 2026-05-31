"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, DATA_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "biotech-binary-failure-lab");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const HISTORICAL_CATALYSTS_PATH = path.join(DATA_DIR, "historical_catalysts.json");
const OUTCOMES_PATH = path.join(DATA_DIR, "outcomes.json");
const DAILY_LOG_PATH = path.join(DATA_DIR, "daily_log.json");
const EXAMPLE_EVENTS_PATH = path.join(EXAMPLES_DIR, "biotech-binary-events.example.json");

const OUTCOMES = new Set([
  "approval",
  "crl",
  "delay",
  "failed_primary_endpoint",
  "mixed_data",
  "label_issue",
  "financing_dilution",
  "unknown"
]);
const THESIS_STATES = new Set(["intact", "impaired", "broken", "unknown"]);
const STRATEGY_NAMES = [
  "long_runup_exit_before_event",
  "short_all_through_event",
  "short_high_runup_through_event",
  "short_weak_binary_profile",
  "post_failure_continuation_short",
  "approval_sell_the_news",
  "no_trade_binary_filter"
];
const BINARY_TYPES = new Set([
  "phase2",
  "phase2_topline",
  "phase3",
  "phase3_topline",
  "PDUFA",
  "pdufa",
  "FDA",
  "FDA_decision",
  "fda",
  "crl",
  "trial_failure",
  "approval"
]);

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("biotech-binary-failure-lab solo puede escribir dentro de backtests/biotech-binary-failure-lab/.");
  }
}

function writeJson(filePath, value) {
  assertOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writeText(filePath, value) {
  assertOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
  return filePath;
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
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

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function numberOrNull(value) {
  if (isFiniteNumber(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.replace(/[$,%]/g, "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  return values.map(numberOrNull).find((value) => isFiniteNumber(value));
}

function firstText(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim().length > 0);
  return value ? value.trim() : null;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isLookaheadSafe(event) {
  return (
    validDate(event.knownFromDate) &&
    validDate(event.signalDate) &&
    validDate(event.eventDate) &&
    event.knownFromDate <= event.signalDate &&
    event.signalDate <= event.eventDate
  );
}

function normalizeOutcome(value) {
  const text = String(value || "unknown").trim();
  return OUTCOMES.has(text) ? text : "unknown";
}

function normalizeThesis(value) {
  const text = String(value || "unknown").trim();
  return THESIS_STATES.has(text) ? text : "unknown";
}

function normalizeCatalystType(value) {
  const text = String(value || "").trim();
  if (/phase\s*3|phase3/i.test(text)) {
    return "phase3_topline";
  }
  if (/phase\s*2|phase2/i.test(text)) {
    return "phase2_topline";
  }
  if (/pdufa/i.test(text)) {
    return "PDUFA";
  }
  if (/fda|approval|crl/i.test(text)) {
    return "FDA_decision";
  }
  return text || "unknown";
}

function isBinaryCatalyst(event) {
  const type = normalizeCatalystType(event.catalystType);
  const text = `${type} ${event.binaryType || ""} ${event.outcome || ""}`.toLowerCase();

  return BINARY_TYPES.has(type) || /phase|pdufa|fda|crl|clinical|readout|approval|trial/.test(text);
}

function runup30d(event) {
  if (isFiniteNumber(event.hasRunup30d)) {
    return event.hasRunup30d;
  }

  const start = numberOrNull(event.priceT30);
  const end = firstNumber(event.priceT1, event.priceT2, event.priceT5);

  return start && end ? round(((end / start) - 1) * 100, 2) : null;
}

function normalizeEvent(raw, source, index) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const ticker = normalizeTicker(raw.ticker);
  if (!ticker) {
    return null;
  }

  const eventDate = firstText(raw.eventDate, raw.catalystDate, raw.resolvedAt, raw.date);
  const signalDate = firstText(raw.signalDate, raw.knownFromDate, raw.loggedAt, raw.date, eventDate);
  const knownFromDate = firstText(raw.knownFromDate, raw.signalDate, raw.loggedAt, raw.date, signalDate);
  const catalystType = normalizeCatalystType(firstText(raw.catalystType, raw.type, raw.metadata && raw.metadata.catalystType));
  const event = {
    asset: firstText(raw.asset, raw.drug, raw.product) || null,
    binaryType: firstText(raw.binaryType) || null,
    cashRunwayMonths: numberOrNull(raw.cashRunwayMonths),
    catalystType,
    company: firstText(raw.company, raw.companyName, raw.metadata && raw.metadata.companyName) || null,
    eventDate,
    hasRecentOffering: raw.hasRecentOffering === true,
    hasRunup30d: numberOrNull(raw.hasRunup30d),
    indication: firstText(raw.indication) || null,
    knownFromDate,
    marketCapAtSignal: numberOrNull(raw.marketCapAtSignal),
    noRevenueOrProfitabilitySignificant: typeof raw.noRevenueOrProfitabilitySignificant === "boolean"
      ? raw.noRevenueOrProfitabilitySignificant
      : null,
    notes: firstText(raw.notes, raw.why, raw.lessons) || null,
    outcome: normalizeOutcome(firstText(raw.outcome, raw.actualOutcome)),
    priceAtEventClose: firstNumber(raw.priceAtEventClose, raw.priceAtEvent, raw.priceAfter),
    priceD1: firstNumber(raw.priceD1),
    priceD5: firstNumber(raw.priceD5, raw.priceAfter7d),
    priceD20: firstNumber(raw.priceD20, raw.priceAfter30d),
    priceT1: firstNumber(raw.priceT1, raw.priceBefore),
    priceT2: firstNumber(raw.priceT2),
    priceT5: firstNumber(raw.priceT5),
    priceT10: firstNumber(raw.priceT10),
    priceT30: firstNumber(raw.priceT30, raw.entryPrice),
    signalDate,
    singleAssetDependency: raw.singleAssetDependency === true,
    source,
    sourceIndex: index,
    thesisAfterEvent: normalizeThesis(firstText(raw.thesisAfterEvent)),
    ticker
  };

  event.runup30d = runup30d(event);
  event.lookaheadSafe = isLookaheadSafe(event);
  event.isBinaryCatalyst = isBinaryCatalyst(event);
  event.missingData = [
    !event.lookaheadSafe ? "knownFromDate/signalDate/eventDate" : null,
    !isFiniteNumber(event.priceT30) ? "priceT30" : null,
    !isFiniteNumber(firstNumber(event.priceT1, event.priceT2)) ? "priceT1_or_T2" : null,
    !isFiniteNumber(event.priceD1) ? "priceD1" : null,
    event.outcome === "unknown" ? "outcome" : null,
    event.thesisAfterEvent === "unknown" ? "thesisAfterEvent" : null
  ].filter(Boolean);

  return event;
}

function normalizeHistoricalCatalysts(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : (payload && (payload.events || payload.catalysts)) || [];

  return rows.map((row, index) => normalizeEvent(row, "data/historical_catalysts.json", index)).filter(Boolean);
}

function normalizeOutcomes(payload) {
  const rows = payload && payload.outcomes || [];

  return rows.map((row, index) => normalizeEvent(row, "data/outcomes.json", index)).filter(Boolean);
}

function normalizeDailyLog(payload) {
  const entries = payload && payload.entries || [];
  const rows = [];

  entries.forEach((entry, entryIndex) => {
    const watchlist = entry && entry.stateSnapshot && entry.stateSnapshot.watchlist || [];
    watchlist.forEach((item, itemIndex) => {
      const catalystText = `${item.catalyst || ""} ${item.catalystWindow || ""}`;
      if (!/phase|pdufa|fda|crl|readout|topline|clinical/i.test(catalystText)) {
        return;
      }

      rows.push(normalizeEvent({
        catalystType: item.catalystType || item.catalyst,
        eventDate: item.catalystDate || item.catalystWindow,
        knownFromDate: entry.date,
        notes: item.catalyst || item.thesis,
        signalDate: entry.date,
        ticker: item.ticker
      }, "data/daily_log.json", `${entryIndex}.${itemIndex}`));
    });
  });

  return rows.filter(Boolean);
}

function normalizeExampleEvents(payload) {
  const rows = payload && (payload.events || payload.catalysts) || [];
  return rows.map((row, index) => normalizeEvent(row, "examples/biotech-binary-events.example.json", index)).filter(Boolean);
}

function readEvents() {
  const historicalCatalysts = readJsonIfExists(HISTORICAL_CATALYSTS_PATH);
  const outcomes = readJsonIfExists(OUTCOMES_PATH);
  const dailyLog = readJsonIfExists(DAILY_LOG_PATH);
  const exampleEvents = readJsonIfExists(EXAMPLE_EVENTS_PATH);
  const events = [
    ...normalizeHistoricalCatalysts(historicalCatalysts),
    ...normalizeOutcomes(outcomes),
    ...normalizeDailyLog(dailyLog),
    ...normalizeExampleEvents(exampleEvents)
  ];

  return {
    events,
    sources: {
      dailyLog: dailyLog ? formatRelative(DAILY_LOG_PATH) : null,
      exampleEvents: exampleEvents ? formatRelative(EXAMPLE_EVENTS_PATH) : null,
      historicalCatalysts: historicalCatalysts ? formatRelative(HISTORICAL_CATALYSTS_PATH) : null,
      outcomes: outcomes ? formatRelative(OUTCOMES_PATH) : null
    }
  };
}

function pctReturnLong(entry, exit) {
  return entry && exit ? round(((exit / entry) - 1) * 100, 2) : null;
}

function pctReturnShort(entry, exit) {
  return entry && exit ? round(((entry - exit) / entry) * 100, 2) : null;
}

function shortAdverse(entry, ...prices) {
  const adverse = prices
    .filter(isFiniteNumber)
    .map((price) => ((price / entry) - 1) * 100)
    .filter((value) => value > 0);

  return adverse.length ? round(Math.max(...adverse), 2) : 0;
}

function addTrade(trades, strategy, event, entry, exit, returnPct, extra = {}) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(exit) || !isFiniteNumber(returnPct)) {
    return;
  }

  trades.push({
    entry,
    eventDate: event.eventDate,
    exit,
    outcome: event.outcome,
    returnPct,
    strategy,
    thesisAfterEvent: event.thesisAfterEvent,
    ticker: event.ticker,
    variant: extra.variant || null,
    worstAdverseMove: isFiniteNumber(extra.worstAdverseMove) ? round(extra.worstAdverseMove, 2) : 0
  });
}

function weakBinaryProfile(event) {
  const weakCash = !isFiniteNumber(event.cashRunwayMonths) || event.cashRunwayMonths < 12;
  const smallCap = !isFiniteNumber(event.marketCapAtSignal) || event.marketCapAtSignal < 2000000000;
  const validType = /phase2|phase3|pdufa|fda/i.test(event.catalystType);
  const revenueWeak = event.noRevenueOrProfitabilitySignificant !== false;

  return event.singleAssetDependency && weakCash && smallCap && validType && revenueWeak;
}

function buildTrades(events) {
  const trades = [];

  events.forEach((event) => {
    const preShortEntry = firstNumber(event.priceT1, event.priceT2);
    const preLongEntry = firstNumber(event.priceT30, event.priceT10, event.priceT5);
    const preLongExit = firstNumber(event.priceT5, event.priceT2, event.priceT1);
    const preShortExit = firstNumber(event.priceD1, event.priceAtEventClose);
    const runup = event.runup30d;

    addTrade(
      trades,
      "long_runup_exit_before_event",
      event,
      preLongEntry,
      preLongExit,
      pctReturnLong(preLongEntry, preLongExit),
      { variant: "exit_before_event" }
    );
    addTrade(
      trades,
      "short_all_through_event",
      event,
      preShortEntry,
      preShortExit,
      pctReturnShort(preShortEntry, preShortExit),
      { worstAdverseMove: shortAdverse(preShortEntry, event.priceAtEventClose, event.priceD1) }
    );

    if (isFiniteNumber(runup) && runup > 30) {
      addTrade(
        trades,
        "short_high_runup_through_event",
        event,
        preShortEntry,
        preShortExit,
        pctReturnShort(preShortEntry, preShortExit),
        { variant: runup > 50 ? "runup_gt_50" : "runup_gt_30", worstAdverseMove: shortAdverse(preShortEntry, event.priceAtEventClose, event.priceD1) }
      );
    }

    if (weakBinaryProfile(event)) {
      addTrade(
        trades,
        "short_weak_binary_profile",
        event,
        preShortEntry,
        preShortExit,
        pctReturnShort(preShortEntry, preShortExit),
        { worstAdverseMove: shortAdverse(preShortEntry, event.priceAtEventClose, event.priceD1) }
      );
    }

    if (event.thesisAfterEvent === "broken" || event.outcome === "failed_primary_endpoint" || event.outcome === "crl") {
      const exit = firstNumber(event.priceD20, event.priceD5);
      addTrade(
        trades,
        "post_failure_continuation_short",
        event,
        event.priceD1,
        exit,
        pctReturnShort(event.priceD1, exit),
        { variant: isFiniteNumber(event.priceD20) ? "D20" : "D5", worstAdverseMove: shortAdverse(event.priceD1, event.priceD5, event.priceD20) }
      );
    }

    if (event.outcome === "approval" && isFiniteNumber(runup) && runup > 30) {
      const exit = firstNumber(event.priceD20, event.priceD5);
      addTrade(
        trades,
        "approval_sell_the_news",
        event,
        event.priceD1,
        exit,
        pctReturnShort(event.priceD1, exit),
        { variant: isFiniteNumber(event.priceD20) ? "D20" : "D5", worstAdverseMove: shortAdverse(event.priceD1, event.priceD5, event.priceD20) }
      );
    }

    const holdReturn = pctReturnLong(preShortEntry, preShortExit);
    addTrade(
      trades,
      "no_trade_binary_filter",
      event,
      preShortEntry,
      preShortExit,
      isFiniteNumber(holdReturn) ? round(-holdReturn, 2) : null,
      { variant: "avoided_T1_to_D1_hold" }
    );
  });

  return trades;
}

function average(values) {
  const clean = values.filter(isFiniteNumber);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter(isFiniteNumber).sort((left, right) => left - right);
  if (!clean.length) {
    return null;
  }

  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function percentage(count, total) {
  return total ? round((count / total) * 100, 1) : null;
}

function payoffRatio(returns) {
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const avgWin = average(wins);
  const avgLoss = average(losses.map(Math.abs));

  return avgWin && avgLoss ? round(avgWin / avgLoss, 2) : null;
}

function outlierDependent(returns) {
  const gains = returns.filter((value) => value > 0).sort((left, right) => right - left);
  const total = gains.reduce((sum, value) => sum + value, 0);
  const topTwo = gains.slice(0, 2).reduce((sum, value) => sum + value, 0);

  return gains.length > 2 && total > 0 && topTwo / total >= 0.8;
}

function splitTrainTest(trades) {
  const sorted = [...trades].sort((left, right) => left.eventDate.localeCompare(right.eventDate));
  const split = Math.max(1, Math.floor(sorted.length / 2));

  return {
    test: sorted.slice(split),
    train: sorted.slice(0, split)
  };
}

function avgReturnFor(trades) {
  return round(average(trades.map((trade) => trade.returnPct)), 2);
}

function classifyEdge({ avgReturn, maxLoss, outlierRisk, sampleSize, strategy, testResult, trainResult }) {
  if (sampleSize < 30) {
    return "INSUFFICIENT_SAMPLE";
  }

  if (outlierRisk || !isFiniteNumber(avgReturn) || avgReturn <= 0) {
    return "EDGE_INVALID";
  }

  if (isFiniteNumber(trainResult) && isFiniteNumber(testResult) && Math.sign(trainResult) !== Math.sign(testResult)) {
    return "EDGE_INVALID";
  }

  if (strategy === "short_all_through_event" && isFiniteNumber(maxLoss) && maxLoss <= -50) {
    return "EDGE_WEAK";
  }

  return sampleSize >= 100 ? "EDGE_VALID" : "EDGE_WEAK";
}

function summarizeStrategy(strategy, trades) {
  const returns = trades.map((trade) => trade.returnPct).filter(isFiniteNumber);
  const split = splitTrainTest(trades);
  const trainResult = avgReturnFor(split.train);
  const testResult = avgReturnFor(split.test);
  const sampleSize = returns.length;
  const maxLoss = returns.length ? round(Math.min(...returns), 2) : null;
  const outlierRisk = outlierDependent(returns);
  const dangerous = strategy === "short_all_through_event" && isFiniteNumber(maxLoss) && maxLoss <= -50;
  const avgReturn = round(average(returns), 2);

  return {
    avgDrawdown: round(average(trades.map((trade) => trade.worstAdverseMove)), 2),
    avgReturn,
    edgeStatus: classifyEdge({ avgReturn, maxLoss, outlierRisk, sampleSize, strategy, testResult, trainResult }),
    maxGain: returns.length ? round(Math.max(...returns), 2) : null,
    maxLoss,
    medianReturn: round(median(returns), 2),
    notes: [
      sampleSize < 30 ? "sample < 30: lectura preliminar no permitida" : null,
      sampleSize < 100 ? "sample < 100: lectura fuerte no permitida" : null,
      outlierRisk ? "no declarar edge: depende de 1-2 outliers" : null,
      dangerous ? "DANGEROUS_EVEN_IF_AVG_POSITIVE" : null
    ].filter(Boolean),
    payoffRatio: payoffRatio(returns),
    positiveEV: isFiniteNumber(avgReturn) && avgReturn > 0,
    sampleSize,
    strategy,
    testResult,
    trainResult,
    trades: trades.slice(0, 20),
    winRate: percentage(returns.filter((value) => value > 0).length, sampleSize),
    worstAdverseMove: trades.length ? round(Math.max(...trades.map((trade) => trade.worstAdverseMove || 0)), 2) : null
  };
}

function riskAdjustedScore(strategy) {
  if (!isFiniteNumber(strategy.avgReturn)) {
    return -Infinity;
  }

  return round(strategy.avgReturn - Math.abs(strategy.maxLoss || 0) * 0.25 - (strategy.avgDrawdown || 0) * 0.2, 2);
}

function selectRecommendation(strategySummaries) {
  const byName = new Map(strategySummaries.map((row) => [row.strategy, row]));
  const shortStrategies = strategySummaries.filter((row) => row.strategy.startsWith("short_") || row.strategy.includes("_short"));
  const hasValidatedShort = shortStrategies.some((row) => ["EDGE_VALID", "EDGE_WEAK"].includes(row.edgeStatus) && row.sampleSize >= 30);
  const noTrade = byName.get("no_trade_binary_filter");
  const postFailure = byName.get("post_failure_continuation_short");

  if (hasValidatedShort && postFailure && postFailure.avgReturn > 0 && postFailure.avgDrawdown <= 10) {
    return "post_failure_only";
  }

  if (hasValidatedShort) {
    return "short_candidate_research";
  }

  if (noTrade && noTrade.avgReturn > 0) {
    return "avoid_binary_hold";
  }

  return "no_edge";
}

function buildPayload() {
  const { events, sources } = readEvents();
  const validEvents = events.filter((event) => event.lookaheadSafe && event.isBinaryCatalyst);
  const invalidEvents = events.filter((event) => !event.lookaheadSafe);
  const nonBinaryEvents = events.filter((event) => event.lookaheadSafe && !event.isBinaryCatalyst);
  const trades = buildTrades(validEvents);
  const tradesByStrategy = new Map(STRATEGY_NAMES.map((name) => [name, []]));

  trades.forEach((trade) => {
    tradesByStrategy.get(trade.strategy).push(trade);
  });

  const strategies = STRATEGY_NAMES.map((name) => summarizeStrategy(name, tradesByStrategy.get(name) || []));
  const ranked = strategies
    .map((row) => ({ ...row, riskAdjustedScore: riskAdjustedScore(row) }))
    .sort((left, right) => right.riskAdjustedScore - left.riskAdjustedScore || right.avgReturn - left.avgReturn);
  const bestStrategy = ranked.find((row) => row.sampleSize > 0) || null;
  const worstStrategy = [...ranked].reverse().find((row) => row.sampleSize > 0) || null;
  const recommendation = selectRecommendation(strategies);

  return {
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No modifica positions.",
      "No modifica outcomes.",
      "No modifica data/*.json reales.",
      "No modifica data/social_signals.json.",
      "No commit.",
      "No push.",
      "Research-only.",
      "Output solo en backtests/biotech-binary-failure-lab/."
    ],
    generatedAt: new Date().toISOString(),
    invalidEvents,
    mode: "research-only",
    nonBinaryEvents,
    recommendation,
    sources,
    strategies,
    summary: {
      bestStrategy: bestStrategy ? bestStrategy.strategy : null,
      eventsAnalyzed: validEvents.length,
      insufficientSample: strategies.some((row) => row.sampleSize > 0 && row.sampleSize < 30),
      rawEventsLoaded: events.length,
      shortEdge: strategies.some((row) => row.strategy.includes("short") && ["EDGE_VALID", "EDGE_WEAK"].includes(row.edgeStatus) && row.sampleSize >= 30),
      strategiesEvaluated: strategies.length,
      worstStrategy: worstStrategy ? worstStrategy.strategy : null
    },
    validEvents
  };
}

function fmt(value) {
  return isFiniteNumber(value) ? `${value > 0 ? "+" : ""}${round(value, 1).toFixed(1)}%` : "n/d";
}

function answerLine(question, answer) {
  return `- ${question} ${answer}`;
}

function renderStrategyTable(strategies) {
  const lines = [
    "| Strategy | N | Avg | Median | Win rate | Max gain | Max loss | Worst adverse | Edge | Notes |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |"
  ];

  strategies.forEach((row) => {
    lines.push(`| ${row.strategy} | ${row.sampleSize} | ${fmt(row.avgReturn)} | ${fmt(row.medianReturn)} | ${fmt(row.winRate)} | ${fmt(row.maxGain)} | ${fmt(row.maxLoss)} | ${fmt(row.worstAdverseMove)} | ${row.edgeStatus} | ${row.notes.join("; ") || "n/d"} |`);
  });

  return lines.join("\n");
}

function renderSummary(payload) {
  const byName = new Map(payload.strategies.map((row) => [row.strategy, row]));
  const best = payload.strategies.find((row) => row.strategy === payload.summary.bestStrategy);
  const shortAll = byName.get("short_all_through_event");
  const postFailure = byName.get("post_failure_continuation_short");
  const noTrade = byName.get("no_trade_binary_filter");
  const dangerous = payload.strategies.filter((row) => row.notes.includes("DANGEROUS_EVEN_IF_AVG_POSITIVE"));
  const lines = [];

  lines.push("# WALY Biotech Binary Failure Lab v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: research-only. No opera, no usa IBKR, no usa Binance, no envia ordenes.");
  lines.push("");
  lines.push("## Dataset");
  lines.push(`- Eventos crudos cargados: ${payload.summary.rawEventsLoaded}`);
  lines.push(`- Eventos binarios validos analizados: ${payload.summary.eventsAnalyzed}`);
  lines.push(`- Eventos invalidos por lookahead/fechas: ${payload.invalidEvents.length}`);
  lines.push(`- Eventos no binarios omitidos: ${payload.nonBinaryEvents.length}`);
  lines.push(`- Fuentes: ${Object.values(payload.sources).filter(Boolean).join("; ") || "ninguna"}`);
  lines.push("");
  lines.push("## Estrategias");
  lines.push(renderStrategyTable(payload.strategies));
  lines.push("");
  lines.push("## Respuestas");
  lines.push(answerLine("1. Conviene salir antes del evento?", noTrade && noTrade.avgReturn > 0 ? "Si como regla defensiva preliminar; el sample aun es insuficiente para edge estadistico fuerte." : "No validado con este sample."));
  lines.push(answerLine("2. Conviene shortear todos los eventos binarios?", shortAll && shortAll.edgeStatus !== "INSUFFICIENT_SAMPLE" ? `Lectura: ${shortAll.edgeStatus}.` : "No validado; sample insuficiente y tail risk sigue siendo el punto critico."));
  lines.push(answerLine("3. Hay subgrupo shorteable?", payload.summary.shortEdge ? "Si, queda para research adicional." : "No declarado; ningun short tiene sample suficiente para edge."));
  lines.push(answerLine("4. Es mejor short pre-evento o post-failure?", postFailure && shortAll && postFailure.avgReturn > shortAll.avgReturn ? "Post-failure luce mejor en este fixture, pero no alcanza sample." : "No concluyente."));
  lines.push(answerLine("5. Que estrategia tiene mejor EV ajustado por riesgo?", best ? `${best.strategy} (${fmt(best.avgReturn)} avg, edge ${best.edgeStatus}).` : "Ninguna."));
  lines.push(answerLine("6. Que estrategia queda prohibida por tail risk?", dangerous.length ? dangerous.map((row) => row.strategy).join(", ") : "Ninguna queda formalmente prohibida por la regla extrema, pero short_all sigue sin edge validado."));
  lines.push(answerLine("7. Que datos faltan para validar en serio?", ">=30 eventos para lectura preliminar, >=100 para fuerte, precios OHLC reales T-30/T-10/T-5/T-2/T-1/D+1/D+5/D+20, market cap, cash runway, offerings y resultado verificado."));
  lines.push(answerLine("8. Recomendacion WALY:", payload.recommendation));
  lines.push("");
  lines.push("## Confirmaciones");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function writeOutputs(payload) {
  return {
    latestPath: writeJson(LATEST_PATH, payload),
    outputDir: OUTPUT_DIR,
    summaryPath: writeText(SUMMARY_PATH, renderSummary(payload))
  };
}

function renderConsoleReport(payload) {
  return [
    "WALY Biotech Binary Failure Lab v1 generado.",
    `Eventos analizados: ${payload.summary.eventsAnalyzed}`,
    `Estrategias evaluadas: ${payload.summary.strategiesEvaluated}`,
    `Mejor estrategia: ${payload.summary.bestStrategy || "n/d"}`,
    `Peor estrategia: ${payload.summary.worstStrategy || "n/d"}`,
    `Short edge: ${payload.summary.shortEdge ? "si" : "no"}`,
    `Sample insuficiente: ${payload.summary.insufficientSample ? "si" : "no"}`,
    `Recomendacion: ${payload.recommendation}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no commit, no push."
  ].join("\n");
}

function runBiotechBinaryFailureLab(options = {}) {
  const payload = buildPayload();
  let paths = {
    latestPath: null,
    outputDir: OUTPUT_DIR,
    summaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = writeOutputs(payload);
  }

  return {
    ...payload,
    paths,
    consoleReport: renderConsoleReport(payload),
    summaryMarkdown: renderSummary(payload)
  };
}

module.exports = {
  runBiotechBinaryFailureLab
};
