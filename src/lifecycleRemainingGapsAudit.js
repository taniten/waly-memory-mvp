"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "lifecycle-remaining-gaps-audit");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const MANUAL_DECISIONS_PATH = path.join(OUTPUT_DIR, "manual_decisions_required.json");

const INPUT_PATHS = Object.freeze({
  positions: "data/positions.json",
  failureAuditLifecycleGuardLatest: "backtests/failure-audit-lifecycle-guard/latest.json",
  dailyRunLatest: "backtests/daily-run/latest.json",
  lifecycleCompletionApplyLatest: "backtests/lifecycle-completion-apply/latest.json"
});

const CONFIRMATIONS = Object.freeze([
  "No opera.",
  "No usa IBKR.",
  "No usa Binance.",
  "No envia ordenes.",
  "No modifica data/*.json.",
  "No modifica outcomes.",
  "No modifica social_signals.",
  "No commit.",
  "No push.",
  "Read-only."
]);

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("lifecycle-remaining-gaps-audit solo puede escribir dentro de backtests/lifecycle-remaining-gaps-audit/.");
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

function readJsonInput(relativePath, required = true) {
  const filePath = path.join(ROOT_DIR, relativePath);

  try {
    return {
      exists: true,
      path: relativePath,
      value: JSON.parse(fs.readFileSync(filePath, "utf8"))
    };
  } catch (error) {
    if (error && error.code === "ENOENT" && !required) {
      return {
        exists: false,
        path: relativePath,
        value: null
      };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${relativePath}: ${error.message}`);
    }

    throw error;
  }
}

function buildInputs() {
  return {
    positions: readJsonInput(INPUT_PATHS.positions),
    failureAuditLifecycleGuardLatest: readJsonInput(INPUT_PATHS.failureAuditLifecycleGuardLatest, false),
    dailyRunLatest: readJsonInput(INPUT_PATHS.dailyRunLatest, false),
    lifecycleCompletionApplyLatest: readJsonInput(INPUT_PATHS.lifecycleCompletionApplyLatest, false)
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function positionsByTicker(inputs) {
  return new Map(
    asArray(inputs.positions.value && inputs.positions.value.positions)
      .filter((position) => Number(position.quantity || position.qty || 0) > 0)
      .map((position) => [normalizeTicker(position.ticker), position])
  );
}

function lifecycleRowsByTicker(inputs) {
  const rows =
    inputs.failureAuditLifecycleGuardLatest.value &&
    inputs.failureAuditLifecycleGuardLatest.value.lifecycle &&
    inputs.failureAuditLifecycleGuardLatest.value.lifecycle.positions;

  return new Map(asArray(rows).map((row) => [normalizeTicker(row.ticker), row]));
}

function dailyIncompleteTickers(inputs) {
  return asArray(inputs.dailyRunLatest.value && inputs.dailyRunLatest.value.lifecycleIncompletePositions)
    .map((row) => normalizeTicker(row && (row.ticker || row)))
    .filter(Boolean);
}

function dailyRiskReview(inputs) {
  return asArray(inputs.dailyRunLatest.value && inputs.dailyRunLatest.value.riskReview)
    .map(normalizeTicker)
    .filter(Boolean);
}

function hasManualPlaceholder(value) {
  if (Array.isArray(value)) {
    return value.some(hasManualPlaceholder);
  }

  if (value && typeof value === "object") {
    return Object.values(value).some(hasManualPlaceholder);
  }

  return /manual_required|manual_review_required/.test(String(value || ""));
}

function positionManualFields(position) {
  return Object.entries(position || {})
    .filter(([, value]) => hasManualPlaceholder(value))
    .map(([field]) => field)
    .sort();
}

function buildOcsGap(position, lifecycleRow) {
  return {
    ticker: "OCS",
    lifecycleStatus: lifecycleRow && lifecycleRow.lifecycleStatus || "incomplete",
    missingFields: lifecycleRow && lifecycleRow.missingLifecycleFields || [],
    blockingReason: "thesis_broken_position_still_open",
    isExpectedBlocker: true,
    humanDecisionRequired: true,
    recommendedDecisionFields: {
      currentQtyConfirmedInBroker: "manual_required",
      sellOrReduceDecision: "manual_required",
      brokerCheckCompletedAt: "manual_required",
      markPositionClosedAfterSale: "manual_required",
      keepInRiskReviewUntilClosedOrReduced: true
    },
    currentState: {
      keepPositionUntilHumanConfirmsSale: position.keepPositionUntilHumanConfirmsSale === true,
      quantity: position.quantity || null,
      riskStatus: position.riskStatus || null,
      suggestedAction: position.suggestedAction || null,
      thesisStatus: position.thesisStatus || null
    },
    explanation: "OCS no debe completarse como posicion sana: la tesis esta rota, hay freeze, y la posicion sigue abierta hasta ejecucion humana."
  };
}

function buildVktxGap(position, lifecycleRow) {
  const guardMissing = lifecycleRow && lifecycleRow.missingLifecycleFields || [];
  const manualFields = positionManualFields(position);
  const missingFields = [...new Set([...guardMissing, ...manualFields])];

  return {
    ticker: "VKTX",
    lifecycleStatus: missingFields.length ? "incomplete" : lifecycleRow && lifecycleRow.lifecycleStatus || "complete",
    missingFields,
    blockingReason: "valuation_repricing_requires_human_risk_limits",
    isExpectedBlocker: false,
    humanDecisionRequired: true,
    recommendedDecisionFields: {
      targetAllocationPct: "manual_required",
      reduceIfPositionPctAbove: "manual_required",
      maxLossAcceptedPct: "manual_required",
      maxLossAcceptedUSD: "manual_required",
      thesisReviewCadence: "weekly",
      noAddUntilCatalystVerified: true,
      valuationTrigger: "manual_required"
    },
    currentState: {
      catalystStatus: position.catalystStatus || null,
      maxLossAccepted: position.maxLossAccepted || null,
      noAddUntilLifecycleComplete: position.noAddUntilLifecycleComplete === true,
      quantity: position.quantity || null,
      tradeType: position.tradeType || null
    },
    explanation: "VKTX sigue incompleto porque el trade de valuation_repricing necesita un valuationTrigger y limites humanos de asignacion/reduccion; maxLossAccepted todavia es placeholder manual_required."
  };
}

function buildVrdnConfirmation(position, lifecycleRow) {
  const missingFields = lifecycleRow && lifecycleRow.missingLifecycleFields || [];

  return {
    ticker: "VRDN",
    lifecycleStatus: missingFields.length ? "incomplete" : "complete_enough_current_phase",
    missingFields,
    blockingReason: missingFields.length ? "unexpected_remaining_lifecycle_gap" : "none",
    isExpectedBlocker: false,
    humanDecisionRequired: missingFields.length > 0,
    recommendedDecisionFields: missingFields.length
      ? { resolveUnexpectedMissingFields: missingFields }
      : {
          lifecycleCompleteEnoughForCurrentPhase: true,
          stillNoAddUnlessRiskApproved: true,
          exitBeforeEventDate: position.exitBeforeEventDate || "2026-06-24",
          reviewDate: position.reviewDate || "2026-06-17"
        },
    currentState: {
      binaryMode: position.binaryMode || null,
      exitBeforeEventDate: position.exitBeforeEventDate || null,
      explicitHoldThroughBinary: position.explicitHoldThroughBinary === true,
      noAddUntilLifecycleComplete: position.noAddUntilLifecycleComplete === true,
      reviewDate: position.reviewDate || null,
      tradeType: position.tradeType || null
    },
    explanation: missingFields.length
      ? "VRDN todavia aparece con gaps inesperados en el lifecycle guard."
      : "VRDN ya esta completo para la fase actual: runup antes de PDUFA, sin hold-through por defecto y con fechas de review/salida."
  };
}

function buildRows(inputs) {
  const positions = positionsByTicker(inputs);
  const lifecycleRows = lifecycleRowsByTicker(inputs);

  return [
    buildVktxGap(positions.get("VKTX") || {}, lifecycleRows.get("VKTX") || null),
    buildOcsGap(positions.get("OCS") || {}, lifecycleRows.get("OCS") || null),
    buildVrdnConfirmation(positions.get("VRDN") || {}, lifecycleRows.get("VRDN") || null)
  ];
}

function buildManualDecisions(rows) {
  return rows
    .filter((row) => row.humanDecisionRequired)
    .map((row) => ({
      blockingReason: row.blockingReason,
      recommendedDecisionFields: row.recommendedDecisionFields,
      ticker: row.ticker
    }));
}

function buildSummary(payload) {
  const lines = [];

  lines.push("# WALY Lifecycle Remaining Gaps Audit v1");
  lines.push("");
  lines.push(`generatedAt: ${payload.generatedAt}`);
  lines.push(`mode: ${payload.mode}`);
  lines.push(`dataRealModified: ${payload.dataRealModified ? "true" : "false"}`);
  lines.push("");
  lines.push("## Remaining gaps");
  payload.rows.forEach((row) => {
    lines.push(`### ${row.ticker}`);
    lines.push(`- lifecycleStatus: ${row.lifecycleStatus}`);
    lines.push(`- missingFields: ${row.missingFields.length ? row.missingFields.join(", ") : "ninguno"}`);
    lines.push(`- blockingReason: ${row.blockingReason}`);
    lines.push(`- isExpectedBlocker: ${row.isExpectedBlocker ? "true" : "false"}`);
    lines.push(`- humanDecisionRequired: ${row.humanDecisionRequired ? "true" : "false"}`);
    lines.push(`- explanation: ${row.explanation}`);
    lines.push("");
  });
  lines.push("## Decisiones humanas requeridas");
  if (!payload.manualDecisionsRequired.length) {
    lines.push("- Ninguna.");
  } else {
    payload.manualDecisionsRequired.forEach((row) => {
      lines.push(`### ${row.ticker}`);
      Object.entries(row.recommendedDecisionFields).forEach(([field, value]) => {
        lines.push(`- ${field}: ${Array.isArray(value) ? value.join(", ") : value}`);
      });
      lines.push("");
    });
  }
  lines.push("## Inputs");
  Object.entries(payload.inputStatus).forEach(([key, value]) => {
    lines.push(`- ${key}: ${value.exists ? "ok" : "missing"} | ${value.path}`);
  });
  lines.push("");
  lines.push("## Confirmaciones");
  payload.confirmations.forEach((confirmation) => lines.push(`- ${confirmation}`));

  return `${lines.join("\n")}\n`;
}

