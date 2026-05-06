"use strict";

const PLAYBOOK_LABELS = Object.freeze({
  "event-swing": "event-swing",
  outlier: "outlier"
});

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

  if (outcome.playbookType) {
    parts.push(`playbook ${outcome.playbookType}`);
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

function averageNumber(outcomes, fieldName) {
  const measured = outcomes.filter((outcome) => typeof outcome[fieldName] === "number" && Number.isFinite(outcome[fieldName]));

  if (!measured.length) {
    return {
      count: 0,
      value: null
    };
  }

  const total = measured.reduce((sum, outcome) => sum + outcome[fieldName], 0);

  return {
    count: measured.length,
    value: Number((total / measured.length).toFixed(1))
  };
}

function summarizeBooleanRate(outcomes, fieldName) {
  const measured = outcomes.filter((outcome) => typeof outcome[fieldName] === "boolean");

  if (!measured.length) {
    return {
      count: 0,
      hitCount: 0,
      rate: null
    };
  }

  const hitCount = measured.filter((outcome) => outcome[fieldName]).length;

  return {
    count: measured.length,
    hitCount,
    rate: Number(((hitCount / measured.length) * 100).toFixed(1))
  };
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

function buildPlaybookDecision(playbookStats) {
  if (!playbookStats || playbookStats.resolved === 0) {
    return "Sin muestra resuelta suficiente todavia para este playbook.";
  }

  if (playbookStats.resolved < 3) {
    return "La muestra sigue chica. Sirve para observar, no para asumir edge repetible.";
  }

  if (playbookStats.playbookType === "event-swing") {
    if (
      typeof playbookStats.hit10Rate === "number" &&
      playbookStats.hit10Rate >= 50 &&
      typeof playbookStats.avgResultPct === "number" &&
      playbookStats.avgResultPct > 0
    ) {
      return "Hay una senal inicial de que el playbook event-swing podria capturar moves de 10%+ con frecuencia util.";
    }

    if (
      typeof playbookStats.hit10Rate === "number" &&
      playbookStats.hit10Rate < 35 &&
      typeof playbookStats.avgResultPct === "number" &&
      playbookStats.avgResultPct <= 0
    ) {
      return "La muestra actual no respalda que el event-swing tenga edge repetible todavia.";
    }

    return "El event-swing muestra algo de vida, pero la muestra todavia no separa edge real de ruido con suficiente claridad.";
  }

  if (
    typeof playbookStats.hit15Rate === "number" &&
    playbookStats.hit15Rate >= 40 &&
    typeof playbookStats.avgResultPct === "number" &&
    playbookStats.avgResultPct > 0
  ) {
    return "El playbook outlier ya muestra asimetria interesante, aunque la muestra aun necesita mas casos.";
  }

  return "El playbook outlier sigue vivo como hipotesis, pero todavia no tiene evidencia suficiente para reclamar edge propio.";
}

function analyzePlaybook(outcomes, playbookType) {
  const filtered = outcomes.filter((outcome) => outcome.playbookType === playbookType);
  const resolved = filtered.filter((outcome) => outcome.outcomeLabel !== "abierto");
  const open = filtered.filter((outcome) => outcome.outcomeLabel === "abierto");
  const wins = summarizeLabelCount(resolved, "funciono");
  const failures = summarizeLabelCount(resolved, "fallo");
  const mixed = summarizeLabelCount(resolved, "mixto");
  const avgResult = averageNumber(resolved, "resultPct");
  const avgReturn5d = averageNumber(resolved, "return5d");
  const avgReturn10d = averageNumber(resolved, "return10d");
  const avgReturn20d = averageNumber(resolved, "return20d");
  const avgReturn30d = averageNumber(resolved, "return30d");
  const avgDaysToPeak = averageNumber(resolved, "daysToPeak");
  const avgDrawdown = averageNumber(resolved, "maxDrawdownPctBeforePeak");
  const hit10 = summarizeBooleanRate(resolved, "hit10pct");
  const hit15 = summarizeBooleanRate(resolved, "hit15pct");
  const failedFast = summarizeBooleanRate(resolved, "failedFast");
  const stats = {
    avgDaysToPeak: avgDaysToPeak.value,
    avgDrawdownPctBeforePeak: avgDrawdown.value,
    avgResultPct: avgResult.value,
    avgReturn10d: avgReturn10d.value,
    avgReturn20d: avgReturn20d.value,
    avgReturn30d: avgReturn30d.value,
    avgReturn5d: avgReturn5d.value,
    failedFastCount: failedFast.hitCount,
    failedFastMeasured: failedFast.count,
    failedFastRate: failedFast.rate,
    failures,
    hit10Count: hit10.hitCount,
    hit10Measured: hit10.count,
    hit10Rate: hit10.rate,
    hit15Count: hit15.hitCount,
    hit15Measured: hit15.count,
    hit15Rate: hit15.rate,
    mixed,
    open: open.length,
    playbookType,
    resolved: resolved.length,
    wins,
    winRate: resolved.length > 0 ? Number(((wins / resolved.length) * 100).toFixed(1)) : null
  };

  return {
    decisionMessage: buildPlaybookDecision(stats),
    label: PLAYBOOK_LABELS[playbookType] || playbookType,
    openOutcomes: open,
    playbookType,
    recentResolved: resolved.slice(0, 5),
    stats
  };
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

  const eventSwing = analyzePlaybook(outcomes, "event-swing");
  const outlier = analyzePlaybook(outcomes, "outlier");

  return {
    decisionMessage: buildDecisionMessage(stats),
    openOutcomes,
    playbooks: {
      eventSwing,
      outlier
    },
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
