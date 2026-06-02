"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "lifecycle-completion-plan");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const PROPOSED_FIELDS_PATH = path.join(OUTPUT_DIR, "proposed_lifecycle_fields.json");

const INPUT_PATHS = Object.freeze({
  positions: "data/positions.json",
  watchlist: "data/watchlist.json",
  fda: "data/fda.json",
  dailyLog: "data/daily_log.json",
  failureAuditLifecycleGuardLatest: "backtests/failure-audit-lifecycle-guard/latest.json",
  dailyRunLatest: "backtests/daily-run/latest.json",
  dataHygieneAuditLatest: "backtests/data-hygiene-audit/latest.json"
});

const TARGET_TICKERS = Object.freeze(["VKTX", "VRDN", "OCS"]);

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
  "Dry-run / research-only.",
  "Output solo en backtests/lifecycle-completion-plan/."
]);

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("lifecycle-completion-plan solo puede escribir dentro de backtests/lifecycle-completion-plan/.");
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
    watchlist: readJsonInput(INPUT_PATHS.watchlist),
    fda: readJsonInput(INPUT_PATHS.fda, false),
    dailyLog: readJsonInput(INPUT_PATHS.dailyLog, false),
    failureAuditLifecycleGuardLatest: readJsonInput(INPUT_PATHS.failureAuditLifecycleGuardLatest, false),
    dailyRunLatest: readJsonInput(INPUT_PATHS.dailyRunLatest, false),
    dataHygieneAuditLatest: readJsonInput(INPUT_PATHS.dataHygieneAuditLatest, false)
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

function lifecycleGuardRowsByTicker(inputs) {
  const rows =
    inputs.failureAuditLifecycleGuardLatest.value &&
    inputs.failureAuditLifecycleGuardLatest.value.lifecycle &&
    inputs.failureAuditLifecycleGuardLatest.value.lifecycle.positions;

  return new Map(asArray(rows).map((row) => [normalizeTicker(row.ticker), row]));
}

function selectorRowsByTicker(inputs) {
  const ranking =
    inputs.dailyRunLatest.value &&
    Array.isArray(inputs.dailyRunLatest.value.ranking)
      ? inputs.dailyRunLatest.value.ranking
      : [];

  return new Map(ranking.map((row) => [normalizeTicker(row.ticker), row]));
}

function buildOcsProposal(position, lifecycleRow, selectorRow) {
  return {
    ticker: "OCS",
    currentState: {
      classification: selectorRow && (selectorRow.classification || selectorRow.pipelineClassification) || "discard",
      lifecycleStatus: lifecycleRow && lifecycleRow.lifecycleStatus || "incomplete",
      noAdd: position.noAdd === true,
      quantity: position.quantity,
      reviewStatus: position.reviewStatus || null,
      riskStatus: position.riskStatus || null,
      status: position.status || null,
      suggestedAction: position.suggestedAction || null,
      thesisStatus: position.thesisStatus || null
    },
    proposedLifecycleFields: {
      tradeType: "binary_runup",
      lifecycleStatus: "thesis_broken",
      entryThesis: "OCS-01 / DIAMOND DME topline catalyst.",
      actualFailure: "Phase 3 DIAMOND failed primary/key secondary; no FDA filing for DME currently planned.",
      expectedPath: "cerrado; ya no hay upside thesis original.",
      invalidationRule: "already_invalidated.",
      exitRule: "exit_or_reduce_after_news_confirmed.",
      nextAction: "reduce_or_exit_position_after_manual_broker_check.",
      noAdd: true,
      maxLossAccepted: "already_exceeded_or_manual_review.",
      positionMustRemainInPositionsUntilHumanConfirmsSale: true
    },
    humanConfirmationRequired: [
      "confirm_actual_qty_before_any_exit",
      "confirm_manual_broker_check",
      "confirm_news_primary_source",
      "confirm_exit_or_reduce_decision",
      "confirm_position_remains_in_positions_until_sale"
    ],
    dryRunAction: "plan_only_no_data_write",
    safeToOperate: false
  };
}

