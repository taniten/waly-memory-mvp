"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { simulatePortfolioBacktest } = require("./portfolioBacktest");
const { isFiniteNumber, isNonEmptyString } = require("./validators");

const DEFAULT_OUTPUT_DIR = path.join(BACKTESTS_DIR, "portfolio-backtest-sweep");
const DEFAULT_POSITION_PCT_BY_RANK = {
  A: 8,
  B: 4,
  "manual-candidate": 4,
  watch: 0,
  discard: 0
};

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`No existe el archivo ${filePath}.`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${filePath}: ${error.message}`);
    }

    throw error;
  }
}

function writeFileAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tempPath, contents, "utf8");

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  fs.renameSync(tempPath, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureSweepOutputDir(outputDir) {
  const target = path.resolve(outputDir || DEFAULT_OUTPUT_DIR);
  const allowed = path.resolve(DEFAULT_OUTPUT_DIR);
  const relative = path.relative(allowed, target);

  if (target !== allowed && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`portfolio-backtest-sweep solo puede escribir en ${allowed}.`);
  }

  return target;
}

function normalizeNumberArray(value, fieldName, transform = (item) => item) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} debe ser un array no vacio.`);
  }

  return value.map((item) => {
    if (!isFiniteNumber(item)) {
      throw new Error(`${fieldName} contiene un valor no numerico.`);
    }

    return transform(item);
  });
}

