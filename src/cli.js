"use strict";

const path = require("path");
const { runEdgeValidationEngine } = require("./edgeValidationEngine");
const { generateBacktestReport } = require("./backtestEngine");
const { runCatalystEngine } = require("./catalystEngine");
const { runDailyCockpit } = require("./dailyCockpit");
const { runForwardSnapshotLog } = require("./forwardSnapshotLogger");
const { runHistoricalBacktest, runPriceCoverage } = require("./historicalBacktestEngine");
const { runHistoricalCatalystDataset } = require("./historicalCatalystDataset");
const { runHistoricalReplayEngine } = require("./historicalReplayEngine");
const { runHistoricalResearchLab } = require("./historicalResearchLab");
const { initData } = require("./initData");
const { runLiveUniverseScan } = require("./liveUniverseScanner");
const { runMultibaggerLab } = require("./multibaggerLab");
const { runOpportunityRouter } = require("./opportunityRouter");
const { runPostMortemEngine } = require("./postMortemEngine");
const { runPortfolioBacktest } = require("./portfolioBacktest");
const { runPortfolioBacktestSweep } = require("./portfolioBacktestSweep");
const { runPortfolioReview } = require("./portfolioEngine");
const { runQualityGateBacktest } = require("./qualityGateBacktest");
const { runRealSignalLog } = require("./realSignalLog");
const { runReversalScan } = require("./reversalRadar");
const { generateReport } = require("./reporter");
const { runSizingEngine } = require("./sizingEngine");
const { runShortScan } = require("./shortRadar");
const { runSelectorEngine } = require("./selectorEngine");
const { runSignalQualityGate } = require("./signalQualityGate");
const { runSocialInbox } = require("./socialInbox");
const { runSocialRadar } = require("./socialRadar");
const { runSocialSourceTracker } = require("./socialSourceTracker");
const { runTimingEngine } = require("./timingEngine");
const { runTrainTestEngine } = require("./trainTestEngine");
const { syncUniverse } = require("./universeEngine");
const { runWalyDaily } = require("./walyDailyRun");
const { runWalyHealth, runWalyPipeline } = require("./walyPipeline");
const { parseRuntimeOptions } = require("./runtimeMode");
const {
  addOutcomeEntry,
  addLogEntry,
  loadState,
  replacePositions,
  replaceWatchlist,
  summarizeState
} = require("./state");

function printUsage() {
  console.log(`Uso:
  node src/cli.js init-data
  node src/cli.js state
  node src/cli.js report
  node src/cli.js backtest [--dry-run]
  node src/cli.js historical-backtest <config-json>
  node src/cli.js historical-catalyst-dataset
  node src/cli.js historical-replay-engine
  node src/cli.js edge-validation-engine
  node src/cli.js historical-research-lab <config-json>
  node src/cli.js signal-quality-gate
  node src/cli.js quality-gate-backtest
  node src/cli.js social-inbox
  node src/cli.js social-radar
  node src/cli.js social-source-tracker
  node src/cli.js price-coverage <config-json>
  node src/cli.js portfolio-backtest <config-json>
  node src/cli.js portfolio-backtest-sweep <config-json>
  node src/cli.js live-scan <config-json>
  node src/cli.js reversal-scan <config-json>
  node src/cli.js short-scan <config-json>
  node src/cli.js multibagger-lab <config-json>
  node src/cli.js daily-cockpit
  node src/cli.js forward-snapshot-log
  node src/cli.js selector-engine
  node src/cli.js real-signal-log
  node src/cli.js catalyst-engine
  node src/cli.js timing-engine
  node src/cli.js sizing-engine
  node src/cli.js train-test-engine
  node src/cli.js post-mortem-engine
  node src/cli.js waly-daily
  node src/cli.js waly-pipeline
  node src/cli.js waly-health
  Opciones: --mode production | --mode demo | --use-examples
  node src/cli.js portfolio-review
  node src/cli.js opportunity-router
  node src/cli.js sync-universe
  node src/cli.js add-log <ruta-json>
  node src/cli.js add-outcome <ruta-json>
  node src/cli.js set-positions <ruta-json>
  node src/cli.js set-watchlist <ruta-json>`);
}