function buildVrdnProposal(position, lifecycleRow, selectorRow) {
  return {
    ticker: "VRDN",
    currentState: {
      classification: selectorRow && (selectorRow.classification || selectorRow.pipelineClassification) || "C research",
      catalystDate: position.catalystDate || "2026-06-30",
      lifecycleStatus: lifecycleRow && lifecycleRow.lifecycleStatus || "incomplete",
      noAdd: position.noAdd === true,
      quantity: position.quantity,
      status: position.status || null
    },
    proposedLifecycleFields: {
      tradeType: "binary_runup",
      binaryMode: "runup_exit_before_event",
      explicitHoldThroughBinary: false,
      catalystDate: "2026-06-30",
      exitBeforeEventDate: "2026-06-24",
      reviewDate: "2026-06-17",
      entryThesis: "PDUFA/approval repricing setup, not hold-through by default.",
      expectedPath: "repricing/run-up before PDUFA, reduce before binary decision.",
      invalidationRule: [
        "negative FDA/regulatory update",
        "failed liquidity/spread",
        "severe drawdown/shock",
        "thesis/source mismatch"
      ],
      exitRule: [
        "reduce/sell before PDUFA unless explicitHoldThroughBinary=true",
        "no adding if lifecycle incomplete"
      ],
      maxLossAccepted: "manual_required",
      noAddUntilLifecycleComplete: true
    },
    humanConfirmationRequired: [
      "confirm_pdufa_date_2026-06-30",
      "confirm_exit_before_event_date_2026-06-24",
      "confirm_maxLossAccepted",
      "confirm_no_hold_through_binary",
      "confirm_liquidity_spread_before_any_new_exposure"
    ],
    dryRunAction: "plan_only_no_data_write",
    safeToOperate: false
  };
}

function buildVktxProposal(position, lifecycleRow, selectorRow) {
  return {
    ticker: "VKTX",
    currentState: {
      catalystStatus: position.catalystStatus || "research",
      classification: selectorRow && (selectorRow.classification || selectorRow.pipelineClassification) || "C research",
      lifecycleStatus: lifecycleRow && lifecycleRow.lifecycleStatus || "incomplete",
      noAPlusUntilCatalystVerified: position.noAPlusUntilCatalystVerified === true,
      quantity: position.quantity,
      status: position.status || null
    },
    proposedLifecycleFields: {
      tradeType: "valuation_repricing",
      binaryMode: "none",
      catalystStatus: "research",
      entryThesis: "tactical valuation/repricing/event-swing around obesity/metabolic optionality; no A+ until catalyst verified.",
      expectedPath: "repricing or strategic interest; not binary hold.",
      thesisReviewDate: "weekly_review",
      timeStop: "weekly_review_until_catalyst_verified_or_reduce",
      invalidationRule: [
        "catalyst no verificable",
        "breakdown tecnico/material",
        "adverse clinical/regulatory update",
        "position too large relative to portfolio"
      ],
      exitRule: [
        "reduce if position > target allocation",
        "no add until catalyst verified and lifecycle complete"
      ],
      maxLossAccepted: "manual_required",
      noAddUntilLifecycleComplete: true
    },
    humanConfirmationRequired: [
      "confirm_target_allocation",
      "confirm_maxLossAccepted",
      "confirm_catalyst_verification_status",
      "confirm_weekly_review_cadence",
      "confirm_reduce_threshold"
    ],
    dryRunAction: "plan_only_no_data_write",
    safeToOperate: false
  };
}

function buildPlanRows(inputs) {
  const positions = positionsByTicker(inputs);
  const lifecycleRows = lifecycleGuardRowsByTicker(inputs);
  const selectorRows = selectorRowsByTicker(inputs);
  const builders = {
    OCS: buildOcsProposal,
    VKTX: buildVktxProposal,
    VRDN: buildVrdnProposal
  };

  return TARGET_TICKERS.map((ticker) => {
    const position = positions.get(ticker) || {};
    const lifecycleRow = lifecycleRows.get(ticker) || null;
    const selectorRow = selectorRows.get(ticker) || null;
    const base = builders[ticker](position, lifecycleRow, selectorRow);

    return {
      ...base,
      missingLifecycleFields: lifecycleRow && lifecycleRow.missingLifecycleFields || [],
      sourcePositionExists: positions.has(ticker)
    };
  });
}

function proposedFieldsByTicker(planRows) {
  return Object.fromEntries(
    planRows.map((row) => [row.ticker, row.proposedLifecycleFields])
  );
}