function normalizeConfig(config, configPath) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("La config de portfolio-backtest-sweep debe ser un objeto JSON.");
  }

  if (!isNonEmptyString(config.signalsConfig)) {
    throw new Error("signalsConfig es obligatorio.");
  }

  if (config.dataProvider !== "local-csv") {
    throw new Error("portfolio-backtest-sweep solo soporta dataProvider=local-csv.");
  }

  return {
    configPath,
    dataProvider: config.dataProvider,
    defaultPositionPctByRank: config.defaultPositionPctByRank || DEFAULT_POSITION_PCT_BY_RANK,
    exitHorizonDays: normalizeNumberArray(config.exitHorizonDays, "exitHorizonDays", (item) => {
      if (item <= 0) {
        throw new Error("exitHorizonDays debe contener numeros mayores a 0.");
      }

      return item;
    }),
    initialCapital: isFiniteNumber(config.initialCapital) ? config.initialCapital : 3000,
    maxBiotechPct: isFiniteNumber(config.maxBiotechPct) ? config.maxBiotechPct : 70,
    maxPositionPct: isFiniteNumber(config.maxPositionPct) ? config.maxPositionPct : 35,
    maxSpeculativePct: isFiniteNumber(config.maxSpeculativePct) ? config.maxSpeculativePct : 75,
    outputDir: ensureSweepOutputDir(config.outputDir),
    signalsConfig: config.signalsConfig,
    stopLossPct: normalizeNumberArray(config.stopLossPct, "stopLossPct", (item) => {
      if (item === 0) {
        throw new Error("stopLossPct no puede ser 0.");
      }

      return item > 0 ? item * -1 : item;
    }),
    takeProfitPct: normalizeNumberArray(config.takeProfitPct, "takeProfitPct", (item) => {
      if (item <= 0) {
        throw new Error("takeProfitPct debe contener numeros mayores a 0.");
      }

      return item;
    })
  };
}

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return Number(value.toFixed(decimals));
}

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatMoney(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function formatTrade(trade) {
  if (!trade) {
    return null;
  }

  return {
    exitReason: trade.exitReason,
    pnlUsd: trade.pnlUsd,
    returnPct: trade.returnPct,
    status: trade.status,
    ticker: trade.ticker
  };
}

function calculateDrawdownAdjustedReturn(summary) {
  if (!isFiniteNumber(summary.returnPct)) {
    return null;
  }

  if (!isFiniteNumber(summary.maxDrawdownPct) || summary.maxDrawdownPct === 0) {
    return summary.returnPct > 0 ? summary.returnPct : null;
  }

  return round(summary.returnPct / Math.abs(summary.maxDrawdownPct), 3);
}

function calculateBestTradeConcentration(summary) {
  const bestPnl = summary.bestTrades && summary.bestTrades[0] && summary.bestTrades[0].pnlUsd;

  if (!isFiniteNumber(bestPnl) || !isFiniteNumber(summary.pnlUsd) || summary.pnlUsd <= 0) {
    return null;
  }

  return round((bestPnl / summary.pnlUsd) * 100, 1);
}

function classifyAggression(row) {
  const reasons = [];

  if (row.stopLossPct <= -20) {
    reasons.push("stop amplio");
  }

  if (row.takeProfitPct >= 50) {
    reasons.push("take profit lejano");
  }

  if (row.exitHorizonDays <= 10 && row.takeProfitPct >= 50) {
    reasons.push("horizonte corto contra objetivo muy alto");
  }

  if (isFiniteNumber(row.maxDrawdownPct) && row.maxDrawdownPct <= -20) {
    reasons.push("drawdown profundo");
  }

  if (isFiniteNumber(row.winRate) && row.winRate < 50) {
    reasons.push("win rate bajo");
  }

  return reasons;
}

function calculateRobustnessScore(row) {
  const returnScore = isFiniteNumber(row.totalReturnPct) ? row.totalReturnPct : 0;
  const drawdownPenalty = isFiniteNumber(row.maxDrawdownPct) ? Math.abs(row.maxDrawdownPct) : 25;
  const winRateScore = isFiniteNumber(row.winRate) ? row.winRate / 10 : 0;
  const concentrationPenalty = isFiniteNumber(row.bestTradeContributionPct)
    ? Math.max(0, (row.bestTradeContributionPct - 60) / 10)
    : 0;
  const pendingPenalty = row.pendingTrades > 0 ? 0.5 : 0;
  const aggressionPenalty = row.aggressiveReasons.length * 0.75;

  return round(returnScore + winRateScore - (drawdownPenalty / 2) - concentrationPenalty - pendingPenalty - aggressionPenalty, 3);
}

function buildCombinationConfig(baseConfig, takeProfitPct, stopLossPct, exitHorizonDays) {
  return {
    dataProvider: baseConfig.dataProvider,
    defaultPositionPctByRank: baseConfig.defaultPositionPctByRank,
    exitHorizonDays,
    initialCapital: baseConfig.initialCapital,
    maxBiotechPct: baseConfig.maxBiotechPct,
    maxPositionPct: baseConfig.maxPositionPct,
    maxSpeculativePct: baseConfig.maxSpeculativePct,
    outputDir: baseConfig.outputDir,
    signalsConfig: baseConfig.signalsConfig,
    stopLossPct,
    takeProfitPct
  };
}

function summarizeCombination(index, comboConfig, simulation) {
  const summary = simulation.summary;
  const row = {
    avgLossPct: summary.avgLossPct,
    avgWinPct: summary.avgWinPct,
    bestTrade: formatTrade(summary.bestTrades && summary.bestTrades[0]),
    closedTrades: summary.closedTrades,
    combinationId: `combo-${String(index + 1).padStart(2, "0")}`,
    exitHorizonDays: comboConfig.exitHorizonDays,
    finalCapital: summary.finalCapital,
    maxDrawdownPct: summary.maxDrawdownPct,
    partialTrades: summary.partialTrades,
    pendingTrades: summary.pendingTrades,
    skippedTrades: summary.skippedTrades,
    stopLossPct: comboConfig.stopLossPct,
    takeProfitPct: comboConfig.takeProfitPct,
    totalPnlUsd: summary.pnlUsd,
    totalReturnPct: summary.returnPct,
    winRate: summary.winRate,
    worstTrade: formatTrade(summary.worstTrades && summary.worstTrades[0])
  };

  row.drawdownAdjustedReturn = calculateDrawdownAdjustedReturn(summary);
  row.bestTradeContributionPct = calculateBestTradeConcentration(summary);
  row.aggressiveReasons = classifyAggression(row);
  row.robustnessScore = calculateRobustnessScore(row);

  return row;
}

function sortByReturn(left, right) {
  return (right.totalReturnPct || 0) - (left.totalReturnPct || 0);
}

function sortByDrawdownAdjusted(left, right) {
  return (right.drawdownAdjustedReturn || -Infinity) - (left.drawdownAdjustedReturn || -Infinity);
}

function sortByRobustness(left, right) {
  return (right.robustnessScore || -Infinity) - (left.robustnessScore || -Infinity);
}

function describeCombo(row) {
  return `TP ${row.takeProfitPct}% | SL ${row.stopLossPct}% | ${row.exitHorizonDays}d`;
}

function renderRowLine(row) {
  return `- ${row.combinationId}: ${describeCombo(row)} | return ${formatPercent(row.totalReturnPct)} | final ${formatMoney(row.finalCapital)} | win ${formatPercent(row.winRate)} | DD ${formatPercent(row.maxDrawdownPct)} | closed ${row.closedTrades} | partial ${row.partialTrades} | pending ${row.pendingTrades} | skipped ${row.skippedTrades}`;
}

function renderTradeNote(label, trade) {
  if (!trade) {
    return `${label}: n/d`;
  }

  return `${label}: ${trade.ticker} ${formatPercent(trade.returnPct)} / ${formatMoney(trade.pnlUsd)} (${trade.exitReason || trade.status})`;
}

function renderSummaryMarkdown(payload) {
  const topByReturn = payload.rankings.bestByReturn.slice(0, 5);
  const topByDrawdown = payload.rankings.bestByDrawdownAdjusted.slice(0, 5);
  const aggressive = payload.rankings.tooAggressive.slice(0, 5);
  const robust = payload.rankings.mostRobust.slice(0, 5);
  const best = payload.rankings.bestByReturn[0];
  const worst = payload.rankings.worstByReturn[0];

  return [
    "# WALY Portfolio Backtest Parameter Sweep",
    "",
    `Generated at: ${payload.generatedAt}`,
    `Combinations: ${payload.results.length}`,
    "",
    "## 1. Mejores Por Retorno",
    ...(topByReturn.length ? topByReturn.map(renderRowLine) : ["- n/d"]),
    "",
    "## 2. Mejores Por Drawdown Ajustado",
    ...(topByDrawdown.length
      ? topByDrawdown.map((row) => `${renderRowLine(row)} | return/DD ${row.drawdownAdjustedReturn}`)
      : ["- n/d"]),
    "",
    "## 3. Combinaciones Demasiado Agresivas",
    ...(aggressive.length
      ? aggressive.map((row) => `${renderRowLine(row)} | motivos: ${row.aggressiveReasons.join(", ")}`)
      : ["- Ninguna combinacion cruzo los filtros agresivos."]),
    "",
    "## 4. Combinaciones Mas Robustas",
    ...(robust.length
      ? robust.map((row) => `${renderRowLine(row)} | robustez ${row.robustnessScore}`)
      : ["- n/d"]),
    "",
    "## 5. Lectura WALY Brutal",
    `- Mejor retorno: ${best ? `${best.combinationId} (${describeCombo(best)}) con ${formatPercent(best.totalReturnPct)}` : "n/d"}.`,
    `- Peor combinacion: ${worst ? `${worst.combinationId} (${describeCombo(worst)}) con ${formatPercent(worst.totalReturnPct)}` : "n/d"}.`,
    "- No sobreajustar: la muestra sigue chica y varias senales biotech recientes quedan pending; el sweep compara disciplina de salida, no prueba edge definitivo.",
    "- Regla v3.1 candidata: preferir la mejor combinacion robusta, no necesariamente la de retorno maximo, y mantener sizing chico por rank.",
    best ? `- ${renderTradeNote("best trade del mejor retorno", best.bestTrade)}` : "- best trade del mejor retorno: n/d",
    worst ? `- ${renderTradeNote("worst trade del peor retorno", worst.worstTrade)}` : "- worst trade del peor retorno: n/d"
  ].join("\n");
}

function buildConsoleReport(payload, paths) {
  const top = payload.rankings.bestByReturn.slice(0, 5);
  const worst = payload.rankings.worstByReturn[0];
  const robust = payload.rankings.mostRobust[0];

  return [
    "WALY Portfolio Backtest Parameter Sweep generado.",
    `Output dir: ${paths.outputDir}`,
    `Combinations: ${payload.results.length}`,
    `Results JSON: ${paths.resultsPath}`,
    `Summary MD: ${paths.summaryPath}`,
    "Top 5 by return:",
    ...(top.length ? top.map(renderRowLine) : ["- n/d"]),
    `Worst: ${worst ? renderRowLine(worst).replace(/^- /, "") : "n/d"}`,
    `WALY v3.1 candidate: ${robust ? `${describeCombo(robust)} | robustez ${robust.robustnessScore}` : "n/d"}`
  ].join("\n");
}

function runPortfolioBacktestSweep(configPathInput) {
  const configPath = path.resolve(process.cwd(), configPathInput);
  const baseConfig = normalizeConfig(readJsonFile(configPath), configPath);
  const results = [];
  let index = 0;

  baseConfig.takeProfitPct.forEach((takeProfitPct) => {
    baseConfig.stopLossPct.forEach((stopLossPct) => {
      baseConfig.exitHorizonDays.forEach((exitHorizonDays) => {
        const comboConfig = buildCombinationConfig(baseConfig, takeProfitPct, stopLossPct, exitHorizonDays);
        const simulation = simulatePortfolioBacktest(comboConfig, baseConfig.configPath);
        results.push(summarizeCombination(index, comboConfig, simulation));
        index += 1;
      });
    });
  });

  const rankings = {
    bestByDrawdownAdjusted: [...results].sort(sortByDrawdownAdjusted),
    bestByReturn: [...results].sort(sortByReturn),
    mostRobust: [...results].sort(sortByRobustness),
    tooAggressive: [...results]
      .filter((row) => row.aggressiveReasons.length > 0)
      .sort((left, right) => right.aggressiveReasons.length - left.aggressiveReasons.length || sortByReturn(left, right)),
    worstByReturn: [...results].sort((left, right) => (left.totalReturnPct || 0) - (right.totalReturnPct || 0))
  };
  const outputDir = ensureSweepOutputDir(baseConfig.outputDir);
  const paths = {
    outputDir,
    resultsPath: path.join(outputDir, "results.json"),
    summaryPath: path.join(outputDir, "summary.md")
  };
  const payload = {
    baseConfig: {
      dataProvider: baseConfig.dataProvider,
      defaultPositionPctByRank: baseConfig.defaultPositionPctByRank,
      initialCapital: baseConfig.initialCapital,
      maxBiotechPct: baseConfig.maxBiotechPct,
      maxPositionPct: baseConfig.maxPositionPct,
      maxSpeculativePct: baseConfig.maxSpeculativePct,
      signalsConfig: baseConfig.signalsConfig
    },
    generatedAt: new Date().toISOString(),
    rankings,
    results
  };

  writeJsonAtomic(paths.resultsPath, payload);
  writeFileAtomic(paths.summaryPath, `${renderSummaryMarkdown(payload)}\n`);

  return {
    consoleReport: buildConsoleReport(payload, paths),
    paths,
    results,
    rankings
  };
}

module.exports = {
  runPortfolioBacktestSweep
};