function renderState() {
  const state = loadState();
  const summary = summarizeState(state);

  console.log(`# ${state.settings.projectName}`);
  console.log("");
  console.log("Posiciones abiertas:");
  if (summary.openPositions.length === 0) {
    console.log("- Cartera vacia. WALY esta en modo 100% cash.");
  } else {
    summary.openPositions.forEach((position) => {
      console.log(`- ${position.ticker}: ${position.status} | thesis: ${position.thesis}`);
    });
  }
  console.log("");
  console.log("Watchlist prioritaria:");
  if (summary.decision.ranking.rankedWatchlist.length === 0) {
    console.log("- Sin watchlist cargada.");
  } else {
    summary.decision.ranking.rankedWatchlist.forEach((item) => {
      console.log(
        `- ${item.ticker}: prioridad ${item.priority} | ${item.setupRank} | score ${item.rankingScore} | rerating ${item.outlierFactors.reratingPotential}`
      );
    });
  }
  console.log("");
  console.log("Catalysts activos:");
  if (summary.activeCatalysts.length === 0) {
    console.log("- Sin catalysts activos en ventana.");
  } else {
    summary.activeCatalysts.forEach((item) => {
      console.log(
        `- ${item.ticker}: ${item.catalystType || "n/d"} | ${item.catalystDate || "sin fecha"} | strength ${item.outlierFactors.catalystStrength}`
      );
    });
  }
  console.log("");
  console.log("Social signals relevantes:");
  if (summary.socialRelevantSignals.length === 0) {
    console.log("- Sin social signals relevantes.");
  } else {
    summary.socialRelevantSignals.forEach((item) => {
      console.log(
        `- ${item.ticker}: ${item.sourcePlatform} | ${item.signalType} | ${item.verificationStatus} | crowding ${item.crowdingRisk}`
      );
    });
  }
  console.log("");
  console.log("Crowding warnings:");
  if (summary.crowdingWarnings.length === 0) {
    console.log("- Sin crowding warnings.");
  } else {
    summary.crowdingWarnings.forEach((warning) => {
      console.log(`- ${warning.message}`);
    });
  }
  console.log("");
  console.log("Top outlier candidates:");
  if (summary.finalOpportunities.length === 0) {
    console.log("- No hay outlier candidates reales hoy.");
  } else {
    summary.finalOpportunities.forEach((item) => {
      console.log(`- ${item.ticker}: ${item.setupRank} | score ${item.rankingScore} | ${item.outlierVerdict}`);
    });
  }
  console.log("");
  console.log("Outcome loop:");
  if (summary.outcomesSummary.stats.resolved === 0 && summary.outcomesSummary.stats.open === 0) {
    console.log("- Sin outcomes cargados.");
  } else {
      console.log(
        `- Resueltos ${summary.outcomesSummary.stats.resolved} | funcionaron ${summary.outcomesSummary.stats.wins} | fallaron ${summary.outcomesSummary.stats.failures} | mixtos ${summary.outcomesSummary.stats.mixed} | abiertos ${summary.outcomesSummary.stats.open}${typeof summary.outcomesSummary.stats.winRate === "number" ? ` | win rate ${summary.outcomesSummary.stats.winRate}%` : ""}`
      );
    summary.outcomesSummary.recentResolved.forEach((item) => {
      const resultPct = typeof item.resultPct === "number" ? ` | resultado ${item.resultPct > 0 ? "+" : ""}${item.resultPct.toFixed(1)}%` : "";
      console.log(`- ${item.ticker}: ${item.outcomeLabel} | ${item.horizon}${resultPct} | ${item.why}`);
    });
  }
  console.log("");
  console.log("Playbook score:");
  const playbookSummaries = [
    summary.outcomesSummary.playbooks && summary.outcomesSummary.playbooks.eventSwing,
    summary.outcomesSummary.playbooks && summary.outcomesSummary.playbooks.outlier
  ].filter(Boolean);
  if (playbookSummaries.length === 0) {
    console.log("- Sin playbooks medidos.");
  } else {
    playbookSummaries.forEach((playbook) => {
      const stats = playbook.stats || {};
      const parts = [
        playbook.label,
        `resueltos ${stats.resolved || 0}`,
        `abiertos ${stats.open || 0}`
      ];

      if (typeof stats.winRate === "number") {
        parts.push(`win rate ${stats.winRate}%`);
      }

      if (typeof stats.avgResultPct === "number") {
        parts.push(`avg resultado ${stats.avgResultPct > 0 ? "+" : ""}${stats.avgResultPct}%`);
      }

      if (typeof stats.hit10Rate === "number") {
        parts.push(`hit10 ${stats.hit10Rate}%`);
      }

      if (typeof stats.hit15Rate === "number") {
        parts.push(`hit15 ${stats.hit15Rate}%`);
      }

      parts.push(playbook.decisionMessage);
      console.log(`- ${parts.join(" | ")}`);
    });
  }
  console.log("");
  console.log("Alertas activas:");
  if (summary.alerts.length === 0) {
    console.log("- Sin alertas.");
  } else {
    summary.alerts.forEach((alert) => {
      console.log(`- ${alert.message}`);
    });
  }
  console.log("");
  console.log("Lectura del loop:");
  console.log(`- ${summary.outcomesSummary.decisionMessage}`);
  console.log("");
  console.log("Ultima revision:");
  if (summary.latestEntry) {
    console.log(`- ${summary.latestEntry.date}: ${summary.latestEntry.decision}`);
  } else {
    console.log("- Sin revisiones registradas.");
  }
  console.log("");
  console.log("Decision final:");
  console.log(`- ${summary.decision.finalDecision}`);
}