function buildSummary(payload) {
  const lines = [];

  lines.push("# WALY Lifecycle Completion Plan v1");
  lines.push("");
  lines.push(`generatedAt: ${payload.generatedAt}`);
  lines.push(`mode: ${payload.mode}`);
  lines.push(`safeToOperate: ${payload.safeToOperate ? "true" : "false"}`);
  lines.push(`dataRealModified: ${payload.dataRealModified ? "true" : "false"}`);
  lines.push("");
  lines.push("## Propuestas por ticker");
  payload.plan.forEach((row) => {
    lines.push(`### ${row.ticker}`);
    lines.push(`- lifecycleStatus actual: ${row.currentState.lifecycleStatus || "n/d"}`);
    lines.push(`- classification actual: ${row.currentState.classification || "n/d"}`);
    lines.push(`- tradeType propuesto: ${row.proposedLifecycleFields.tradeType}`);
    lines.push(`- safeToOperate: ${row.safeToOperate ? "true" : "false"}`);
    lines.push(`- campos faltantes detectados: ${row.missingLifecycleFields.length ? row.missingLifecycleFields.join(", ") : "ninguno"}`);
    lines.push(`- confirmacion humana: ${row.humanConfirmationRequired.join(", ")}`);
    lines.push("");
  });
  lines.push("## Campos que requieren confirmacion humana");
  payload.humanConfirmationRequired.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Proposed lifecycle fields");
  payload.plan.forEach((row) => {
    lines.push(`### ${row.ticker}`);
    Object.entries(row.proposedLifecycleFields).forEach(([key, value]) => {
      lines.push(`- ${key}: ${Array.isArray(value) ? value.join("; ") : value}`);
    });
    lines.push("");
  });
  lines.push("## Confirmaciones");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function buildConsoleReport(payload, paths) {
  const tickerLines = payload.plan.map((row) => {
    const fields = row.proposedLifecycleFields;
    const action = fields.nextAction || (Array.isArray(fields.exitRule) ? fields.exitRule[0] : fields.exitRule);

    return `${row.ticker}: ${fields.tradeType} | lifecycle=${fields.lifecycleStatus || row.currentState.lifecycleStatus} | action=${action}`;
  });

  return [
    "WALY Lifecycle Completion Plan v1 generado.",
    `mode: ${payload.mode}`,
    `tickers: ${payload.plan.map((row) => row.ticker).join(", ")}`,
    `proposals: ${tickerLines.join(" || ")}`,
    `humanConfirmationRequired: ${payload.humanConfirmationRequired.length}`,
    `safeToOperate: ${payload.safeToOperate ? "true" : "false"}`,
    `dataRealModified: ${payload.dataRealModified ? "true" : "false"}`,
    `latest.json: ${formatRelative(paths.latestPath)}`,
    `summary.md: ${formatRelative(paths.summaryPath)}`,
    `proposed_lifecycle_fields.json: ${formatRelative(paths.proposedFieldsPath)}`,
    `safe-to-commit: ${payload.safeToCommit ? "yes" : "no"}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no ordenes, no data real modificada, no commit, no push."
  ].join("\n");
}

function buildPayload() {
  const inputs = buildInputs();
  const plan = buildPlanRows(inputs);
  const humanConfirmationRequired = [
    ...new Set(plan.flatMap((row) => row.humanConfirmationRequired))
  ].sort();

  return {
    confirmations: CONFIRMATIONS,
    dataRealModified: false,
    generatedAt: new Date().toISOString(),
    humanConfirmationRequired,
    inputStatus: Object.fromEntries(
      Object.entries(inputs).map(([key, input]) => [
        key,
        {
          exists: input.exists,
          path: input.path
        }
      ])
    ),
    mode: "dry-run-research-only",
    outputScope: "backtests/lifecycle-completion-plan/",
    plan,
    proposedLifecycleFields: proposedFieldsByTicker(plan),
    safeToApply: false,
    safeToCommit: true,
    safeToOperate: false,
    targetTickers: TARGET_TICKERS,
    touchedDataReal: false,
    touchedOutcomes: false,
    touchedSocialSignals: false
  };
}

function runLifecycleCompletionPlan() {
  const payload = buildPayload();
  const paths = {
    latestPath: writeJson(LATEST_PATH, payload),
    proposedFieldsPath: writeJson(PROPOSED_FIELDS_PATH, payload.proposedLifecycleFields),
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
  runLifecycleCompletionPlan
};
