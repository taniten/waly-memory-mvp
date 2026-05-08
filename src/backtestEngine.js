"use strict";

const path = require("path");
const { writeBacktestOutput } = require("./storage");
const { loadState } = require("./state");
const {
  isFiniteNumber,
  isNonEmptyString,
  normalizeTextEnum
} = require("./validators");

// This module summarizes outcomes that were already recorded manually in outcomes.json.
// It does not generate historical signals, does not fetch price history, does not checkpoint,
// and should not be treated as an ex-ante historical backtest or a 2-day scan engine.

const HORIZON_ORDER = ["5d", "10d", "20d", "30d"];
const UNIVERSE_SEGMENTS = [
  {
    key: "equity-core",
    label: "Acciones liquidas",
    predicate: (outcome) => outcome.assetType === "equity"
  },
  {
    key: "biotech-fda",
    label: "Biotech / catalyst",
    predicate: (outcome) => outcome.catalystType === "fda"
  },
  {
    key: "insiders",
    label: "Insiders",
    predicate: (outcome) => outcome.catalystType === "insider"
  },
  {
    key: "unusual-volume-gap",
    label: "Volumen anormal",
    predicate: (outcome) => outcome.catalystType === "unusual-volume-gap"
  },
  {
    key: "etf-standard",
    label: "ETF tactico estandar",
    predicate: (outcome) => outcome.assetType === "etf" && outcome.etfModule === "standard"
  },
  {
    key: "etf-leveraged",
    label: "ETF tactico apalancado / inverso",
    predicate: (outcome) => outcome.assetType === "etf" && outcome.etfModule === "leveraged"
  }
];

function getMetadata(outcome) {
  if (!outcome || !outcome.metadata || typeof outcome.metadata !== "object" || Array.isArray(outcome.metadata)) {
    return {};
  }

  return outcome.metadata;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (isFiniteNumber(value)) {
      return value;
    }
  }

  return null;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function compareResolvedDates(left, right) {
  const leftDate = left.resolvedAt || left.loggedAt || "";
  const rightDate = right.resolvedAt || right.loggedAt || "";
  return rightDate.localeCompare(leftDate);
}