function requirePath(argument, commandName) {
  if (!argument) {
    throw new Error(`Debes indicar una ruta JSON para ${commandName}.`);
  }

  return path.resolve(process.cwd(), argument);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const argument = args[0];
  const runtimeOptions = parseRuntimeOptions(args);

  try {
    switch (command) {
      case "init-data":
        initData();
        break;
      case "state":
        renderState();
        break;
      case "report": {
        const result = generateReport();
        console.log(`Reporte generado: ${result.reportPath}`);
        break;
      }
      case "backtest": {
        const dryRun = args.includes("--dry-run") || args.includes("--stdout");
        const result = generateBacktestReport({ dryRun });

        if (dryRun) {
          console.log("Outcome backtest summary generado desde outcomes registrados; no es simulacion ex-ante.");
          console.log("");
          console.log(result.markdown);
          console.log("");
          console.log(`Muestra resuelta: ${result.sampleSize}`);
          break;
        }

        console.log("Outcome backtest summary generado desde outcomes registrados; no es simulacion ex-ante.");
        console.log(`Output generado: ${result.outputPath}`);
        console.log(`Muestra resuelta: ${result.sampleSize}`);
        break;
      }
      case "historical-backtest": {
        const filePath = requirePath(argument, "historical-backtest");
        const result = runHistoricalBacktest(filePath);
        console.log("Historical Signal Backtest MVP generado.");
        console.log(`Run dir: ${result.runDir}`);
        console.log(`Signals output: ${result.signalsPath}`);
        console.log(`Summary JSON: ${result.summaryJsonPath}`);
        console.log(`Summary MD: ${result.summaryMarkdownPath}`);
        console.log(`Total signals: ${result.summary.totalSignals}`);
        console.log(`Completed: ${result.summary.completedSignals}`);
        console.log(`Partial: ${result.summary.partialSignals}`);
        console.log(`Pending: ${result.summary.pendingSignals}`);
        console.log(`Errores: ${result.summary.errorCount}`);
        break;
      }
      case "historical-catalyst-dataset": {
        const result = runHistoricalCatalystDataset();
        console.log(result.consoleReport);
        break;
      }
      case "historical-replay-engine": {
        const result = runHistoricalReplayEngine();
        console.log(result.consoleReport);
        break;
      }
      case "edge-validation-engine": {
        const result = runEdgeValidationEngine();
        console.log(result.consoleReport);
        break;
      }
      case "historical-research-lab": {
        const filePath = requirePath(argument, "historical-research-lab");
        const result = await runHistoricalResearchLab(filePath);
        console.log(result.consoleReport);
        break;
      }
      case "signal-quality-gate": {
        const result = runSignalQualityGate();
        console.log(result.consoleReport);
        break;
      }
      case "quality-gate-backtest": {
        const result = runQualityGateBacktest();
        console.log(result.consoleReport);
        break;
      }
      case "social-inbox": {
        const result = runSocialInbox(runtimeOptions);
        console.log(result.consoleReport);
        break;
      }
      case "social-radar": {
        const result = runSocialRadar(runtimeOptions);
        console.log(result.consoleReport);
        break;
      }
      case "social-source-tracker": {
        const result = runSocialSourceTracker();
        console.log(result.consoleReport);
        break;
      }
      case "price-coverage": {
        const filePath = requirePath(argument, "price-coverage");
        const result = runPriceCoverage(filePath);
        console.log(result.consoleReport);
        console.log("");
        console.log("Price coverage check generado.");
        console.log(`Run dir: ${result.runDir}`);
        console.log(`Coverage JSON: ${result.coveragePath}`);
        break;
      }
      case "portfolio-backtest": {
        const filePath = requirePath(argument, "portfolio-backtest");
        const result = runPortfolioBacktest(filePath);
        console.log(result.consoleReport);
        break;
      }
      case "portfolio-backtest-sweep": {
        const filePath = requirePath(argument, "portfolio-backtest-sweep");
        const result = runPortfolioBacktestSweep(filePath);
        console.log(result.consoleReport);
        break;
      }
      case "live-scan": {
        const filePath = requirePath(argument, "live-scan");
        const result = await runLiveUniverseScan(filePath);
        console.log(result.consoleReport);
        console.log(`Source status JSON: ${result.paths.sourceStatusPath}`);
        console.log(`Raw candidates JSON: ${result.paths.rawCandidatesPath}`);
        console.log(`Filtered candidates JSON: ${result.paths.filteredCandidatesPath}`);
        console.log(`Summary MD: ${result.paths.summaryPath}`);
        break;
      }
      case "reversal-scan": {
        const filePath = requirePath(argument, "reversal-scan");
        const result = runReversalScan(filePath);
        console.log(result.consoleReport);
        console.log(`Source status JSON: ${result.paths.sourceStatusPath}`);
        console.log(`Raw candidates JSON: ${result.paths.rawCandidatesPath}`);
        console.log(`Filtered candidates JSON: ${result.paths.filteredCandidatesPath}`);
        console.log(`Summary MD: ${result.paths.summaryPath}`);
        break;
      }
      case "short-scan": {
        const filePath = requirePath(argument, "short-scan");
        const result = runShortScan(filePath);
        console.log(result.consoleReport);
        console.log(`Source status JSON: ${result.paths.sourceStatusPath}`);
        console.log(`Raw candidates JSON: ${result.paths.rawCandidatesPath}`);
        console.log(`Filtered candidates JSON: ${result.paths.filteredCandidatesPath}`);
        console.log(`Summary MD: ${result.paths.summaryPath}`);
        break;
      }
      case "multibagger-lab": {
        const filePath = requirePath(argument, "multibagger-lab");
        const result = runMultibaggerLab(filePath);
        console.log("WALY Multibagger Lab generado.");
        console.log(`Run dir: ${result.paths.runDir}`);
        console.log(`Raw signals JSON: ${result.paths.rawSignalsPath}`);
        console.log(`Analyzed signals JSON: ${result.paths.analyzedSignalsPath}`);
        console.log(`Playbook stats JSON: ${result.paths.playbookStatsPath}`);
        console.log(`Summary MD: ${result.paths.summaryPath}`);
        console.log(`Signals analyzed: ${result.summary.signalsCount}`);
        console.log(`Multibaggers: ${result.summary.multibaggerCount}`);
        console.log(`hit100: ${result.summary.hit100 === null ? "n/d" : `${result.summary.hit100}%`}`);
        console.log(`Errores: ${result.summary.errorCount}`);
        break;
      }
      case "daily-cockpit": {
        const result = await runDailyCockpit();
        console.log(result.consoleReport);
        break;
      }
      case "forward-snapshot-log": {
        const result = runForwardSnapshotLog();
        console.log(result.consoleReport);
        break;
      }
      case "selector-engine": {
        const result = runSelectorEngine();
        console.log(result.consoleReport);
        break;
      }
      case "real-signal-log": {
        const result = runRealSignalLog();
        console.log(result.consoleReport);
        break;
      }
      case "catalyst-engine": {
        const result = runCatalystEngine();
        console.log(result.consoleReport);
        break;
      }
      case "timing-engine": {
        const result = runTimingEngine();
        console.log(result.consoleReport);
        break;
      }
      case "sizing-engine": {
        const result = runSizingEngine();
        console.log(result.consoleReport);
        break;
      }
      case "train-test-engine": {
        const result = runTrainTestEngine();
        console.log(result.consoleReport);
        break;
      }
      case "post-mortem-engine": {
        const result = runPostMortemEngine();
        console.log(result.consoleReport);
        break;
      }
      case "waly-daily": {
        const result = await runWalyDaily();
        console.log(result.consoleReport);
        break;
      }
      case "waly-pipeline": {
        const result = runWalyPipeline(runtimeOptions);
        console.log(result.consoleReport);
        break;
      }
      case "waly-health": {
        const result = runWalyHealth(runtimeOptions);
        console.log(result.consoleReport);
        break;
      }
      case "portfolio-review": {
        const result = runPortfolioReview();
        console.log(result.consoleReport);
        break;
      }
      case "opportunity-router": {
        const result = runOpportunityRouter();
        console.log(result.consoleReport);
        break;
      }
      case "sync-universe": {
        const result = await syncUniverse();
        console.log(`Universe sync generado: ${result.universePath}`);
        console.log(`Candidatos: ${result.candidates.length}`);
        Object.values(result.providerStatus).forEach((provider) => {
          console.log(
            `- ${provider.provider}: ${provider.status}${provider.count !== undefined ? ` | count ${provider.count}` : ""}${provider.message ? ` | ${provider.message}` : ""}`
          );
        });
        break;
      }
      case "add-log": {
        const filePath = requirePath(argument, "add-log");
        const entry = addLogEntry(filePath);
        console.log(`Revision agregada para ${entry.date}.`);
        break;
      }
      case "add-outcome": {
        const filePath = requirePath(argument, "add-outcome");
        const outcome = addOutcomeEntry(filePath);
        console.log(
          `Outcome agregado: ${outcome.ticker} | ${outcome.playbookType || "sin playbook"} | ${outcome.loggedAt}.`
        );
        break;
      }
      case "set-positions": {
        const filePath = requirePath(argument, "set-positions");
        const positions = replacePositions(filePath);
        console.log(`Posiciones actualizadas: ${positions.positions.length} registros.`);
        break;
      }
      case "set-watchlist": {
        const filePath = requirePath(argument, "set-watchlist");
        const watchlist = replaceWatchlist(filePath);
        console.log(`Watchlist actualizada: ${watchlist.watchlist.length} registros.`);
        break;
      }
      default:
        printUsage();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
