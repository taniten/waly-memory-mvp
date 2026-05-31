"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXAMPLE_PATH = path.join(ROOT_DIR, "examples", "biotech-binary-events-expanded.example.json");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "biotech-binary-dataset-expansion");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const TARGET_SAMPLE_SIZE = 100;

const REQUIRED_FIELDS = [
  "ticker",
  "company",
  "eventDate",
  "knownFromDate",
  "signalDate",
  "catalystType",
  "asset",
  "indication",
  "phase",
  "endpointType",
  "primaryEndpointMet",
  "secondaryEndpointMet",
  "outcome",
  "thesisAfterEvent",
  "marketCapAtSignal",
  "enterpriseValueAtSignal",
  "cashRunwayMonths",
  "singleAssetDependency",
  "productDependencyPctEstimate",
  "hasRevenue",
  "hasApprovedProducts",
  "hasRecentOffering",
  "needsFinancingWithin12m",
  "runup30dPct",
  "runup10dPct",
  "priceT30",
  "priceT10",
  "priceT5",
  "priceT1",
  "priceD0",
  "priceD1",
  "priceD5",
  "priceD20",
  "maxGapDownD1",
  "maxAdverseMoveIfShort",
  "sourcePrimary",
  "sourceSecondary",
  "notes"
];

const CRITICAL_SHORT_EDGE_FIELDS = [
  "eventDate",
  "knownFromDate",
  "signalDate",
  "catalystType",
  "outcome",
  "thesisAfterEvent",
  "marketCapAtSignal",
  "cashRunwayMonths",
  "singleAssetDependency",
  "hasApprovedProducts",
  "needsFinancingWithin12m",
  "runup30dPct",
  "priceT30",
  "priceT10",
  "priceT5",
  "priceT1",
  "priceD0",
  "priceD1",
  "priceD5",
  "priceD20",
  "maxAdverseMoveIfShort",
  "sourcePrimary",
  "sourceSecondary"
];

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("biotech-binary-dataset-expansion solo puede escribir dentro de backtests/biotech-binary-dataset-expansion/.");
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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
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

