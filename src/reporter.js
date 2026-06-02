"use strict";

const path = require("path");
const { writeReport } = require("./storage");
const { loadState, summarizeState } = require("./state");

function renderStringList(items, emptyMessage) {
  if (!items || items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function renderIssueList(items, emptyMessage) {
  if (!items || items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items.map((item) => `- ${item.message}`).join("\n");
}

function renderPositions(positions) {
  if (!positions.length) {
    return "- Cartera vacia. WALY esta en modo 100% cash.";
  }

  return positions
    .map((position) => {
      const details = [
        `**${position.ticker}**`,
        position.status,
        `prioridad ${position.priority || 1}`,
        `qty ${position.quantity}`,
        `last ${position.lastPrice || "n/d"}`,
        `setup ${position.setupType || "n/d"}`,
        `playbook ${position.playbookType || "n/d"}`,
        `catalyst ${position.catalystType || "n/d"} ${position.catalystDate || ""}`.trim(),
        position.thesisStatus === "thesis_broken"
          ? `thesisStatus ${position.thesisStatus}`
          : `thesis: ${position.thesis}`
      ];

      if (position.riskStatus) {
        details.push(`riskStatus ${position.riskStatus}`);
      }

      if (position.reviewStatus) {
        details.push(`reviewStatus ${position.reviewStatus}`);
      }

      if (position.suggestedAction) {
        details.push(`suggestedAction ${position.suggestedAction}`);
      }

      if (position.thesisStatus === "thesis_broken") {
        details.push("thesis vieja: stale");
      }

      if (position.invalidation) {
        details.push(`invalidation: ${position.invalidation}`);
      }

      return `- ${details.join(" | ")}`;
    })
    .join("\n");
}

function renderWatchlist(watchlist) {
  if (!watchlist.length) {
    return "- Sin watchlist prioritaria cargada.";
  }

  return watchlist
    .map((item) => {
      const details = [
        `**${item.ticker}**`,
        `prioridad ${item.priority}`,
        item.status,
        `rank ${item.setupRank || "pendiente"}`,
        `score ${item.rankingScore ?? "n/d"}`,
        `setup ${item.setupType || "n/d"}`,
        `playbook ${item.playbookType || "n/d"}`,
        `rerating ${item.outlierFactors.reratingPotential}`,
        `crowding ${item.outlierFactors.crowdingRisk}`
      ];

      if (item.source) {
        details.push(`source: ${item.source}`);
      }

      return `- ${details.join(" | ")}`;
    })
    .join("\n");
}

function renderCatalysts(items) {
  if (!items || items.length === 0) {
    return "- Sin catalysts activos dentro de la ventana definida.";
  }

  return items
    .map((item) => {
      const details = [
        `**${item.ticker}**`,
        item.sourceKind,
        item.catalystLabel || item.catalystType || "catalyst",
        item.catalystDate || "sin fecha",
        item.catalystTimingLabel || "n/d",
        `strength ${item.outlierFactors.catalystStrength}`
      ];

      if (item.source) {
        details.push(`source: ${item.source}`);
      }

      return `- ${details.join(" | ")}`;
    })
    .join("\n");
}

function renderSocialSignals(items) {
  if (!items || items.length === 0) {
    return "- Sin social signals relevantes para tickers en seguimiento.";
  }

  return items
    .map((item) => {
      const details = [
        `**${item.ticker}**`,
        item.sourcePlatform,
        item.signalType,
        item.verificationStatus,
        `independence ${item.independenceScore}`,
        `crowding ${item.crowdingRisk}`,
        `claim: ${item.claim}`
      ];

      if (item.sourceHandle) {
        details.push(`handle: ${item.sourceHandle}`);
      }

      return `- ${details.join(" | ")}`;
    })
    .join("\n");
}

function renderCrowdingWarnings(items) {
  if (!items || items.length === 0) {
    return "- Sin crowding warnings relevantes.";
  }

  return items.map((item) => `- ${item.message}`).join("\n");
}

function renderOutlierCandidates(items) {
  if (!items || items.length === 0) {
    return "- No hay outlier candidates reales hoy.";
  }

  return items
    .map((item) => {
      const details = [
        `**${item.ticker}**`,
        item.setupRank,
        `score ${item.rankingScore}`,
        `setup ${item.setupType}`,
        `playbook ${item.playbookType || "n/d"}`,
        `catalyst ${item.catalystType} ${item.catalystDate || "sin fecha"}`,
        `rerating ${item.outlierFactors.reratingPotential}`,
        `liquidity ${item.outlierFactors.liquidityQuality}`,
        `momentum ${item.outlierFactors.momentumQuality}`,
        `breakout ${item.outlierFactors.breakoutReadiness}`,
        `downside ${item.outlierFactors.downsideClarity}`,
        `crowding ${item.outlierFactors.crowdingRisk}`,
        `social ${item.outlierFactors.socialDiscoveryScore}`,
        `verdict: ${item.outlierVerdict}`
      ];

      if (item.invalidation) {
        details.push(`invalidation: ${item.invalidation}`);
      }

      return `- ${details.join(" | ")}`;
    })
    .join("\n");
}

function renderIntegrityChecks(ingestion) {
  const lines = [];

  if (ingestion.mismatches.length) {
    lines.push(
      ...ingestion.mismatches.map(
        (item) =>
          `${item.ticker} mismatch ${item.field}: manual ${item.manualValue} vs ingesta ${item.ingestedValue}`
      )
    );
  }

  if (ingestion.missingTrackedCatalysts.length) {
    lines.push(
      ...ingestion.missingTrackedCatalysts.map(
        (item) =>
          `${item.ticker} necesita completar ${item.missingFields.join(", ")} desde catalyst ingerido`
      )
    );
  }

  return renderStringList(lines, "Sin inconsistencias relevantes entre capa manual e ingesta.");
}

function renderComparisonSection(changes, emptyMessage) {
  if (!changes || changes.length === 0) {
    return `- ${emptyMessage}`;
  }

  return changes.map((change) => `- ${change.message}`).join("\n");
}

function renderOutcomeStats(summary) {
  if (!summary) {
    return "- Sin datos de outcomes.";
  }

  const stats = summary.stats || {};
  const parts = [
    `resueltos ${stats.resolved || 0}`,
    `funcionaron ${stats.wins || 0}`,
    `fallaron ${stats.failures || 0}`,
    `mixtos ${stats.mixed || 0}`,
    `abiertos ${stats.open || 0}`
  ];

  if (typeof stats.winRate === "number") {
    parts.push(`win rate ${stats.winRate}%`);
  }

  return `- ${parts.join(" | ")}`;
}

function renderPlaybookStats(playbooks) {
  if (!playbooks) {
    return "- Sin playbooks medidos todavia.";
  }

  const ordered = [playbooks.eventSwing, playbooks.outlier].filter(Boolean);

  if (!ordered.length) {
    return "- Sin playbooks medidos todavia.";
  }

  return ordered
    .map((playbook) => {
      const stats = playbook.stats || {};
      const parts = [
        `**${playbook.label}**`,
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

      if (typeof stats.avgDaysToPeak === "number") {
        parts.push(`dias a pico ${stats.avgDaysToPeak}`);
      }

      parts.push(`lectura: ${playbook.decisionMessage}`);
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

function renderOutcomeList(items, emptyMessage) {
  if (!items || items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items
    .map((item) => {
      const details = [
        `**${item.ticker}**`,
        item.outcomeLabel,
        item.horizon,
        item.sourceKind
      ];

      if (item.playbookType) {
        details.push(`playbook ${item.playbookType}`);
      }

      if (item.setupRankAtEntry) {
        details.push(`rank ${item.setupRankAtEntry}`);
      }

      if (typeof item.resultPct === "number") {
        const prefix = item.resultPct > 0 ? "+" : "";
        details.push(`resultado ${prefix}${item.resultPct.toFixed(1)}%`);
      }

      if (item.hit10pct === true) {
        details.push("hit10 si");
      } else if (item.hit10pct === false) {
        details.push("hit10 no");
      }

      if (item.hit15pct === true) {
        details.push("hit15 si");
      } else if (item.hit15pct === false) {
        details.push("hit15 no");
      }

      if (item.resolvedAt) {
        details.push(`resuelto ${item.resolvedAt}`);
      }

      details.push(`por que: ${item.why}`);

      if (item.lessons) {
        details.push(`leccion: ${item.lessons}`);
      }

      return `- ${details.join(" | ")}`;
    })
    .join("\n");
}

function generateReport() {
  const state = loadState();
  const summary = summarizeState(state);
  const latestEntry = summary.latestEntry;
  const comparison = summary.comparison;
  const reportDate = state.currentDate;
  const rankedWatchlist = summary.decision.ranking.rankedWatchlist;

  const markdown = [
    `# ${state.settings.projectName} - Daily Report ${reportDate}`,
    "",
    latestEntry ? `Ultima revision registrada: ${latestEntry.date}` : "Sin revisiones registradas todavia.",
    "",
    "## Cartera actual",
    renderPositions(summary.openPositions),
    "",
    "## Watchlist prioritaria",
    renderWatchlist(rankedWatchlist),
    "",
    "## Catalysts activos",
    renderCatalysts(summary.activeCatalysts),
    "",
    "## Social Signals Relevantes",
    renderSocialSignals(summary.socialRelevantSignals),
    "",
    "## Crowding Warnings",
    renderCrowdingWarnings(summary.crowdingWarnings),
    "",
    "## Top Outlier Candidates",
    renderOutlierCandidates(summary.finalOpportunities),
    "",
    "## Outcome Loop",
    renderOutcomeStats(summary.outcomesSummary),
    "",
    summary.outcomesSummary ? summary.outcomesSummary.decisionMessage : "Sin conclusion de outcomes.",
    "",
    "## Playbook Score",
    renderPlaybookStats(summary.outcomesSummary && summary.outcomesSummary.playbooks),
    "",
    "## Resoluciones recientes",
    renderOutcomeList(summary.outcomesSummary && summary.outcomesSummary.recentResolved, "Sin outcomes resueltos todavia."),
    "",
    "## Setups abiertos en observacion",
    renderOutcomeList(summary.outcomesSummary && summary.outcomesSummary.openOutcomes, "Sin setups abiertos dentro del outcome loop."),
    "",
    "## Checks De Integridad",
    renderIntegrityChecks(summary.eventIngestion),
    "",
    "## Cambios desde la ultima revision",
    renderStringList(
      latestEntry
        ? [
            `Contexto: ${latestEntry.marketContext}`,
            ...latestEntry.portfolioChanges,
            ...latestEntry.watchlistChanges
          ]
        : [],
      "Sin cambios declarados en el log."
    ),
    "",
    "## Comparacion contra revision previa",
    renderComparisonSection(
      comparison.previousToLatest,
      comparison.previousEntry
        ? "No hubo cambios estructurados entre la revision previa y la ultima."
        : "No hay una revision previa con snapshot para comparar."
    ),
    "",
    "## Diferencias entre ultima revision y estado actual",
    renderComparisonSection(
      comparison.latestToCurrent,
      latestEntry
        ? "El estado actual coincide con la ultima revision registrada."
        : "Todavia no hay revisiones registradas."
    ),
    "",
    "## Alertas del sistema",
    renderIssueList(summary.alerts, "Sin alertas activas."),
    "",
    "## Conflictos detectados",
    renderIssueList(summary.conflicts, "Sin conflictos detectados."),
    "",
    "## Tickers vencidos para revision",
    renderIssueList(summary.overdueReviews, "No hay tickers vencidos para revision."),
    "",
    "## Decision Final Brutal Y Clara",
    `**${summary.decision.finalDecision}**`,
    ""
  ].join("\n");

  const reportName = `${state.settings.reportPrefix || "daily-report"}-${reportDate}.md`;
  const reportPath = writeReport(reportName, markdown);

  return {
    markdown,
    reportPath: path.resolve(reportPath)
  };
}

module.exports = {
  generateReport
};