function buildConsoleReport(payload, paths) {
  const vktx = payload.rows.find((row) => row.ticker === "VKTX");
  const ocs = payload.rows.find((row) => row.ticker === "OCS");
  const vrdn = payload.rows.find((row) => row.ticker === "VRDN");

  return [
    "WALY Lifecycle Remaining Gaps Audit v1 generado.",
    `mode: ${payload.mode}`,
    `VKTX: ${vktx.blockingReason} | missing=${vktx.missingFields.join(", ") || "ninguno"} | humanDecisionRequired=${vktx.humanDecisionRequired ? "true" : "false"}`,
    `OCS: ${ocs.blockingReason} | missing=${ocs.missingFields.join(", ") || "ninguno"} | expectedBlocker=${ocs.isExpectedBlocker ? "true" : "false"}`,
    `VRDN: ${vrdn.lifecycleStatus} | exitBeforeEventDate=${vrdn.currentState.exitBeforeEventDate || "n/d"} | reviewDate=${vrdn.currentState.reviewDate || "n/d"}`,
    `manualDecisionsRequired: ${payload.manualDecisionsRequired.map((row) => row.ticker).join(", ") || "ninguno"}`,
    `dailyLifecycleIncompletePositions: ${payload.dailyLifecycleIncompletePositions.join(", ") || "ninguna"}`,
    `dailyRiskReview: ${payload.dailyRiskReview.join(", ") || "ninguno"}`,
    `dataRealModified: ${payload.dataRealModified ? "true" : "false"}`,
    `latest.json: ${formatRelative(paths.latestPath)}`,
    `summary.md: ${formatRelative(paths.summaryPath)}`,
    `manual_decisions_required.json: ${formatRelative(paths.manualDecisionsPath)}`,
    `safe-to-commit: ${payload.safeToCommit ? "yes" : "no"}`,
    "Confirmacion: no data real modificada, no IBKR, no Binance, no ordenes, no commit, no push."
  ].join("\n");
}

