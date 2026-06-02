"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "lifecycle-completion-apply");
const BACKUP_DIR = path.join(OUTPUT_DIR, "backups");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const PROPOSED_FILE_CHANGES_PATH = path.join(OUTPUT_DIR, "proposed_file_changes.json");
const PROPOSED_FIELDS_PATH = path.join(ROOT_DIR, "backtests", "lifecycle-completion-plan", "proposed_lifecycle_fields.json");
const PLAN_LATEST_PATH = path.join(ROOT_DIR, "backtests", "lifecycle-completion-plan", "latest.json");

const TARGET_FILE = "data/positions.json";
const READ_INPUTS = Object.freeze([
  TARGET_FILE,
  "data/watchlist.json"
]);

const CONFIRMATIONS = Object.freeze([
  "No opera.",
  "No usa IBKR.",
  "No usa Binance.",
  "No envia ordenes.",
  "No modifica outcomes.",
  "No modifica social_signals.",
  "No commit.",
  "No push.",
  "Dry-run por defecto."
]);

const CANONICAL_FIELDS = Object.freeze({
  OCS: {
    tradeType: "binary_runup",
    lifecycleStatus: "thesis_broken",
    entryThesis: "OCS-01 / DIAMOND DME topline catalyst.",
    actualFailure: "Phase 3 DIAMOND failed primary/key secondary; no FDA filing for DME currently planned.",
    expectedPath: "closed_original_thesis",
    invalidationRule: "already_invalidated",
    exitRule: "exit_or_reduce_after_news_confirmed",
    nextAction: "reduce_or_exit_position_after_manual_broker_check",
    noAdd: true,
    maxLossAccepted: "manual_review_required",
    keepPositionUntilHumanConfirmsSale: true
  },
  VRDN: {
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
    exitRule: "reduce/sell before PDUFA unless explicitHoldThroughBinary=true",
    maxLossAccepted: "manual_required",
    noAddUntilLifecycleComplete: true
  },
  VKTX: {
    tradeType: "valuation_repricing",
    binaryMode: "none",
    catalystStatus: "research",
    entryThesis: "tactical valuation/repricing/event-swing around obesity/metabolic optionality; no A+ until catalyst verified.",
    expectedPath: "repricing or strategic interest; not binary hold.",
    thesisReviewDate: "2026-06-09",
    timeStop: "weekly_review_until_catalyst_verified_or_reduce",
    invalidationRule: [
      "catalyst no verificable",
      "breakdown tecnico/material",
      "adverse clinical/regulatory update",
      "position too large relative to portfolio"
    ],
    exitRule: "reduce if position > target allocation; no add until catalyst verified and lifecycle complete",
    maxLossAccepted: "manual_required",
    noAddUntilLifecycleComplete: true
  }
});

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("lifecycle-completion-apply solo puede escribir dentro de backtests/lifecycle-completion-apply/.");
  }
}

