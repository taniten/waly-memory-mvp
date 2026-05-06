"use strict";

const path = require("path");
const { generateReport } = require("./reporter");
const { syncUniverse } = require("./universeEngine");
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
  node src/cli.js state
  node src/cli.js report
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
  const argument = process.argv[3];

  try {
    switch (command) {
      case "state":
        renderState();
        break;
      case "report": {
        const result = generateReport();
        console.log(`Reporte generado: ${result.reportPath}`);
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