function buildPayload() {
  const inputs = buildInputs();
  const rows = buildRows(inputs);
  const manualDecisionsRequired = buildManualDecisions(rows);

  return {
    confirmations: CONFIRMATIONS,
    dailyLifecycleIncompletePositions: dailyIncompleteTickers(inputs),
    dailyRiskReview: dailyRiskReview(inputs),
    dataRealModified: false,
    generatedAt: new Date().toISOString(),
    inputStatus: Object.fromEntries(
      Object.entries(inputs).map(([key, input]) => [
        key,
        {
          exists: input.exists,
          path: input.path
        }
      ])
    ),
    manualDecisionsRequired,
    mode: "read-only",
    outputScope: "backtests/lifecycle-remaining-gaps-audit/",
    rows,
    safeToCommit: true,
    safeToOperate: false,
    touchedDataReal: false,
    touchedOutcomes: false,
    touchedSocialSignals: false
  };
}

function runLifecycleRemainingGapsAudit() {
  const payload = buildPayload();
  const paths = {
    latestPath: writeJson(LATEST_PATH, payload),
    manualDecisionsPath: writeJson(MANUAL_DECISIONS_PATH, payload.manualDecisionsRequired),
    summaryPath: writeText(SUMMARY_PATH, buildSummary(payload))
  };

  return {
    consoleReport: buildConsoleReport(payload, paths),
    paths,
    payload
  };
}

module.exports = {
  buildPayload,
  runLifecycleRemainingGapsAudit
};
