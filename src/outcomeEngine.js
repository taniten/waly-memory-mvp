"use strict";

function compareOutcomeDates(left, right) {
  const leftDate = left.resolvedAt || left.loggedAt || "";
  const rightDate = right.resolvedAt || right.loggedAt || "";
  return rightDate.localeCompare(leftDate);
}

function formatResultPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function buildOutcomeLine(outcome) {
  const parts = [
    outcome.ticker,
    outcome.outcomeLabel,
    outcome.horizon
  ];

  const resultPct = formatResultPct(outcome.resultPct);

  if (resultPct) {
    parts.push(resultPct);
  }

  if (outcome.setupRankAtEntry) {
    parts.push(`rank ${outcome.setupRankAtEntry}`);
  }

  if (outcome.why) {
    parts.push(`por que: ${outcome.why}`);
  }

  if (outcome.lessons) {
    parts.push(`leccion: ${outcome.lessons}`);
  }

  return parts.join(" | ");
}

function summarizeLabelCount(outcomes, label) {
  return outcomes.filter((outcome) => outcome.outcomeLabel === label).length;
}

function buildDecisionMessage(stats) {
  if (stats.resolved === 0) {
    return "Todavia no hay outcomes resueltos suficientes para afirmar edge. WALY ya puede registrar aprendizaje, pero aun no tiene muestra.";
  }

  if (stats.resolved < 3) {
    return "El outcome loop ya esta activo, pero la muestra sigue siendo chica. Todavia estamos calibrando mas que validando edge.";
  }

  if (stats.failures > stats.wins) {
    return "La muestra reciente no respalda edge todavia. Hay mas fallos que aciertos y toca ajustar reglas antes de subir conviccion.";
  }

  return "WALY ya tiene un loop de resultados util. Todavia no prueba edge definitivo, pero ya permite separar setups que funcionan de setups que solo suenan bien.";
}

function analyzeOutcomes(state) {
  const outcomes = [...(((state.outcomes || {}).outcomes) || [])].sort(compareOutcomeDates);
  const openOutcomes = outcomes.filter((outcome) => outcome.outcomeLabel === "abierto");
  const resolvedOutcomes = outcomes.filter((outcome) => outcome.outcomeLabel !== "abierto");
  const recentResolved = resolvedOutcomes.slice(0, 5);
  const recentWins = recentResolved.filter((outcome) => outcome.outcomeLabel === "funciono");
  const recentFailures = recentResolved.filter((outcome) => outcome.outcomeLabel === "fallo");
  const recentMixed = recentResolved.filter((outcome) => outcome.outcomeLabel === "mixto");

  const stats = {
    failures: summarizeLabelCount(resolvedOutcomes, "fallo"),
    mixed: summarizeLabelCount(resolvedOutcomes, "mixto"),
    open: openOutcomes.length,
    resolved: resolvedOutcomes.length,
    wins: summarizeLabelCount(resolvedOutcomes, "funciono")
  };

  stats.winRate = stats.resolved > 0 ? Number(((stats.wins / stats.resolved) * 100).toFixed(1)) : null;

  return {
    decisionMessage: buildDecisionMessage(stats),
    openOutcomes,
    recentFailures,
    recentMixed,
    recentResolved,
    recentWins,
    stats,
    summaryLines: recentResolved.map(buildOutcomeLine)
  };
}

module.exports = {
  analyzeOutcomes
};