function assertDataJsonPath(relativePath) {
  const normalized = relativePath.split("\\").join("/");
  const resolved = path.resolve(ROOT_DIR, normalized);
  const rootRelative = path.relative(ROOT_DIR, resolved).split(path.sep).join("/");

  if (
    rootRelative.startsWith("..") ||
    path.isAbsolute(rootRelative) ||
    !rootRelative.startsWith("data/") ||
    !rootRelative.endsWith(".json")
  ) {
    throw new Error(`Ruta mutable no permitida por lifecycle-completion-apply: ${relativePath}`);
  }

  return rootRelative;
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

function readJsonFile(relativePath) {
  const safePath = assertDataJsonPath(relativePath);
  const filePath = path.join(ROOT_DIR, safePath);

  try {
    return {
      filePath,
      relativePath: safePath,
      value: JSON.parse(fs.readFileSync(filePath, "utf8"))
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${safePath}: ${error.message}`);
    }

    throw error;
  }
}

function readRequiredJsonAbsolute(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Falta ${label}. Ejecuta primero lifecycle-completion-plan.`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${label}: ${error.message}`);
    }

    throw error;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findByTicker(rows, ticker) {
  const normalized = normalizeTicker(ticker);
  return asArray(rows).find((row) => normalizeTicker(row && row.ticker) === normalized) || null;
}

function recordFieldChange(changes, target, field, after, reason) {
  const before = target[field];

  if (valuesEqual(before, after)) {
    return;
  }

  target[field] = after;
  changes.push({
    after,
    before: before === undefined ? null : before,
    field,
    reason
  });
}

function validateProposedFields(proposedFields) {
  const missing = Object.keys(CANONICAL_FIELDS).filter((ticker) => !proposedFields || !proposedFields[ticker]);

  if (missing.length) {
    throw new Error(`proposed_lifecycle_fields.json incompleto. Faltan: ${missing.join(", ")}.`);
  }

  return true;
}

function buildFilePlan(positionsFile, proposedFields) {
  validateProposedFields(proposedFields);

  const nextValue = cloneJson(positionsFile.value);
  const positions = asArray(nextValue.positions);
  const operations = [];

  Object.entries(CANONICAL_FIELDS).forEach(([ticker, fields]) => {
    const position = findByTicker(positions, ticker);

    if (!position) {
      operations.push({
        changes: [],
        collection: "positions",
        missing: true,
        ticker
      });
      return;
    }

    const changes = [];
    Object.entries(fields).forEach(([field, value]) => {
      recordFieldChange(
        changes,
        position,
        field,
        value,
        `Complete lifecycle from ${formatRelative(PROPOSED_FIELDS_PATH)}.`
      );
    });

    operations.push({
      changes,
      collection: "positions",
      missing: false,
      ticker
    });
  });

  return {
    changed: !valuesEqual(positionsFile.value, nextValue),
    filePath: positionsFile.relativePath,
    nextValue,
    operations
  };
}

function flattenChanges(filePlans) {
  return filePlans.flatMap((filePlan) => (
    filePlan.operations.flatMap((operation) => (
      operation.changes.map((change) => ({
        after: change.after,
        before: change.before,
        collection: operation.collection,
        field: change.field,
        filePath: filePlan.filePath,
        reason: change.reason,
        ticker: operation.ticker
      }))
    ))
  ));
}

function createBackups(filePlans, generatedAt) {
  const changedPlans = filePlans.filter((filePlan) => filePlan.changed);
  const backupRunDir = path.join(BACKUP_DIR, generatedAt.replace(/[:.]/g, "-"));
  const backups = [];

  changedPlans.forEach((filePlan) => {
    const relativePath = assertDataJsonPath(filePlan.filePath);
    const sourcePath = path.join(ROOT_DIR, relativePath);
    const backupPath = path.join(backupRunDir, relativePath);
    const resolvedBackup = path.resolve(backupPath);
    const relativeBackup = path.relative(BACKUP_DIR, resolvedBackup);

    if (relativeBackup.startsWith("..") || path.isAbsolute(relativeBackup)) {
      throw new Error(`Backup fuera de backtests/lifecycle-completion-apply/backups/: ${filePlan.filePath}`);
    }

    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(sourcePath, backupPath);
    backups.push({
      backupPath: formatRelative(backupPath),
      filePath: filePlan.filePath
    });
  });

  if (changedPlans.length > 0 && backups.length !== changedPlans.length) {
    throw new Error("Apply abortado: no se genero backup para todos los archivos cambiados.");
  }

  return backups;
}

function writeMutableFiles(filePlans) {
  filePlans.filter((filePlan) => filePlan.changed).forEach((filePlan) => {
    const relativePath = assertDataJsonPath(filePlan.filePath);
    fs.writeFileSync(
      path.join(ROOT_DIR, relativePath),
      `${JSON.stringify(filePlan.nextValue, null, 2)}\n`,
      "utf8"
    );
  });
}

function renderChangeLine(change) {
  return `- ${change.filePath} ${change.ticker}.${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
}

function renderChangesForTicker(changes, ticker) {
  const rows = changes.filter((change) => change.ticker === ticker);

  return rows.length ? rows.map(renderChangeLine).join("\n") : "- Sin cambios.";
}

function manualRequiredFields(fileChanges) {
  return fileChanges
    .filter((change) => String(change.after).includes("manual_required") || String(change.after).includes("manual_review_required"))
    .map((change) => `${change.ticker}.${change.field}`);
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Lifecycle Completion Apply v1");
  lines.push("");
  lines.push(`generatedAt: ${payload.generatedAt}`);
  lines.push(`mode: ${payload.mode}`);
  lines.push(`dataRealModified: ${payload.dataRealModified ? "true" : "false"}`);
  lines.push("");
  lines.push("## Archivos que modificaria/cambio");
  lines.push(payload.changedFiles.length ? payload.changedFiles.map((filePath) => `- ${filePath}`).join("\n") : "- Ninguno.");
  lines.push("");
  lines.push("## OCS");
  lines.push(renderChangesForTicker(payload.fileChanges, "OCS"));
  lines.push("");
  lines.push("## VRDN");
  lines.push(renderChangesForTicker(payload.fileChanges, "VRDN"));
  lines.push("");
  lines.push("## VKTX");
  lines.push(renderChangesForTicker(payload.fileChanges, "VKTX"));
  lines.push("");
  lines.push("## Campos manual_required");
  lines.push(payload.manualRequiredFields.length ? payload.manualRequiredFields.map((field) => `- ${field}`).join("\n") : "- Ninguno.");
  lines.push("");
  lines.push("## Seguridad");
  lines.push(`- safeToApply: ${payload.safety.safeToApply ? "yes" : "no"}`);
  lines.push(`- proposed_lifecycle_fields.json presente: ${payload.safety.proposedFieldsPresent ? "yes" : "no"}`);
  lines.push(`- rutas permitidas: ${payload.safety.pathsAllowed ? "yes" : "no"}`);
  lines.push(`- dry-run no modifico data real: ${payload.safety.dryRunNoDataRealModified ? "yes" : "no"}`);
  lines.push(`- backups antes de apply real: ${payload.safety.backupsBeforeApply ? "yes" : "no"}`);
  lines.push(`- backup requerido antes de apply real: ${payload.mode === "apply" ? "generado" : "pendiente hasta --apply"}`);
  lines.push("");
  lines.push("## Backups");
  lines.push(payload.backups.length ? payload.backups.map((backup) => `- ${backup.filePath} -> ${backup.backupPath}`).join("\n") : "- Ninguno en dry-run.");
  lines.push("");
  lines.push("## Confirmaciones");
  payload.confirmations.forEach((confirmation) => lines.push(`- ${confirmation}`));
  if (payload.mode === "dry-run") {
    lines.push("- Dry-run: no modifico data real.");
  }

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(payload) {
  const files = payload.changedFiles.join(", ") || "ninguno";
  const fieldsFor = (ticker) => [...new Set(payload.fileChanges.filter((change) => change.ticker === ticker).map((change) => change.field))];

  return [
    "WALY Lifecycle Completion Apply v1 generado.",
    `mode: ${payload.mode}`,
    `dataRealModified: ${payload.dataRealModified ? "true" : "false"}`,
    `files ${payload.mode === "apply" ? "changed" : "would_change"}: ${files}`,
    `OCS changes: ${fieldsFor("OCS").join(", ") || "ninguno"}`,
    `VRDN changes: ${fieldsFor("VRDN").join(", ") || "ninguno"}`,
    `VKTX changes: ${fieldsFor("VKTX").join(", ") || "ninguno"}`,
    `manualRequiredFields: ${payload.manualRequiredFields.join(", ") || "ninguno"}`,
    `safeToApply: ${payload.safety.safeToApply ? "yes" : "no"}`,
    `latest.json: ${formatRelative(payload.paths.latestPath)}`,
    `summary.md: ${formatRelative(payload.paths.summaryPath)}`,
    `proposed_file_changes.json: ${formatRelative(payload.paths.proposedFileChangesPath)}`,
    `safe-to-commit: ${payload.safeToCommit ? "yes" : "no"}`,
    `Confirmacion: no operacion, no IBKR, no Binance, no ordenes, ${payload.mode === "dry-run" ? "no data real modificada, " : ""}no commit, no push.`
  ].join("\n");
}

function buildPayload(options = {}) {
  const generatedAt = new Date().toISOString();
  const mode = options.apply ? "apply" : "dry-run";
  const proposedFields = readRequiredJsonAbsolute(
    PROPOSED_FIELDS_PATH,
    "backtests/lifecycle-completion-plan/proposed_lifecycle_fields.json"
  );
  const planLatest = fs.existsSync(PLAN_LATEST_PATH)
    ? readRequiredJsonAbsolute(PLAN_LATEST_PATH, "backtests/lifecycle-completion-plan/latest.json")
    : null;
  const inputFiles = READ_INPUTS.map(readJsonFile);
  const positionsFile = inputFiles.find((file) => file.relativePath === TARGET_FILE);
  const filePlans = [buildFilePlan(positionsFile, proposedFields)];
  const fileChanges = flattenChanges(filePlans);
  const changedFiles = filePlans.filter((filePlan) => filePlan.changed).map((filePlan) => filePlan.filePath);
  const dryRunNoDataRealModified = mode === "dry-run";
  const safety = {
    backupsBeforeApply: true,
    dryRunNoDataRealModified,
    pathsAllowed: true,
    proposedFieldsPresent: true,
    safeToApply:
      changedFiles.length > 0 &&
      mode === "dry-run" &&
      dryRunNoDataRealModified,
    targetFileOnly: changedFiles.every((filePath) => filePath === TARGET_FILE)
  };

  return {
    backups: [],
    changedFiles,
    confirmations: CONFIRMATIONS,
    dataRealModified: false,
    fileChanges,
    filePlans,
    generatedAt,
    inputStatus: {
      planLatest: {
        exists: Boolean(planLatest),
        path: formatRelative(PLAN_LATEST_PATH)
      },
      proposedLifecycleFields: {
        exists: true,
        path: formatRelative(PROPOSED_FIELDS_PATH)
      },
      readInputs: inputFiles.map((file) => file.relativePath)
    },
    manualRequiredFields: manualRequiredFields(fileChanges),
    mode,
    proposedChangesApplied: false,
    safeToCommit: true,
    safety,
    sourceProposedFieldsPath: formatRelative(PROPOSED_FIELDS_PATH),
    touchedOutcomes: false,
    touchedSocialSignals: false
  };
}

function stripRuntimeOnly(payload) {
  const { filePlans, ...safePayload } = payload;
  return safePayload;
}

function writeApplyOutputs(payload) {
  const publicPayload = stripRuntimeOnly(payload);

  return {
    latestPath: writeJson(LATEST_PATH, publicPayload),
    outputDir: OUTPUT_DIR,
    proposedFileChangesPath: writeJson(PROPOSED_FILE_CHANGES_PATH, {
      changedFiles: publicPayload.changedFiles,
      fileChanges: publicPayload.fileChanges,
      manualRequiredFields: publicPayload.manualRequiredFields,
      mode: publicPayload.mode,
      safeToApply: publicPayload.safety.safeToApply,
      sourceProposedFieldsPath: publicPayload.sourceProposedFieldsPath
    }),
    summaryPath: writeText(SUMMARY_PATH, renderSummary(publicPayload))
  };
}

function runLifecycleCompletionApply(options = {}) {
  const payload = buildPayload(options);

  if (payload.mode === "apply") {
    payload.backups = createBackups(payload.filePlans, payload.generatedAt);

    if (payload.changedFiles.length > 0 && payload.backups.length === 0) {
      throw new Error("Apply abortado: no hay backup generado.");
    }

    writeMutableFiles(payload.filePlans);
    payload.dataRealModified = payload.changedFiles.length > 0;
    payload.proposedChangesApplied = true;
    payload.safety.safeToApply = false;
  }

  const paths = writeApplyOutputs(payload);
  const publicPayload = {
    ...stripRuntimeOnly(payload),
    paths
  };

  writeJson(LATEST_PATH, publicPayload);

  return {
    ...publicPayload,
    consoleReport: renderConsoleReport(publicPayload),
    summaryMarkdown: renderSummary(publicPayload)
  };
}

module.exports = {
  runLifecycleCompletionApply
};