function valueMissing(value) {
  return value === undefined || value === null || value === "";
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function lookaheadSafe(event) {
  return (
    validDate(event.knownFromDate) &&
    validDate(event.signalDate) &&
    validDate(event.eventDate) &&
    event.knownFromDate <= event.signalDate &&
    event.signalDate <= event.eventDate
  );
}

function normalizedEvent(raw, index) {
  const event = { ...raw, ticker: normalizeTicker(raw && raw.ticker) };
  const missingFields = REQUIRED_FIELDS.filter((field) => valueMissing(event[field]));
  const missingCriticalFields = CRITICAL_SHORT_EDGE_FIELDS.filter((field) => valueMissing(event[field]));
  const warnings = [];

  if (!lookaheadSafe(event)) {
    warnings.push("lookahead_or_invalid_dates");
  }

  if (event.sourcePrimary === "manual_verification_required") {
    warnings.push("primary_source_not_verified");
  }

  const binaryFragilityScore = scoreFragility(event);
  const classification = classifyEvent(event, binaryFragilityScore);

  return {
    ...event,
    binaryFragilityScore,
    classification,
    completeForShortEdge: missingCriticalFields.length === 0 && warnings.indexOf("lookahead_or_invalid_dates") === -1,
    missingCriticalFields,
    missingFields,
    rowIndex: index,
    warnings
  };
}

function scoreFragility(event) {
  let score = 0;

  if (event.singleAssetDependency === true) score += 18;
  if (event.hasApprovedProducts === false) score += 14;
  if (isFiniteNumber(event.cashRunwayMonths) && event.cashRunwayMonths < 12) score += 12;
  if (isFiniteNumber(event.marketCapAtSignal) && event.marketCapAtSignal < 2000000000) score += 10;
  if (isFiniteNumber(event.runup30dPct) && event.runup30dPct > 30) score += 12;
  if (["phase3_topline", "pdufa", "fda_approval", "crl"].includes(event.catalystType)) score += 12;
  if (event.endpointType === "hard_clinical" || event.endpointType === "regulatory") score += 8;
  if (event.needsFinancingWithin12m === true) score += 8;
  if (/ambiguity|mixed|prior|uncertain/i.test(String(event.notes || ""))) score += 6;

  return Math.min(100, score);
}

function classifyEvent(event, score) {
  if (isFiniteNumber(event.maxAdverseMoveIfShort) && event.maxAdverseMoveIfShort >= 15) {
    return "avoid_short_tail_risk";
  }

  if (event.thesisAfterEvent === "broken" || event.outcome === "endpoint_failure" || event.outcome === "crl" || event.outcome === "trial_halt") {
    return "post_failure_candidate";
  }

  if (isFiniteNumber(event.runup30dPct) && event.runup30dPct > 50) {
    return "overhyped_runup";
  }

  if (score >= 70) {
    return "fragile_binary";
  }

  if (event.hasApprovedProducts === true || event.singleAssetDependency === false) {
    return "diversified_binary";
  }

  return "no_trade";
}

function countBy(items, selector) {
  const counts = {};
  items.forEach((item) => {
    const key = selector(item);
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function aggregateMissingFields(events) {
  const counts = {};
  events.forEach((event) => {
    event.missingFields.forEach((field) => {
      counts[field] = (counts[field] || 0) + 1;
    });
  });
  return Object.entries(counts)
    .map(([field, count]) => ({ count, field }))
    .sort((left, right) => right.count - left.count || left.field.localeCompare(right.field));
}

function buildPayload() {
  const source = readJson(EXAMPLE_PATH);
  const events = ((source && source.events) || []).map(normalizedEvent);
  const completeEvents = events.filter((event) => event.missingFields.length === 0 && event.warnings.indexOf("lookahead_or_invalid_dates") === -1);
  const completeForShortEdge = events.filter((event) => event.completeForShortEdge);
  const targetSampleSize = source.targetSampleSize || TARGET_SAMPLE_SIZE;
  const sampleGap = Math.max(0, targetSampleSize - completeForShortEdge.length);

  return {
    classifications: countBy(events, (event) => event.classification),
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
      "Output solo en backtests/biotech-binary-dataset-expansion/."
    ],
    events,
    generatedAt: new Date().toISOString(),
    manualLoadQueue: source.manualLoadQueue || [],
    missingFields: aggregateMissingFields(events),
    mode: "research-only",
    scores: events.map((event) => ({
      binaryFragilityScore: event.binaryFragilityScore,
      classification: event.classification,
      missingCriticalFields: event.missingCriticalFields,
      ticker: event.ticker
    })),
    sourcePath: formatRelative(EXAMPLE_PATH),
    summary: {
      completeEvents: completeEvents.length,
      completeForShortEdge: completeForShortEdge.length,
      eventsCreated: events.length,
      sampleGap,
      targetSampleSize
    }
  };
}

function renderEventsTable(events) {
  const lines = [
    "| Ticker | Event | Score | Classification | Missing critical | Warnings |",
    "| --- | --- | ---: | --- | --- | --- |"
  ];

  events.forEach((event) => {
    lines.push(`| ${event.ticker} | ${event.catalystType} ${event.eventDate} | ${event.binaryFragilityScore} | ${event.classification} | ${event.missingCriticalFields.join(", ") || "none"} | ${event.warnings.join(", ") || "none"} |`);
  });

  return lines.join("\n");
}

function renderSummary(payload) {
  const complete = payload.events.filter((event) => event.missingFields.length === 0);
  const criticalFields = CRITICAL_SHORT_EDGE_FIELDS.join(", ");
  const priority = [
    "1. Complete OCS/ATYR/SAVA/FREQ failure rows with verified primary sources and OHLC prices.",
    "2. Add 30 failed endpoint/CRL/trial-halt rows first; they define post-failure behavior.",
    "3. Add 30 approval/runup rows next; they measure sell-the-news and short tail risk.",
    "4. Fill market cap, EV, cash runway and financing fields before trusting fragility score.",
    "5. Only after 100+ complete rows compare pre-event short vs post-failure short."
  ];
  const lines = [];

  lines.push("# WALY Biotech Binary Dataset Expansion v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: research-only. No opera, no usa IBKR, no usa Binance, no envia ordenes.");
  lines.push("");
  lines.push("## Resumen");
  lines.push(`- Eventos ejemplo creados: ${payload.summary.eventsCreated}`);
  lines.push(`- Eventos completos: ${payload.summary.completeEvents}`);
  lines.push(`- Eventos completos para short edge: ${payload.summary.completeForShortEdge}`);
  lines.push(`- Target sample: ${payload.summary.targetSampleSize}`);
  lines.push(`- Faltan para target: ${payload.summary.sampleGap}`);
  lines.push("");
  lines.push("## Eventos");
  lines.push(renderEventsTable(payload.events));
  lines.push("");
  lines.push("## 1. Que datos faltan");
  payload.missingFields.forEach((row) => lines.push(`- ${row.field}: ${row.count}`));
  if (!payload.missingFields.length) lines.push("- Ninguno.");
  lines.push("");
  lines.push("## 2. Eventos del ejemplo ya completos");
  lines.push(complete.length ? complete.map((event) => `- ${event.ticker}: ${event.catalystType} ${event.eventDate}`).join("\n") : "- Ninguno.");
  lines.push("");
  lines.push("## 3. Campos criticos para validar short edge");
  lines.push(`- ${criticalFields}`);
  lines.push("");
  lines.push("## 4. Tamano de muestra faltante");
  lines.push(`- Faltan ${payload.summary.sampleGap} eventos completos para llegar a ${payload.summary.targetSampleSize}.`);
  lines.push("");
  lines.push("## 5. Priorizacion de carga");
  priority.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## 6. Tickers/eventos sugeridos");
  payload.manualLoadQueue.forEach((item) => lines.push(`- ${item}`));
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
  const scored = payload.scores.map((row) => `${row.ticker}:${row.binaryFragilityScore}:${row.classification}`);

  return [
    "WALY Biotech Binary Dataset Expansion v1 generado.",
    `Eventos ejemplo creados: ${payload.summary.eventsCreated}`,
    `Eventos completos para short edge: ${payload.summary.completeForShortEdge}`,
    `Faltan para target: ${payload.summary.sampleGap}`,
    `Scores: ${scored.join(" | ")}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no commit, no push."
  ].join("\n");
}

function runBiotechBinaryDatasetExpansion(options = {}) {
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
  runBiotechBinaryDatasetExpansion
};
