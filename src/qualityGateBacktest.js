"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const RESEARCH_DIR = path.join(BACKTESTS_DIR, "historical-research");
const INPUT_DIR = path.join(RESEARCH_DIR, "v3-2-signal-quality");
const OUTPUT_DIR = path.join(RESEARCH_DIR, "v3-2-signal-quality-backtest");
const SCORED_SIGNALS_PATH = path.join(INPUT_DIR, "scored-signals.json");
const BACKTEST_SUMMARY_PATH = path.join(RESEARCH_DIR, "backtest-summary.json");
const PARAMETER_SWEEP_PATH = path.join(RESEARCH_DIR, "parameter-sweep.json");
const CATEGORIES = ["A_candidate", "B_watch", "C_research_only", "discard"];
const HORIZONS = ["10d", "20d", "30d", "60d"];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Falta ${formatRelative(filePath)}. Ejecuta primero signal-quality-gate y historical-research-lab.`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${formatRelative(filePath)}: ${error.message}`);
    }

    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
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

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${value > 0 ? "+" : ""}${round(value, 1).toFixed(1)}%`;
}

function formatNumber(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return round(value, 2).toString();
}

function signalKey(signal) {
  return `${normalizeTicker(signal.ticker)}|${signal.signalDate}|${signal.signalType}`;
}

function average(values) {
  const valid = values.filter(isFiniteNumber);
  if (!valid.length) {
    return null;
  }

  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function winRate(values) {
  const valid = values.filter(isFiniteNumber);
  if (!valid.length) {
    return null;
  }

  return (valid.filter((value) => value > 0).length / valid.length) * 100;
}

function summarizeHorizon(joinedSignals, horizon) {
  const completed = joinedSignals
    .map((item) => item.backtest && item.backtest.horizons && item.backtest.horizons[horizon])
    .filter((item) => item && item.status === "completed");
  const returns = completed.map((item) => item.returnPct);
  const drawdowns = completed.map((item) => item.maxDrawdownPct);

  return {
    avgMaxDrawdownPct: round(average(drawdowns)),
    avgReturnPct: round(average(returns)),
    completed: completed.length,
    winRatePct: round(winRate(returns))
  };
}

function applyRule(horizonResult, rule) {
  if (!horizonResult || horizonResult.status !== "completed" || !isFiniteNumber(horizonResult.returnPct)) {
    return null;
  }

  if (isFiniteNumber(horizonResult.maxDrawdownPct) && horizonResult.maxDrawdownPct <= rule.stopLossPct) {
    return rule.stopLossPct;
  }

  if (isFiniteNumber(rule.takeProfitPct) && horizonResult.returnPct >= rule.takeProfitPct) {
    return rule.takeProfitPct;
  }

  return horizonResult.returnPct;
}

function evaluateRule(joinedSignals, rule) {
  const horizon = `${rule.exitDays}d`;
  const ruleReturns = joinedSignals
    .map((item) => {
      const horizonResult = item.backtest && item.backtest.horizons && item.backtest.horizons[horizon];
      return applyRule(horizonResult, rule);
    })
    .filter(isFiniteNumber);
  const drawdowns = joinedSignals
    .map((item) => {
      const horizonResult = item.backtest && item.backtest.horizons && item.backtest.horizons[horizon];
      return horizonResult && horizonResult.status === "completed" ? horizonResult.maxDrawdownPct : null;
    })
    .filter(isFiniteNumber);
  const avgReturnPct = average(ruleReturns);
  const avgMaxDrawdownPct = average(drawdowns);
  const winRatePct = winRate(ruleReturns);

  return {
    avgMaxDrawdownPct: round(avgMaxDrawdownPct),
    avgReturnPct: round(avgReturnPct),
    closedTrades: ruleReturns.length,
    combo: rule.combo,
    exitDays: rule.exitDays,
    score: round((avgReturnPct || 0) - Math.abs(avgMaxDrawdownPct || 0) * 0.2 + (winRatePct || 0) * 0.04, 3),
    stopLossPct: rule.stopLossPct,
    takeProfitPct: rule.takeProfitPct,
    winRatePct: round(winRatePct)
  };
}

function rankRules(joinedSignals, rules) {
  const evaluated = rules
    .map((rule) => evaluateRule(joinedSignals, rule))
    .filter((rule) => rule.closedTrades > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.avgReturnPct - left.avgReturnPct ||
      right.winRatePct - left.winRatePct ||
      left.combo.localeCompare(right.combo)
    );

  return {
    best: evaluated[0] || null,
    evaluated,
    worst: evaluated.length ? evaluated[evaluated.length - 1] : null
  };
}

function summarizeCategory(category, joinedSignals, rules) {
  const items = joinedSignals.filter((item) => item.category === category);
  const horizons = HORIZONS.reduce((summary, horizon) => {
    summary[horizon] = summarizeHorizon(items, horizon);
    return summary;
  }, {});
  const ruleRanking = rankRules(items, rules);
  const primary30 = horizons["30d"];
  const primary20 = horizons["20d"];
  const primary60 = horizons["60d"];
  const rankingScore = round(
    (primary30.avgReturnPct || 0) +
      (primary20.avgReturnPct || 0) * 0.35 +
      (primary60.avgReturnPct || 0) * 0.2 +
      (primary30.winRatePct || 0) * 0.04 -
      Math.abs(primary30.avgMaxDrawdownPct || 0) * 0.15,
    3
  );

  return {
    bestRule: ruleRanking.best,
    count: items.length,
    category,
    horizons,
    rankingScore,
    worstRule: ruleRanking.worst
  };
}

function summarizeUniverse(joinedSignals, rules) {
  const horizons = HORIZONS.reduce((summary, horizon) => {
    summary[horizon] = summarizeHorizon(joinedSignals, horizon);
    return summary;
  }, {});
  const ruleRanking = rankRules(joinedSignals, rules);

  return {
    bestRule: ruleRanking.best,
    count: joinedSignals.length,
    horizons,
    worstRule: ruleRanking.worst
  };
}

function compareAWithRest(joinedSignals, categorySummaries) {
  const a = categorySummaries.A_candidate;
  const restItems = joinedSignals.filter((item) => item.category !== "A_candidate");
  const restHorizons = HORIZONS.reduce((summary, horizon) => {
    summary[horizon] = summarizeHorizon(restItems, horizon);
    return summary;
  }, {});
  const a30 = a && a.horizons ? a.horizons["30d"] : {};
  const rest30 = restHorizons["30d"];

  return {
    aCandidate30dAvgReturnPct: a30.avgReturnPct,
    aCandidate30dWinRatePct: a30.winRatePct,
    aCandidateCount: a ? a.count : 0,
    avgReturnSpread30dPct: round((a30.avgReturnPct || 0) - (rest30.avgReturnPct || 0)),
    rest30dAvgReturnPct: rest30.avgReturnPct,
    rest30dWinRatePct: rest30.winRatePct,
    restCount: restItems.length,
    winRateSpread30dPct: round((a30.winRatePct || 0) - (rest30.winRatePct || 0))
  };
}

function compareAgainstUniverse(categorySummaries, universeSummary) {
  return CATEGORIES.reduce((comparisons, category) => {
    const item = categorySummaries[category];
    if (!item) {
      return comparisons;
    }

    comparisons[category] = {
      avgReturnSpread20dPct: round((item.horizons["20d"].avgReturnPct || 0) - (universeSummary.horizons["20d"].avgReturnPct || 0)),
      avgReturnSpread30dPct: round((item.horizons["30d"].avgReturnPct || 0) - (universeSummary.horizons["30d"].avgReturnPct || 0)),
      avgReturnSpread60dPct: round((item.horizons["60d"].avgReturnPct || 0) - (universeSummary.horizons["60d"].avgReturnPct || 0)),
      winRateSpread30dPct: round((item.horizons["30d"].winRatePct || 0) - (universeSummary.horizons["30d"].winRatePct || 0))
    };
    return comparisons;
  }, {});
}

function buildRecommendation({ categorySummaries, comparisons }) {
  const a = categorySummaries.A_candidate;
  const b = categorySummaries.B_watch;
  const c = categorySummaries.C_research_only;
  const aSpread30 = comparisons.A_candidate ? comparisons.A_candidate.avgReturnSpread30dPct : null;
  const bSpread30 = comparisons.B_watch ? comparisons.B_watch.avgReturnSpread30dPct : null;
  const cSpread30 = comparisons.C_research_only ? comparisons.C_research_only.avgReturnSpread30dPct : null;

  if (!a || a.count < 50) {
    return "ajustar gate";
  }

  if (aSpread30 > 1 && a.horizons["30d"].winRatePct >= 50 && (!c || cSpread30 <= aSpread30)) {
    if (b && bSpread30 > -1) {
      return "activar v3.2 experimental";
    }

    return "ajustar gate";
  }

  if (aSpread30 <= 0 && bSpread30 <= 0) {
    return "descartar gate por ahora";
  }

  return "mantener v3.1";
}

function buildNarrative({ categorySummaries, comparisons, recommendation }) {
  const a = categorySummaries.A_candidate;
  const b = categorySummaries.B_watch;
  const c = categorySummaries.C_research_only;

  return {
    aCandidateEdge:
      a && comparisons.A_candidate && comparisons.A_candidate.avgReturnSpread30dPct > 0
        ? `A_candidate mejora el universo por ${formatPercent(comparisons.A_candidate.avgReturnSpread30dPct)} en 30d, con win rate ${formatPercent(a.horizons["30d"].winRatePct)}. Hay edge relativo, pero no prueba forward.`
        : "A_candidate no muestra edge suficiente frente al universo completo.",
    bWatch:
      b && b.horizons["30d"].avgReturnPct > 0
        ? `B_watch merece seguimiento: retorno 30d ${formatPercent(b.horizons["30d"].avgReturnPct)}, pero debe seguir siendo watch, no entrada directa.`
        : "B_watch parece ruido o demasiado debil para operar sin filtros extra.",
    cResearchOnly:
      c && comparisons.C_research_only && comparisons.C_research_only.avgReturnSpread30dPct < 0
        ? "C_research_only debe quedar fuera de operacion: queda por debajo del universo o concentra ruido residual."
        : "C_research_only sigue siendo solo laboratorio; no debe contaminar operativa hasta forward test.",
    recommendation
  };
}

function renderCategoryTable(categorySummaries) {
  const lines = [
    "| Categoria | Senales | Avg 10d | Win 10d | Avg 20d | Win 20d | Avg 30d | Win 30d | Avg 60d | Win 60d | DD 30d | Mejor regla | Peor regla |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |"
  ];

  CATEGORIES.forEach((category) => {
    const item = categorySummaries[category];
    if (!item) {
      lines.push(`| ${category} | 0 | n/d | n/d | n/d | n/d | n/d | n/d | n/d | n/d | n/d | n/d | n/d |`);
      return;
    }

    const cells = [
        category,
        item.count,
        formatPercent(item.horizons["10d"].avgReturnPct),
        formatPercent(item.horizons["10d"].winRatePct),
        formatPercent(item.horizons["20d"].avgReturnPct),
        formatPercent(item.horizons["20d"].winRatePct),
        formatPercent(item.horizons["30d"].avgReturnPct),
        formatPercent(item.horizons["30d"].winRatePct),
        formatPercent(item.horizons["60d"].avgReturnPct),
        formatPercent(item.horizons["60d"].winRatePct),
        formatPercent(item.horizons["30d"].avgMaxDrawdownPct),
        item.bestRule ? item.bestRule.combo : "n/d",
        item.worstRule ? item.worstRule.combo : "n/d"
      ];
    lines.push(`| ${cells.join(" | ")} |`);
  });

  return lines;
}

function renderSummaryMarkdown({ categoryRanking, categorySummaries, comparisons, generatedAt, narrative, universeSummary }) {
  const lines = [];

  lines.push("# WALY Quality Gate Backtest v3.2");
  lines.push("");
  lines.push(`Generado: ${generatedAt}`);
  lines.push("Modo: research-only; no opera, no usa red, no toca memoria operativa.");
  lines.push("");
  lines.push("## 1. Tabla por categoria");
  lines.push(...renderCategoryTable(categorySummaries));
  lines.push("");
  lines.push("## 2. Ranking de categorias");
  categoryRanking.forEach((item, index) => {
    lines.push(
      `- ${index + 1}. ${item.category}: score ${formatNumber(item.rankingScore)} | 30d ${formatPercent(item.horizons["30d"].avgReturnPct)} | DD 30d ${formatPercent(item.horizons["30d"].avgMaxDrawdownPct)}`
    );
  });
  lines.push("");
  lines.push("## 3. Edge real de A_candidate");
  lines.push(`- ${narrative.aCandidateEdge}`);
  if (comparisons.A_candidate) {
    lines.push(
      `- Spread vs universo: 20d ${formatPercent(comparisons.A_candidate.avgReturnSpread20dPct)} | 30d ${formatPercent(comparisons.A_candidate.avgReturnSpread30dPct)} | 60d ${formatPercent(comparisons.A_candidate.avgReturnSpread60dPct)}`
    );
  }
  lines.push("");
  lines.push("## 4. B_watch");
  lines.push(`- ${narrative.bWatch}`);
  lines.push("");
  lines.push("## 5. C_research_only");
  lines.push(`- ${narrative.cResearchOnly}`);
  lines.push("");
  lines.push("## 6. Recomendacion WALY");
  lines.push(`- ${narrative.recommendation}`);
  lines.push(
    `- Universo completo 30d: ${formatPercent(universeSummary.horizons["30d"].avgReturnPct)} | win ${formatPercent(universeSummary.horizons["30d"].winRatePct)} | DD ${formatPercent(universeSummary.horizons["30d"].avgMaxDrawdownPct)}`
  );
  lines.push("");
  lines.push("## 7. Advertencia de sobreajuste");
  lines.push("- Este backtest reutiliza el mismo universo expandido que calibro el gate.");
  lines.push("- El sweep por categoria estima TP/SL con max drawdown y retorno de horizonte; no reconstruye intradia ni orden real de TP antes de SL.");
  lines.push("- A_candidate usa catalyst proxy por ticker, no catalyst verificado por fecha.");
  lines.push("- No incluir resultados en outcomes operativos hasta forward validation.");

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  const categoryParts = CATEGORIES.map((category) => {
    const item = result.categorySummaries[category];
    return `${category}=${item ? item.count : 0}`;
  });

  return [
    "WALY Quality Gate Backtest v3.2 generado.",
    `Output dir: ${formatRelative(OUTPUT_DIR)}`,
    `Senales evaluadas: ${result.joinedSignalsCount}`,
    `Categorias: ${categoryParts.join(" | ")}`,
    `Ranking: ${result.categoryRanking.map((item) => `${item.category}(${formatPercent(item.horizons["30d"].avgReturnPct)} 30d)`).join(" > ")}`,
    `A vs resto 30d: spread ${formatPercent(result.aVsRest.avgReturnSpread30dPct)} | win spread ${formatPercent(result.aVsRest.winRateSpread30dPct)}`,
    `Conclusion WALY v3.2: ${result.narrative.recommendation}`,
    `results.json: ${formatRelative(result.paths.resultsPath)}`,
    `summary.md: ${formatRelative(result.paths.summaryPath)}`,
    "Confirmacion: research-only; no opera, no red, no data/*.json, no outcomes."
  ].join("\n");
}

function runQualityGateBacktest() {
  const scoredPayload = readJson(SCORED_SIGNALS_PATH);
  const backtestSummary = readJson(BACKTEST_SUMMARY_PATH);
  const parameterSweep = readJson(PARAMETER_SWEEP_PATH);
  const scoredSignals = Array.isArray(scoredPayload.scoredSignals) ? scoredPayload.scoredSignals : [];
  const backtestResults = Array.isArray(backtestSummary.results) ? backtestSummary.results : [];
  const backtestByKey = new Map(backtestResults.map((item) => [signalKey(item), item]));
  const rules = Array.isArray(parameterSweep.combinations) ? parameterSweep.combinations : [];
  const joinedSignals = scoredSignals
    .map((signal) => ({
      ...signal,
      backtest: backtestByKey.get(signalKey(signal)) || null
    }))
    .filter((signal) => signal.backtest);
  const missingBacktests = scoredSignals.length - joinedSignals.length;
  const categorySummaries = CATEGORIES.reduce((summary, category) => {
    summary[category] = summarizeCategory(category, joinedSignals, rules);
    return summary;
  }, {});
  const universeSummary = summarizeUniverse(joinedSignals, rules);
  const comparisons = compareAgainstUniverse(categorySummaries, universeSummary);
  const aVsRest = compareAWithRest(joinedSignals, categorySummaries);
  const recommendation = buildRecommendation({ categorySummaries, comparisons });
  const narrative = buildNarrative({ categorySummaries, comparisons, recommendation });
  const categoryRanking = CATEGORIES.map((category) => categorySummaries[category])
    .filter((item) => item && item.count > 0)
    .sort((left, right) =>
      right.rankingScore - left.rankingScore ||
      (right.horizons["30d"].avgReturnPct || 0) - (left.horizons["30d"].avgReturnPct || 0) ||
      left.category.localeCompare(right.category)
    );
  const generatedAt = new Date().toISOString();
  const paths = {
    outputDir: OUTPUT_DIR,
    resultsPath: path.join(OUTPUT_DIR, "results.json"),
    summaryPath: path.join(OUTPUT_DIR, "summary.md")
  };
  const payload = {
    aVsRest,
    categoryRanking: categoryRanking.map((item) => item.category),
    categorySummaries,
    comparisons,
    generatedAt,
    inputs: {
      backtestSummaryPath: formatRelative(BACKTEST_SUMMARY_PATH),
      parameterSweepPath: formatRelative(PARAMETER_SWEEP_PATH),
      scoredSignalsPath: formatRelative(SCORED_SIGNALS_PATH)
    },
    joinedSignalsCount: joinedSignals.length,
    missingBacktests,
    mode: "research-only",
    narrative,
    notes: [
      "No opera.",
      "No usa red.",
      "No toca data/*.json, positions, outcomes, historical_prices ni historical_signals.",
      "TP/SL por categoria es una estimacion desde retornos de horizonte y max drawdown disponible."
    ],
    universeSummary
  };
  const markdown = renderSummaryMarkdown({
    categoryRanking,
    categorySummaries,
    comparisons,
    generatedAt,
    narrative,
    universeSummary
  });

  writeJson(paths.resultsPath, payload);
  writeText(paths.summaryPath, markdown);

  return {
    ...payload,
    consoleReport: renderConsoleReport({
      aVsRest,
      categoryRanking,
      categorySummaries,
      joinedSignalsCount: joinedSignals.length,
      narrative,
      paths
    }),
    paths
  };
}

module.exports = {
  runQualityGateBacktest
};
