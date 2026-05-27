"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "edge-validation");
const HISTORICAL_REPLAY_RESULTS_PATH = path.join(BACKTESTS_DIR, "historical-replay", "results.json");
const HISTORICAL_REPLAY_TRAIN_TEST_PATH = path.join(BACKTESTS_DIR, "historical-replay", "train-test-summary.json");
const HISTORICAL_REPLAY_SUMMARY_PATH = path.join(BACKTESTS_DIR, "historical-replay", "summary.md");
const GENERATED_SIGNALS_PATH = path.join(BACKTESTS_DIR, "historical-research", "generated-signals.json");
const PARAMETER_SWEEP_PATH = path.join(BACKTESTS_DIR, "historical-research", "parameter-sweep.json");
const SIGNAL_TYPE_ANALYSIS_PATH = path.join(BACKTESTS_DIR, "historical-research", "signal-type-analysis.json");
const V32_RESULTS_PATH = path.join(BACKTESTS_DIR, "historical-research", "v3-2-signal-quality-backtest", "results.json");
const TRAIN_TEST_ENGINE_PATH = path.join(BACKTESTS_DIR, "7-pillars", "train-test-engine.json");
const WALY_PIPELINE_PATH = path.join(BACKTESTS_DIR, "7-pillars", "waly-pipeline-latest.json");
const HORIZONS = ["result7d", "result20d", "result30d", "result60d", "result90d"];
const BASELINE_SEED = 424242;

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

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Edge Validation solo puede escribir dentro de backtests/edge-validation/.");
  }
}