function formatPercent(value, options = {}) {
  const { signed = true } = options;

  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function formatNumber(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return value.toFixed(1);
}

function formatBoolean(value) {
  if (value === true) {
    return "si";
  }

  if (value === false) {
    return "no";
  }

  return "n/d";
}

function average(values) {
  if (!values.length) {
    return null;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(1));
}

function countBy(items, selector) {
  const counts = new Map();

  items.forEach((item) => {
    const key = selector(item) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([key, count]) => ({ count, key }));
}

function renderMix(items) {
  if (!items.length) {
    return "sin muestra";
  }

  return items.map((item) => `${item.key} ${item.count}`).join(" | ");
}

function toHorizonDays(horizon) {
  if (!isNonEmptyString(horizon)) {
    return null;
  }

  const match = horizon.trim().match(/^(\d+)d$/i);
  return match ? Number(match[1]) : null;
}

function deriveAssetType(outcome, metadata) {
  const explicit = normalizeTextEnum(outcome.assetType || metadata.assetType);

  if (explicit === "equity" || explicit === "etf") {
    return explicit;
  }

  if (
    isNonEmptyString(outcome.etfCategory) ||
    isNonEmptyString(metadata.etfCategory) ||
    isFiniteNumber(outcome.leverageFactor) ||
    isFiniteNumber(metadata.leverageFactor) ||
    outcome.inverse === true ||
    metadata.inverse === true
  ) {
    return "etf";
  }

  return "equity";
}

function deriveEtfModule(outcome, metadata, assetType) {
  if (assetType !== "etf") {
    return "n/a";
  }

  const etfCategory = normalizeTextEnum(outcome.etfCategory || metadata.etfCategory);
  const leverageFactor = firstFiniteNumber(outcome.leverageFactor, metadata.leverageFactor);
  const inverse = outcome.inverse === true || metadata.inverse === true;

  if (
    etfCategory === "leveraged" ||
    etfCategory === "inverse" ||
    etfCategory === "leveraged-inverse" ||
    etfCategory === "single-stock-leveraged" ||
    inverse ||
    (isFiniteNumber(leverageFactor) && leverageFactor > 1)
  ) {
    return "leveraged";
  }

  return "standard";
}

function deriveCatalystType(outcome, metadata) {
  return outcome.catalystType || metadata.catalystType || "unknown";
}

function deriveMaxPostEntryReturnPct(outcome, metadata) {
  const explicit = firstFiniteNumber(
    outcome.maxPostEntryReturnPct,
    metadata.maxPostEntryReturnPct
  );

  if (isFiniteNumber(explicit)) {
    return explicit;
  }

  const entryPrice = firstFiniteNumber(outcome.entryPrice, metadata.entryPrice);
  const peakPrice = firstFiniteNumber(
    outcome.peakPriceWithinWindow,
    metadata.peakPriceWithinWindow,
    outcome.peakPriceWithin30d,
    metadata.peakPriceWithin30d
  );

  if (isFiniteNumber(entryPrice) && entryPrice > 0 && isFiniteNumber(peakPrice)) {
    return Number((((peakPrice - entryPrice) / entryPrice) * 100).toFixed(1));
  }

  const measuredReturns = [
    outcome.return5d,
    outcome.return10d,
    outcome.return20d,
    outcome.return30d
  ].filter((value) => isFiniteNumber(value));

  if (measuredReturns.length) {
    return Number(Math.max(...measuredReturns).toFixed(1));
  }

  if (isFiniteNumber(outcome.resultPct)) {
    return outcome.resultPct;
  }

  return null;
}

function deriveHitFlag(outcome, metadata, fieldName, threshold, maxPostEntryReturnPct) {
  const explicit = firstBoolean(outcome[fieldName], metadata[fieldName]);

  if (typeof explicit === "boolean") {
    return explicit;
  }

  if (!isFiniteNumber(maxPostEntryReturnPct)) {
    return null;
  }

  return maxPostEntryReturnPct >= threshold;
}

function deriveFalsePositive(outcome, metadata, hit7pct, maxPostEntryReturnPct) {
  const explicit = firstBoolean(outcome.falsePositive, metadata.falsePositive);

  if (typeof explicit === "boolean") {
    return explicit;
  }

  if (outcome.failedFast === true) {
    return true;
  }

  if (outcome.outcomeLabel === "fallo") {
    if (typeof hit7pct === "boolean") {
      return hit7pct === false;
    }

    if (isFiniteNumber(maxPostEntryReturnPct)) {
      return maxPostEntryReturnPct < 7;
    }

    return true;
  }

  return false;
}

function normalizeOutcome(outcome) {
  const metadata = getMetadata(outcome);
  const assetType = deriveAssetType(outcome, metadata);
  const maxPostEntryReturnPct = deriveMaxPostEntryReturnPct(outcome, metadata);
  const hit7pct = deriveHitFlag(outcome, metadata, "hit7pct", 7, maxPostEntryReturnPct);
  const hit10pct = deriveHitFlag(outcome, metadata, "hit10pct", 10, maxPostEntryReturnPct);
  const hit15pct = deriveHitFlag(outcome, metadata, "hit15pct", 15, maxPostEntryReturnPct);

  return {
    assetType,
    catalystType: deriveCatalystType(outcome, metadata),
    daysToPeak: firstFiniteNumber(outcome.daysToPeak, metadata.daysToPeak),
    etfModule: deriveEtfModule(outcome, metadata, assetType),
    falsePositive: deriveFalsePositive(outcome, metadata, hit7pct, maxPostEntryReturnPct),
    horizon: outcome.horizon || "unknown",
    horizonDays: toHorizonDays(outcome.horizon),
    hit10pct,
    hit15pct,
    hit7pct,
    loggedAt: outcome.loggedAt || "",
    maxDrawdownPctBeforePeak: firstFiniteNumber(
      outcome.maxDrawdownPctBeforePeak,
      metadata.maxDrawdownPctBeforePeak
    ),
    maxPostEntryReturnPct,
    outcomeLabel: outcome.outcomeLabel || "unknown",
    playbookType: outcome.playbookType || "unknown",
    resolvedAt: outcome.resolvedAt || "",
    setupRankAtEntry: outcome.setupRankAtEntry || "unknown",
    ticker: outcome.ticker || "n/d"
  };
}

function summarizeBucket(outcomes) {
  const maxReturns = outcomes
    .map((outcome) => outcome.maxPostEntryReturnPct)
    .filter((value) => isFiniteNumber(value));
  const drawdowns = outcomes
    .map((outcome) => outcome.maxDrawdownPctBeforePeak)
    .filter((value) => isFiniteNumber(value));
  const daysToPeak = outcomes
    .map((outcome) => outcome.daysToPeak)
    .filter((value) => isFiniteNumber(value));
  const hit7Measured = outcomes.filter((outcome) => typeof outcome.hit7pct === "boolean");
  const hit10Measured = outcomes.filter((outcome) => typeof outcome.hit10pct === "boolean");
  const hit15Measured = outcomes.filter((outcome) => typeof outcome.hit15pct === "boolean");
  const falsePositiveMeasured = outcomes.filter((outcome) => typeof outcome.falsePositive === "boolean");

  return {
    assetMix: countBy(outcomes, (outcome) => outcome.assetType),
    avgDaysToPeak: average(daysToPeak),
    avgDrawdownPctBeforePeak: average(drawdowns),
    avgMaxPostEntryReturnPct: average(maxReturns),
    catalystMix: countBy(outcomes, (outcome) => outcome.catalystType),
    count: outcomes.length,
    falsePositiveCount: falsePositiveMeasured.filter((outcome) => outcome.falsePositive).length,
    falsePositiveMeasured: falsePositiveMeasured.length,
    hit10Count: hit10Measured.filter((outcome) => outcome.hit10pct).length,
    hit10Measured: hit10Measured.length,
    hit15Count: hit15Measured.filter((outcome) => outcome.hit15pct).length,
    hit15Measured: hit15Measured.length,
    hit7Count: hit7Measured.filter((outcome) => outcome.hit7pct).length,
    hit7Measured: hit7Measured.length,
    playbookMix: countBy(outcomes, (outcome) => outcome.playbookType),
    rankedMix: countBy(outcomes, (outcome) => outcome.setupRankAtEntry)
  };
}

function rateLine(hitCount, measured) {
  if (!measured) {
    return "n/d";
  }

  return `${Number(((hitCount / measured) * 100).toFixed(1))}% (${hitCount}/${measured})`;
}

function renderPositions(positions) {
  if (!positions.length) {
    return "- Cartera vacia. WALY esta en modo 100% cash.";
  }

  return positions
    .map((position) => {
      const parts = [
        `**${position.ticker}**`,
        position.status,
        `qty ${position.quantity}`,
        `avg ${position.avgPrice}`,
        `last ${position.lastPrice || "n/d"}`,
        `setup ${position.setupType || "n/d"}`,
        `playbook ${position.playbookType || "n/d"}`
      ];

      if (position.catalystType) {
        parts.push(`catalyst ${position.catalystType}`);
      }

      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

function renderBucketSummary(summary) {
  if (!summary.count) {
    return "- Sin muestra resuelta.";
  }

  return [
    `- Muestra ${summary.count} | retorno max posterior promedio ${formatPercent(summary.avgMaxPostEntryReturnPct)} | max drawdown promedio ${formatPercent(summary.avgDrawdownPctBeforePeak, { signed: false })} | dias a pico ${formatNumber(summary.avgDaysToPeak)}`,
    `- Hit +7% ${rateLine(summary.hit7Count, summary.hit7Measured)} | Hit +10% ${rateLine(summary.hit10Count, summary.hit10Measured)} | Hit +15% ${rateLine(summary.hit15Count, summary.hit15Measured)} | falso positivo ${rateLine(summary.falsePositiveCount, summary.falsePositiveMeasured)}`,
    `- SetupRank mix: ${renderMix(summary.rankedMix)}`,
    `- Catalyst mix: ${renderMix(summary.catalystMix)}`,
    `- Playbook mix: ${renderMix(summary.playbookMix)}`,
    `- Asset mix: ${renderMix(summary.assetMix)}`
  ].join("\n");
}

function renderOutcomesTable(outcomes) {
  if (!outcomes.length) {
    return "_Sin setups resueltos en esta muestra._";
  }

  const header = [
    "| ticker | horizon | maxReturn | maxDD | hit7 | hit10 | hit15 | diasPico | falsoPositivo | rank | catalyst | playbook | asset |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];

  const rows = outcomes.map((outcome) =>
    [
      outcome.ticker,
      outcome.horizon,
      formatPercent(outcome.maxPostEntryReturnPct),
      formatPercent(outcome.maxDrawdownPctBeforePeak, { signed: false }),
      formatBoolean(outcome.hit7pct),
      formatBoolean(outcome.hit10pct),
      formatBoolean(outcome.hit15pct),
      formatNumber(outcome.daysToPeak),
      formatBoolean(outcome.falsePositive),
      outcome.setupRankAtEntry,
      outcome.catalystType,
      outcome.playbookType,
      outcome.assetType
    ].join(" | ")
  );

  return [...header, ...rows.map((row) => `| ${row} |`)].join("\n");
}

function renderUniverseSection(outcomes) {
  return UNIVERSE_SEGMENTS.map((segment) => {
    const filtered = outcomes.filter(segment.predicate);
    return [
      `### ${segment.label}`,
      renderBucketSummary(summarizeBucket(filtered))
    ].join("\n");
  }).join("\n\n");
}

function renderHorizonSections(outcomes) {
  return HORIZON_ORDER.map((horizon) => {
    const filtered = outcomes.filter((outcome) => outcome.horizon === horizon);
    return [
      `## Horizonte ${horizon}`,
      renderBucketSummary(summarizeBucket(filtered)),
      "",
      renderOutcomesTable(filtered)
    ].join("\n");
  }).join("\n\n");
}

function renderPlaybookSections(outcomes) {
  const discoveredPlaybooks = countBy(outcomes, (outcome) => outcome.playbookType).map((item) => item.key);
  const playbooks = ["event-swing", "outlier", ...discoveredPlaybooks.filter((item) => item !== "event-swing" && item !== "outlier")];

  return [
    "## Playbooks",
    ...playbooks.map((playbook) => {
      const filtered = outcomes.filter((outcome) => outcome.playbookType === playbook);
      return [
        `### ${playbook}`,
        renderBucketSummary(summarizeBucket(filtered))
      ].join("\n");
    })
  ].join("\n\n");
}

function generateBacktestReport(options = {}) {
  const { dryRun = false } = options;
  const state = loadState();
  const resolvedOutcomes = (state.outcomes.outcomes || [])
    .filter((outcome) => outcome.outcomeLabel !== "abierto")
    .map(normalizeOutcome)
    .sort(compareResolvedDates);
  const openOutcomes = (state.outcomes.outcomes || []).filter((outcome) => outcome.outcomeLabel === "abierto");
  const overallSummary = summarizeBucket(resolvedOutcomes);
  const reportDate = state.currentDate;
  const markdown = [
    `# ${state.settings.projectName} - WALY 2.5 Outcome Backtest Summary ${reportDate}`,
    "",
    "_Outcome summary generado desde outcomes registrados manualmente. No es simulacion ex-ante ni backtest historico con precios reales._",
    "",
    "## Cartera actual",
    renderPositions(state.positions.positions || []),
    "",
    "## Lectura general",
    `- Outcomes resueltos ${resolvedOutcomes.length} | outcomes abiertos ${openOutcomes.length}`,
    renderBucketSummary(overallSummary),
    "",
    "## Universo",
    renderUniverseSection(resolvedOutcomes),
    "",
    renderPlaybookSections(resolvedOutcomes),
    "",
    renderHorizonSections(resolvedOutcomes),
    "",
    "## Supuestos de lectura",
    "- `assetType` cae en `equity` por defecto cuando el outcome no trae estructura ETF explicita.",
    "- `hit +7%`, `hit +10%` y `hit +15%` se infieren desde `maxPostEntryReturnPct` si el booleano no viene cargado.",
    "- `falso positivo` se infiere desde `falsePositive` si existe; si no, usa `failedFast` o `fallo` sin haber tocado `+7%`.",
    "- Este modulo usa solo outcomes ya registrados; no genera senales, no consulta precios historicos y no tiene checkpoint/resume."
  ].join("\n");

  if (dryRun) {
    return {
      isDryRun: true,
      markdown,
      outputPath: null,
      sampleSize: resolvedOutcomes.length
    };
  }

  const outputName = `${state.settings.reportPrefix || "waly"}-outcome-summary-${reportDate}.md`;
  const outputPath = writeBacktestOutput(outputName, markdown);

  return {
    isDryRun: false,
    markdown,
    outputPath: path.resolve(outputPath),
    sampleSize: resolvedOutcomes.length
  };
}

module.exports = {
  generateBacktestReport
};