function writeOutputFile(fileName, contents) {
  const filePath = path.join(OUTPUT_DIR, fileName);
  assertOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function writeOutputJson(fileName, value) {
  return writeOutputFile(fileName, `${JSON.stringify(value, null, 2)}\n`);
}

function usableRows(rows) {
  return (rows || []).filter((row) => row && Number.isFinite(row.totalScore));
}

function payoffRatio(rows, horizon = "result30d") {
  const wins = rows.map((row) => row[horizon]).filter((value) => Number.isFinite(value) && value > 0);
  const losses = rows.map((row) => row[horizon]).filter((value) => Number.isFinite(value) && value < 0);
  const avgWin = average(wins);
  const avgLoss = average(losses);

  if (avgWin === null || avgLoss === null || avgLoss === 0) {
    return null;
  }

  return round(avgWin / Math.abs(avgLoss), 2);
}

function stats(rows) {
  const completed30 = rows.filter((row) => Number.isFinite(row.result30d));
  const horizonStats = {};

  HORIZONS.forEach((horizon) => {
    horizonStats[horizon.replace("result", "avg")] = average(rows.map((row) => row[horizon]));
  });

  return {
    ...horizonStats,
    avgMaxDrawdown: average(rows.map((row) => row.maxDrawdown)),
    avgMaxUpside: average(rows.map((row) => row.maxUpside)),
    completed30: completed30.length,
    count: rows.length,
    payoffRatio30d: payoffRatio(rows),
    winRate30d: percentage(completed30.filter((row) => row.result30d > 0).length, completed30.length)
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();

  rows.forEach((row) => {
    const key = keyFn(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  });

  return [...groups.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))).map(([key, values]) => ({
    key,
    rows: values,
    stats: stats(values)
  }));
}

function splitRows(rows, splitName) {
  return rows.filter((row) => row.split === splitName);
}

function scoreDeciles(rows) {
  const sorted = usableRows(rows).slice().sort((left, right) =>
    right.totalScore - left.totalScore ||
    String(left.signalDate).localeCompare(String(right.signalDate)) ||
    String(left.ticker).localeCompare(String(right.ticker))
  );
  const total = sorted.length;

  if (!total) {
    return [];
  }

  return Array.from({ length: 10 }, (_, index) => {
    const start = Math.floor((index * total) / 10);
    const end = Math.floor(((index + 1) * total) / 10);
    const bucketRows = sorted.slice(start, end);
    return {
      decile: index + 1,
      label: `D${index + 1}`,
      maxScore: bucketRows.length ? bucketRows[0].totalScore : null,
      minScore: bucketRows.length ? bucketRows[bucketRows.length - 1].totalScore : null,
      stats: stats(bucketRows)
    };
  });
}

function scoreQuartiles(rows) {
  const sorted = usableRows(rows).slice().sort((left, right) => right.totalScore - left.totalScore);
  const total = sorted.length;

  return Array.from({ length: 4 }, (_, index) => {
    const start = Math.floor((index * total) / 4);
    const end = Math.floor(((index + 1) * total) / 4);
    const bucketRows = sorted.slice(start, end);
    return {
      label: `Q${index + 1}`,
      maxScore: bucketRows.length ? bucketRows[0].totalScore : null,
      minScore: bucketRows.length ? bucketRows[bucketRows.length - 1].totalScore : null,
      stats: stats(bucketRows)
    };
  });
}

function monotonicity(deciles) {
  const avg30 = deciles.map((row) => row.stats.avg30d);
  const drawdowns = deciles.map((row) => row.stats.avgMaxDrawdown);
  let returnViolations = 0;
  let drawdownViolations = 0;

  for (let index = 1; index < avg30.length; index += 1) {
    if (avg30[index - 1] !== null && avg30[index] !== null && avg30[index - 1] < avg30[index]) {
      returnViolations += 1;
    }

    if (drawdowns[index - 1] !== null && drawdowns[index] !== null && drawdowns[index - 1] < drawdowns[index]) {
      drawdownViolations += 1;
    }
  }

  return {
    drawdownMonotonic: drawdownViolations === 0,
    drawdownViolations,
    returnMonotonic: returnViolations === 0,
    returnViolations
  };
}

function relVolBucket(row) {
  if (!Number.isFinite(row.relVol)) {
    return "missing";
  }

  if (row.relVol < 0.75) {
    return "<0.75";
  }

  if (row.relVol <= 1.25) {
    return "0.75-1.25";
  }

  if (row.relVol <= 2) {
    return "1.25-2.0";
  }

  return ">2.0";
}

function dollarVolumeBucket(row) {
  if (!Number.isFinite(row.dollarVolume)) {
    return "missing";
  }

  if (row.dollarVolume < 1000000) {
    return "<$1M";
  }

  if (row.dollarVolume < 5000000) {
    return "$1M-$5M";
  }

  if (row.dollarVolume < 20000000) {
    return "$5M-$20M";
  }

  return ">$20M";
}

function yearBucket(row) {
  return String(row.signalDate || "missing").slice(0, 4);
}

function componentAverages(rows) {
  return {
    catalystScore: average(rows.map((row) => row.components && row.components.catalystScore)),
    portfolioFitScore: average(rows.map((row) => row.components && row.components.portfolioFitScore)),
    riskPenalty: average(rows.map((row) => row.components && row.components.riskPenalty)),
    socialScore: average(rows.map((row) => row.components && row.components.socialScore)),
    timingScore: average(rows.map((row) => row.components && row.components.timingScore)),
    volumeLiquidityScore: average(rows.map((row) => row.components && row.components.volumeLiquidityScore))
  };
}

function bestHorizon(groupRows) {
  const values = HORIZONS.map((horizon) => ({
    avgReturn: average(groupRows.map((row) => row[horizon])),
    horizon: horizon.replace("result", "")
  })).filter((row) => row.avgReturn !== null);

  if (!values.length) {
    return null;
  }

  return values.sort((left, right) => right.avgReturn - left.avgReturn)[0];
}

function signalTypeEdge(rows) {
  return groupBy(rows, (row) => row.signalType || "unknown").map((group) => {
    const trainStats = stats(splitRows(group.rows, "train"));
    const testStats = stats(splitRows(group.rows, "test"));
    const horizon = bestHorizon(group.rows);
    let recommendation = "penalizar";

    if (
      group.stats.avg30d !== null &&
      group.stats.avg30d > 4 &&
      group.stats.winRate30d !== null &&
      group.stats.winRate30d >= 50 &&
      testStats.avg30d !== null &&
      testStats.avg30d > 0
    ) {
      recommendation = "seguir";
    } else if (group.stats.avg30d !== null && group.stats.avg30d < 2) {
      recommendation = "descartar";
    }

    return {
      bestHorizon: horizon,
      recommendation,
      signalType: group.key,
      stats: group.stats,
      test: testStats,
      train: trainStats
    };
  }).sort((left, right) => (right.stats.avg30d || -Infinity) - (left.stats.avg30d || -Infinity));
}

function bucketAnalysis(rows) {
  return {
    dollarVolume: groupBy(rows, dollarVolumeBucket).map((group) => ({
      bucket: group.key,
      stats: group.stats,
      test: stats(splitRows(group.rows, "test")),
      train: stats(splitRows(group.rows, "train"))
    })),
    relVol: groupBy(rows, relVolBucket).map((group) => ({
      bucket: group.key,
      stats: group.stats,
      test: stats(splitRows(group.rows, "test")),
      train: stats(splitRows(group.rows, "train"))
    }))
  };
}

function yearlyStability(rows) {
  return groupBy(rows, yearBucket).map((group) => ({
    year: group.key,
    stats: group.stats
  })).filter((row) => /^\d{4}$/.test(row.year));
}

function tickerConcentration(rows) {
  const tickerGroups = groupBy(rows.filter((row) => Number.isFinite(row.result30d)), (row) => row.ticker || "missing").map((group) => {
    const totalReturn30d = round(group.rows.reduce((sum, row) => sum + row.result30d, 0), 2);
    return {
      avgResult30d: group.stats.avg30d,
      count: group.rows.length,
      positiveAverage: group.stats.avg30d !== null && group.stats.avg30d > 0,
      ticker: group.key,
      totalReturn30d
    };
  });
  const positiveTotal = tickerGroups
    .filter((row) => row.totalReturn30d > 0)
    .reduce((sum, row) => sum + row.totalReturn30d, 0);
  const topContributors = tickerGroups.slice().sort((left, right) => right.totalReturn30d - left.totalReturn30d).slice(0, 10);
  const worstContributors = tickerGroups.slice().sort((left, right) => left.totalReturn30d - right.totalReturn30d).slice(0, 10);
  const top3Positive = topContributors.slice(0, 3).reduce((sum, row) => sum + Math.max(0, row.totalReturn30d), 0);

  return {
    positiveAverageTickers: tickerGroups.filter((row) => row.positiveAverage).length,
    top3PositiveContributionPct: positiveTotal > 0 ? round((top3Positive / positiveTotal) * 100, 1) : null,
    topContributors,
    totalTickers: tickerGroups.length,
    worstContributors
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomBaseline(rows) {
  const clean = usableRows(rows).filter((row) => Number.isFinite(row.result30d));
  const size = Math.max(1, Math.floor(clean.length / 4));
  const actualTop = clean.slice().sort((left, right) => right.totalScore - left.totalScore).slice(0, size);
  const random = seededRandom(BASELINE_SEED);
  const shuffled = clean.map((row) => ({
    randomScore: random(),
    row
  })).sort((left, right) => right.randomScore - left.randomScore).slice(0, size).map((item) => item.row);
  const actual = stats(actualTop);
  const baseline = stats(shuffled);

  return {
    actualTopQuartile: actual,
    baselineTopQuartile: baseline,
    seed: BASELINE_SEED,
    walyBeatsBaseline: actual.avg30d !== null && baseline.avg30d !== null ? actual.avg30d > baseline.avg30d : null,
    walySpread30d: actual.avg30d !== null && baseline.avg30d !== null ? round(actual.avg30d - baseline.avg30d, 2) : null
  };
}

function failureModes(rows) {
  const highScoreThreshold = scoreQuartiles(rows)[0] && scoreQuartiles(rows)[0].minScore;
  const highScoreFailures = rows
    .filter((row) => Number.isFinite(row.result30d) && row.totalScore >= highScoreThreshold && row.result30d < -10)
    .sort((left, right) => left.result30d - right.result30d)
    .slice(0, 20);
  const extremeDrawdowns = rows
    .filter((row) => Number.isFinite(row.maxDrawdown) && row.maxDrawdown <= -35)
    .sort((left, right) => left.maxDrawdown - right.maxDrawdown)
    .slice(0, 20);
  const goodUpsideBadEntry = rows
    .filter((row) =>
      Number.isFinite(row.maxUpside) &&
      Number.isFinite(row.maxDrawdown) &&
      row.maxUpside >= 30 &&
      row.maxDrawdown <= -20
    )
    .sort((left, right) => right.maxUpside - left.maxUpside)
    .slice(0, 20);
  const needsCatalyst = rows
    .filter((row) => (row.missingData || []).some((item) => /historical catalyst/i.test(item)))
    .slice(0, 20);
  const shouldHaveDiscarded = rows
    .filter((row) =>
      Number.isFinite(row.result30d) &&
      row.classification !== "discard" &&
      (row.result30d < -20 || row.maxDrawdown <= -35)
    )
    .sort((left, right) => (left.result30d || 0) - (right.result30d || 0))
    .slice(0, 20);

  return {
    extremeDrawdowns,
    goodUpsideBadEntry,
    highScoreFailures,
    needsCatalyst,
    shouldHaveDiscarded
  };
}

function trainTestComparison(rows) {
  const train = splitRows(rows, "train");
  const test = splitRows(rows, "test");

  return {
    categories: {
      test: groupBy(test, (row) => row.classification || "missing").map((group) => ({ category: group.key, stats: group.stats })),
      train: groupBy(train, (row) => row.classification || "missing").map((group) => ({ category: group.key, stats: group.stats }))
    },
    deciles: {
      test: scoreDeciles(test),
      train: scoreDeciles(train)
    },
    overfitWarning: (() => {
      const trainTop = scoreDeciles(train)[0];
      const trainBottom = scoreDeciles(train)[9];
      const testTop = scoreDeciles(test)[0];
      const testBottom = scoreDeciles(test)[9];
      const trainImproves = trainTop && trainBottom && trainTop.stats.avg30d !== null && trainBottom.stats.avg30d !== null
        ? trainTop.stats.avg30d > trainBottom.stats.avg30d
        : null;
      const testImproves = testTop && testBottom && testTop.stats.avg30d !== null && testBottom.stats.avg30d !== null
        ? testTop.stats.avg30d > testBottom.stats.avg30d
        : null;

      return trainImproves === true && testImproves === false;
    })()
  };
}

function evidence({ baseline, buckets, deciles, missingCatalystPct, signalTypes, tickerRisk }) {
  const against = [];
  const favor = [];
  const bestRelVol = buckets.relVol.slice().sort((left, right) => (right.stats.avg30d || -Infinity) - (left.stats.avg30d || -Infinity))[0];
  const bestDollarVolume = buckets.dollarVolume.slice().sort((left, right) => (right.stats.avg30d || -Infinity) - (left.stats.avg30d || -Infinity))[0];
  const usefulTypes = signalTypes.filter((row) => row.recommendation === "seguir");

  if (deciles.monotonicity.returnMonotonic) {
    favor.push("retornos por decil son monotonicos");
  } else {
    against.push("retornos por decil no son monotonicos");
  }

  if (baseline.walyBeatsBaseline) {
    favor.push(`top score supera baseline random por ${baseline.walySpread30d}% en 30d`);
  } else {
    against.push(`top score no supera baseline random; spread ${baseline.walySpread30d}%`);
  }

  if (usefulTypes.length) {
    favor.push(`signal types con edge relativo: ${usefulTypes.map((row) => row.signalType).join(", ")}`);
  } else {
    against.push("ningun signal type cumple criterios fuertes de seguir");
  }

  if (bestRelVol) {
    favor.push(`mejor bucket RelVol por 30d: ${bestRelVol.bucket} (${bestRelVol.stats.avg30d}%)`);
  }

  if (bestDollarVolume) {
    favor.push(`mejor bucket dollar volume por 30d: ${bestDollarVolume.bucket} (${bestDollarVolume.stats.avg30d}%)`);
  }

  if (missingCatalystPct > 80) {
    against.push(`${missingCatalystPct}% de senales sin catalyst historico explicito`);
  }

  if (tickerRisk.top3PositiveContributionPct !== null && tickerRisk.top3PositiveContributionPct > 35) {
    against.push(`top 3 tickers explican ${tickerRisk.top3PositiveContributionPct}% del retorno positivo agregado`);
  }

  return {
    against,
    favor
  };
}

function finalVerdict({ baseline, deciles, missingCatalystPct, replayRows, signalTypes }) {
  const aCandidateCount = replayRows.filter((row) => row.classification === "A_candidate").length;
  const usefulTypes = signalTypes.filter((row) => row.recommendation === "seguir").length;

  if (missingCatalystPct > 80 || aCandidateCount === 0) {
    return "EDGE_INVALID_DUE_MISSING_DATA";
  }

  if (
    deciles.monotonicity.returnMonotonic &&
    baseline.walyBeatsBaseline &&
    usefulTypes >= 2
  ) {
    return "EDGE_CONFIRMED";
  }

  if (baseline.walyBeatsBaseline || usefulTypes >= 1) {
    return "EDGE_WEAK";
  }

  return "EDGE_NOT_CONFIRMED";
}

function rules({ verdict, signalTypes }) {
  const freeze = [
    "Mantener historical replay y edge validation como research-only.",
    "Congelar split train 2021-2024 y test 2025+ para comparaciones futuras.",
    "Exigir catalyst historico explicito antes de validar A_candidate."
  ];
  const doNotActivate = [
    "No activar Master Score actual como gate operativo.",
    "No activar A_candidate historico sin muestra con catalysts punto-en-tiempo.",
    "No usar socialScore historico mientras no exista input historico auditable."
  ];

  signalTypes
    .filter((row) => row.recommendation !== "seguir")
    .forEach((row) => doNotActivate.push(`No promover ${row.signalType} sin filtro adicional (${row.recommendation}).`));

  if (verdict === "EDGE_CONFIRMED") {
    freeze.push("Mantener reglas que produjeron monotonicidad, pero validar fuera de muestra antes de operar.");
  }

  return {
    doNotActivate: [...new Set(doNotActivate)],
    freeze: [...new Set(freeze)],
    nextSteps: [
      "Agregar catalysts historicos punto-en-tiempo sin backfill narrativo.",
      "Separar universo biotech/catalyst vs tech/rerating antes de comparar score.",
      "Medir entry quality con timing diario e intradia cuando exista data local.",
      "Repetir baseline con ventanas walk-forward congeladas.",
      "Documentar cada cambio de regla antes de rerun para evitar optimizacion a ojo."
    ]
  };
}

function loadInputs() {
  const inputs = {
    generatedSignals: readJsonIfExists(GENERATED_SIGNALS_PATH),
    historicalReplayResults: readJsonIfExists(HISTORICAL_REPLAY_RESULTS_PATH),
    historicalReplaySummary: readTextIfExists(HISTORICAL_REPLAY_SUMMARY_PATH),
    parameterSweep: readJsonIfExists(PARAMETER_SWEEP_PATH),
    signalTypeAnalysis: readJsonIfExists(SIGNAL_TYPE_ANALYSIS_PATH),
    trainTestEngine: readJsonIfExists(TRAIN_TEST_ENGINE_PATH),
    trainTestSummary: readJsonIfExists(HISTORICAL_REPLAY_TRAIN_TEST_PATH),
    v32Results: readJsonIfExists(V32_RESULTS_PATH),
    walyPipeline: readJsonIfExists(WALY_PIPELINE_PATH)
  };
  const missingData = [
    !inputs.historicalReplayResults ? formatRelative(HISTORICAL_REPLAY_RESULTS_PATH) : null,
    !inputs.trainTestSummary ? formatRelative(HISTORICAL_REPLAY_TRAIN_TEST_PATH) : null,
    !inputs.historicalReplaySummary ? formatRelative(HISTORICAL_REPLAY_SUMMARY_PATH) : null,
    !inputs.generatedSignals ? formatRelative(GENERATED_SIGNALS_PATH) : null,
    !inputs.parameterSweep ? formatRelative(PARAMETER_SWEEP_PATH) : null,
    !inputs.signalTypeAnalysis ? formatRelative(SIGNAL_TYPE_ANALYSIS_PATH) : null,
    !inputs.v32Results ? formatRelative(V32_RESULTS_PATH) : null,
    !inputs.trainTestEngine ? formatRelative(TRAIN_TEST_ENGINE_PATH) : null,
    !inputs.walyPipeline ? formatRelative(WALY_PIPELINE_PATH) : null
  ].filter(Boolean);

  return {
    inputs,
    missingData
  };
}

function buildPayload() {
  const { inputs, missingData } = loadInputs();
  const replayRows = usableRows(inputs.historicalReplayResults && inputs.historicalReplayResults.replayRows);
  const decilesAll = scoreDeciles(replayRows);
  const quartilesAll = scoreQuartiles(replayRows);
  const decileAnalysis = {
    all: decilesAll,
    monotonicity: monotonicity(decilesAll),
    quartiles: quartilesAll
  };
  const trainTest = trainTestComparison(replayRows);
  const signalTypes = signalTypeEdge(replayRows);
  const buckets = bucketAnalysis(replayRows);
  const yearly = yearlyStability(replayRows);
  const tickerRisk = tickerConcentration(replayRows);
  const baseline = randomBaseline(replayRows);
  const failures = failureModes(replayRows);
  const missingCatalystCount = replayRows.filter((row) =>
    (row.missingData || []).some((item) => /historical catalyst/i.test(item))
  ).length;
  const missingCatalystPct = percentage(missingCatalystCount, replayRows.length) || 0;
  const verdict = finalVerdict({
    baseline,
    deciles: decileAnalysis,
    missingCatalystPct,
    replayRows,
    signalTypes
  });
  const evidenceSet = evidence({
    baseline,
    buckets,
    deciles: decileAnalysis,
    missingCatalystPct,
    signalTypes,
    tickerRisk
  });
  const ruleSet = rules({ signalTypes, verdict });

  return {
    baseline,
    buckets,
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No usa red.",
      "No modifica positions.",
      "No modifica outcomes.",
      "No modifica data/*.json ni data/social_signals.json.",
      "No optimiza pesos automaticamente.",
      "No inventa catalysts.",
      "Output solo en backtests/edge-validation/.",
      "No commit.",
      "No push."
    ],
    deciles: decileAnalysis,
    evidenceAgainst: evidenceSet.against,
    evidenceFor: evidenceSet.favor,
    failureModes: failures,
    generatedAt: new Date().toISOString(),
    inputs: {
      generatedSignals: inputs.generatedSignals ? formatRelative(GENERATED_SIGNALS_PATH) : null,
      historicalReplayResults: inputs.historicalReplayResults ? formatRelative(HISTORICAL_REPLAY_RESULTS_PATH) : null,
      historicalReplaySummary: inputs.historicalReplaySummary ? formatRelative(HISTORICAL_REPLAY_SUMMARY_PATH) : null,
      parameterSweep: inputs.parameterSweep ? formatRelative(PARAMETER_SWEEP_PATH) : null,
      signalTypeAnalysis: inputs.signalTypeAnalysis ? formatRelative(SIGNAL_TYPE_ANALYSIS_PATH) : null,
      trainTestEngine: inputs.trainTestEngine ? formatRelative(TRAIN_TEST_ENGINE_PATH) : null,
      trainTestSummary: inputs.trainTestSummary ? formatRelative(HISTORICAL_REPLAY_TRAIN_TEST_PATH) : null,
      v32Results: inputs.v32Results ? formatRelative(V32_RESULTS_PATH) : null,
      walyPipeline: inputs.walyPipeline ? formatRelative(WALY_PIPELINE_PATH) : null
    },
    missingData: [...new Set([
      ...missingData,
      missingCatalystPct > 0 ? `${missingCatalystPct}% rows missing historical catalyst` : null
    ].filter(Boolean))],
    mode: "research-only-edge-validation",
    rules: ruleSet,
    signalTypes,
    summary: {
      aCandidateCount: replayRows.filter((row) => row.classification === "A_candidate").length,
      evaluatedSignals: replayRows.length,
      missingCatalystCount,
      missingCatalystPct,
      scoreHighVsLow: baseline.walyBeatsBaseline,
      verdict
    },
    tickerConcentration: tickerRisk,
    trainTest,
    verdict,
    yearly
  };
}

function renderStats(statsRow) {
  return [
    `count ${statsRow.count}`,
    `avg30 ${statsRow.avg30d === null ? "n/d" : `${statsRow.avg30d}%`}`,
    `win30 ${statsRow.winRate30d === null ? "n/d" : `${statsRow.winRate30d}%`}`,
    `dd ${statsRow.avgMaxDrawdown === null ? "n/d" : `${statsRow.avgMaxDrawdown}%`}`,
    `upside ${statsRow.avgMaxUpside === null ? "n/d" : `${statsRow.avgMaxUpside}%`}`,
    `payoff ${statsRow.payoffRatio30d === null ? "n/d" : statsRow.payoffRatio30d}`
  ].join(" | ");
}

function renderTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function renderDeciles(deciles) {
  return renderTable(
    ["Decile", "Score", "Count", "Avg7", "Avg20", "Avg30", "Avg60", "Avg90", "Win30", "DD", "Upside", "Payoff"],
    deciles.map((row) => [
      row.label,
      `${row.minScore}..${row.maxScore}`,
      row.stats.count,
      row.stats.avg7d === null ? "n/d" : `${row.stats.avg7d}%`,
      row.stats.avg20d === null ? "n/d" : `${row.stats.avg20d}%`,
      row.stats.avg30d === null ? "n/d" : `${row.stats.avg30d}%`,
      row.stats.avg60d === null ? "n/d" : `${row.stats.avg60d}%`,
      row.stats.avg90d === null ? "n/d" : `${row.stats.avg90d}%`,
      row.stats.winRate30d === null ? "n/d" : `${row.stats.winRate30d}%`,
      row.stats.avgMaxDrawdown === null ? "n/d" : `${row.stats.avgMaxDrawdown}%`,
      row.stats.avgMaxUpside === null ? "n/d" : `${row.stats.avgMaxUpside}%`,
      row.stats.payoffRatio30d === null ? "n/d" : row.stats.payoffRatio30d
    ])
  );
}

function renderBucketTable(rows, keyName) {
  return renderTable(
    [keyName, "All", "Train", "Test"],
    rows.map((row) => [
      row.bucket || row.signalType || row.year || row.key,
      renderStats(row.stats),
      row.train ? renderStats(row.train) : "n/d",
      row.test ? renderStats(row.test) : "n/d"
    ])
  );
}

function renderSignalRows(rows) {
  if (!rows.length) {
    return "- Ninguno.\n";
  }

  return `${renderTable(
    ["Ticker", "Fecha", "Tipo", "Score", "Clase", "30d", "DD", "Upside", "Flags"],
    rows.map((row) => [
      row.ticker,
      row.signalDate,
      row.signalType,
      row.totalScore,
      row.classification,
      row.result30d === null ? "n/d" : `${row.result30d}%`,
      row.maxDrawdown === null ? "n/d" : `${row.maxDrawdown}%`,
      row.maxUpside === null ? "n/d" : `${row.maxUpside}%`,
      (row.redFlags || []).join("; ") || "ninguna"
    ])
  )}\n`;
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Edge Validation Engine v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: research-only. No opera, no usa IBKR, no usa Binance, no envia ordenes y no usa red.");
  lines.push("");
  lines.push("## Veredicto final");
  lines.push(`- ${payload.verdict}`);
  lines.push(`- Senales evaluadas: ${payload.summary.evaluatedSignals}`);
  lines.push(`- Missing catalyst historico: ${payload.summary.missingCatalystPct}%`);
  lines.push("");
  lines.push("## Evidencia a favor");
  lines.push(payload.evidenceFor.length ? payload.evidenceFor.map((item) => `- ${item}`).join("\n") : "- Ninguna evidencia fuerte.");
  lines.push("");
  lines.push("## Evidencia en contra");
  lines.push(payload.evidenceAgainst.length ? payload.evidenceAgainst.map((item) => `- ${item}`).join("\n") : "- Ninguna.");
  lines.push("");
  lines.push("## Score alto vs score bajo");
  lines.push(`- WALY top quartile beats seeded random baseline: ${payload.baseline.walyBeatsBaseline === null ? "n/d" : payload.baseline.walyBeatsBaseline ? "si" : "no"}`);
  lines.push(`- Spread 30d vs baseline: ${payload.baseline.walySpread30d === null ? "n/d" : `${payload.baseline.walySpread30d}%`}`);
  lines.push(`- Monotonicidad retorno: ${payload.deciles.monotonicity.returnMonotonic ? "si" : "no"}`);
  lines.push(`- Monotonicidad drawdown: ${payload.deciles.monotonicity.drawdownMonotonic ? "si" : "no"}`);
  lines.push("");
  lines.push("## Que componente si aporta");
  const useful = payload.signalTypes.filter((row) => row.recommendation === "seguir");
  lines.push(useful.length ? useful.map((row) => `- ${row.signalType}: ${renderStats(row.stats)}`).join("\n") : "- Ningun componente/signal type queda validado como edge fuerte.");
  lines.push("");
  lines.push("## Que componente resta");
  payload.signalTypes.filter((row) => row.recommendation !== "seguir").forEach((row) => {
    lines.push(`- ${row.signalType}: ${row.recommendation} | ${renderStats(row.stats)}`);
  });
  lines.push("");
  lines.push("## Que no se puede validar por falta de datos");
  lines.push("- A_candidate: no hay muestra valida sin catalysts historicos explicitos.");
  lines.push("- CatalystScore: falta catalyst punto-en-tiempo en la mayoria de filas.");
  lines.push("- SocialScore: no hay social historico auditable.");
  lines.push("");
  lines.push("## Reglas que congelar");
  payload.rules.freeze.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Reglas que no activar");
  payload.rules.doNotActivate.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Proximos pasos obligatorios");
  payload.rules.nextSteps.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Confirmacion");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function renderScoreDeciles(payload) {
  return [
    "# Score Deciles",
    "",
    "## All",
    renderDeciles(payload.deciles.all),
    "",
    `Monotonicidad retorno: ${payload.deciles.monotonicity.returnMonotonic ? "si" : "no"}`,
    `Monotonicidad drawdown: ${payload.deciles.monotonicity.drawdownMonotonic ? "si" : "no"}`,
    "",
    "## Train",
    renderDeciles(payload.trainTest.deciles.train),
    "",
    "## Test",
    renderDeciles(payload.trainTest.deciles.test),
    ""
  ].join("\n");
}

function renderSignalTypeEdge(payload) {
  const sections = [
    "# Signal Type Edge",
    "",
    renderTable(
      ["Signal type", "Recommendation", "Best horizon", "All", "Train", "Test"],
      payload.signalTypes.map((row) => [
        row.signalType,
        row.recommendation,
        row.bestHorizon ? `${row.bestHorizon.horizon} ${row.bestHorizon.avgReturn}%` : "n/d",
        renderStats(row.stats),
        renderStats(row.train),
        renderStats(row.test)
      ])
    ),
    "",
    "## RelVol buckets",
    renderBucketTable(payload.buckets.relVol, "Bucket"),
    "",
    "## Dollar volume buckets",
    renderBucketTable(payload.buckets.dollarVolume, "Bucket"),
    "",
    "## Year/regime",
    renderTable(
      ["Year", "Stats"],
      payload.yearly.map((row) => [row.year, renderStats(row.stats)])
    ),
    ""
  ];

  return sections.join("\n");
}

function renderFailureModes(payload) {
  return [
    "# Failure Modes",
    "",
    "## Falsos positivos de score alto",
    renderSignalRows(payload.failureModes.highScoreFailures),
    "## Drawdown extremo",
    renderSignalRows(payload.failureModes.extremeDrawdowns),
    "## Buen upside pero mala entrada",
    renderSignalRows(payload.failureModes.goodUpsideBadEntry),
    "## Necesitan catalyst explicito",
    renderSignalRows(payload.failureModes.needsCatalyst),
    "## Deberian haberse descartado",
    renderSignalRows(payload.failureModes.shouldHaveDiscarded)
  ].join("\n");
}

function renderRecommendations(payload) {
  return [
    "# Recommendations",
    "",
    `Verdict: ${payload.verdict}`,
    "",
    "## Freeze",
    ...payload.rules.freeze.map((item) => `- ${item}`),
    "",
    "## Do not activate",
    ...payload.rules.doNotActivate.map((item) => `- ${item}`),
    "",
    "## Required next steps",
    ...payload.rules.nextSteps.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

function writeOutputs(payload) {
  return {
    failureModesPath: writeOutputFile("failure-modes.md", renderFailureModes(payload)),
    recommendationsPath: writeOutputFile("recommendations.md", renderRecommendations(payload)),
    resultsPath: writeOutputJson("results.json", payload),
    scoreDecilesPath: writeOutputFile("score-deciles.md", renderScoreDeciles(payload)),
    signalTypeEdgePath: writeOutputFile("signal-type-edge.md", renderSignalTypeEdge(payload)),
    summaryPath: writeOutputFile("summary.md", renderSummary(payload))
  };
}

function renderConsoleReport(payload, paths) {
  const bestRelVol = payload.buckets.relVol.slice().sort((left, right) => (right.stats.avg30d || -Infinity) - (left.stats.avg30d || -Infinity))[0];
  const worstRelVol = payload.buckets.relVol.slice().sort((left, right) => (left.stats.avg30d || Infinity) - (right.stats.avg30d || Infinity))[0];
  const useful = payload.signalTypes.filter((row) => row.recommendation === "seguir").map((row) => row.signalType);
  const penalized = payload.signalTypes.filter((row) => row.recommendation !== "seguir").map((row) => `${row.signalType}:${row.recommendation}`);

  return [
    "WALY Edge Validation Engine v1 generado.",
    `Verdict: ${payload.verdict}`,
    `Signals evaluadas: ${payload.summary.evaluatedSignals}`,
    `Score alto vs score bajo/random: ${payload.baseline.walyBeatsBaseline === null ? "n/d" : payload.baseline.walyBeatsBaseline ? "si" : "no"} | spread ${payload.baseline.walySpread30d === null ? "n/d" : `${payload.baseline.walySpread30d}%`}`,
    `Mejor bucket RelVol: ${bestRelVol ? `${bestRelVol.bucket} avg30 ${bestRelVol.stats.avg30d}%` : "n/d"}`,
    `Peor bucket RelVol: ${worstRelVol ? `${worstRelVol.bucket} avg30 ${worstRelVol.stats.avg30d}%` : "n/d"}`,
    `Signal types utiles: ${useful.join(", ") || "ninguno"}`,
    `Signal types a penalizar: ${penalized.join(", ") || "ninguno"}`,
    `summary.md: ${formatRelative(paths.summaryPath)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no red, no commit, no push."
  ].join("\n");
}

function runEdgeValidationEngine(options = {}) {
  const payload = buildPayload();
  let paths = {
    failureModesPath: null,
    recommendationsPath: null,
    resultsPath: null,
    scoreDecilesPath: null,
    signalTypeEdgePath: null,
    summaryPath: null
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
  runEdgeValidationEngine
};
