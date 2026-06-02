"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { VALID_CATALYST_TYPES, VALID_STATUSES } = require("./constants");
const { normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "data-hygiene-apply");
const BACKUP_DIR = path.join(OUTPUT_DIR, "backups");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const PROPOSED_FILE_CHANGES_PATH = path.join(OUTPUT_DIR, "proposed_file_changes.json");
const AUDIT_PROPOSED_CHANGES_PATH = path.join(ROOT_DIR, "backtests", "data-hygiene-audit", "proposed_changes.json");

const TARGET_FILES = Object.freeze([
  "data/positions.json",
  "data/watchlist.json",
  "data/fda.json",
  "examples/biotech-binary-events-expanded.example.json"
]);

const REASON_OCS_BROKEN = "Phase 3 DIAMOND failed primary/key secondary; no FDA filing for DME currently planned.";

const CONFIRMATIONS = [
  "No opera.",
  "No usa IBKR.",
  "No usa Binance.",
  "No envia ordenes.",
  "No commit.",
  "No push."
];

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function assertApplyOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("data-hygiene-apply solo puede escribir dentro de backtests/data-hygiene-apply/.");
  }
}

function assertMutableInputPath(relativePath) {
  const normalized = relativePath.split("\\").join("/");
  const resolved = path.resolve(ROOT_DIR, normalized);
  const rootRelative = path.relative(ROOT_DIR, resolved).split(path.sep).join("/");
  const allowedRoot = rootRelative.startsWith("data/") || rootRelative.startsWith("examples/");

  if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative) || !allowedRoot || !rootRelative.endsWith(".json")) {
    throw new Error(`Ruta mutable no permitida por data-hygiene-apply: ${relativePath}`);
  }

  return rootRelative;
}

function writeJson(filePath, value) {
  assertApplyOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writeText(filePath, value) {
  assertApplyOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
  return filePath;
}

function readJsonFile(relativePath) {
  const safePath = assertMutableInputPath(relativePath);
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

function readAuditProposedChanges() {
  if (!fs.existsSync(AUDIT_PROPOSED_CHANGES_PATH)) {
    throw new Error("Falta backtests/data-hygiene-audit/proposed_changes.json. Ejecuta primero data-hygiene-audit.");
  }

  try {
    const proposedChanges = JSON.parse(fs.readFileSync(AUDIT_PROPOSED_CHANGES_PATH, "utf8"));
    const byFile = proposedChanges && proposedChanges.byFile ? proposedChanges.byFile : {};

    Object.keys(byFile).forEach((relativePath) => {
      assertMutableInputPath(relativePath);
    });

    return proposedChanges;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en backtests/data-hygiene-audit/proposed_changes.json: ${error.message}`);
    }

    throw error;
  }
}

function getCurrentDateInTimezone(timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric"
    });
    const parts = formatter.formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch (error) {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDays(dateOnly, days) {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function findByTicker(rows, ticker) {
  const normalized = normalizeTicker(ticker);
  return asArray(rows).find((row) => normalizeTicker(row && row.ticker) === normalized) || null;
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordFieldChange(changes, target, field, before, after, reason) {
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

function setField(changes, target, field, value, reason) {
  recordFieldChange(changes, target, field, target[field], value, reason);
}

function setFieldIfExists(changes, target, field, value, reason) {
  if (!Object.prototype.hasOwnProperty.call(target, field)) {
    return;
  }

  setField(changes, target, field, value, reason);
}

function pushOperation(operations, filePath, collection, ticker, changes, skipped = []) {
  operations.push({
    changed: changes.length > 0,
    changes,
    collection,
    skipped,
    ticker
  });
}

function nextReviewPlan(currentDate) {
  return {
    MNKD: currentDate,
    OCS: currentDate,
    VERA: addDays(currentDate, 7),
    VKTX: addDays(currentDate, 7),
    VRDN: "2026-06-23"
  };
}

function applyOcsRiskFields(item, changes) {
  const reason = REASON_OCS_BROKEN;

  setField(changes, item, "thesisStatus", "thesis_broken", reason);
  setField(changes, item, "riskStatus", "freeze", reason);
  setField(changes, item, "reviewStatus", "revisar_manual", reason);
  setField(changes, item, "noAdd", true, reason);
  setField(changes, item, "requireManualReview", true, reason);
  setField(changes, item, "requireNewsCheck", true, reason);
  setField(changes, item, "suggestedAction", "exit_or_reduce_after_news_confirmed", reason);
  setField(changes, item, "catalystStatus", "occurred_failed", reason);
  setField(changes, item, "reason", reason, reason);
  setField(changes, item, "oldFutureCatalystStatus", "stale", "Old future catalyst is stale after DIAMOND result.");
  setField(changes, item, "eventDate", "2026-05-29", "DIAMOND result date used by audit dataset.");
  setField(changes, item, "newsDate", "2026-05-29", "DIAMOND result news date used by audit dataset.");
}

function applyOcsPositionUpdates(item, changes, context) {
  applyOcsRiskFields(item, changes);

  if (item.setupRank === "A" || item.setupRank === "A+") {
    setField(changes, item, "setupRank", "descartar", "OCS no debe quedar como A/A+ tras thesis_broken.");
  }

  setFieldIfExists(changes, item, "nextReviewAt", context.reviewDates.OCS, "Revision inmediata por thesis_broken.");
}

function applyOcsWatchlistUpdates(item, changes, context) {
  applyOcsRiskFields(item, changes);
  setField(changes, item, "status", "descartar", REASON_OCS_BROKEN);

  if (item.setupRank === "A" || item.setupRank === "A+") {
    setField(changes, item, "setupRank", "descartar", "OCS no debe quedar como A/A+ tras thesis_broken.");
  }

  setFieldIfExists(changes, item, "nextReviewAt", context.reviewDates.OCS, "Revision inmediata por thesis_broken.");
}

function applyVktxUpdates(item, changes, context) {
  setField(changes, item, "catalystStatus", "research", "VKTX queda en research hasta catalyst verificable.");
  setField(changes, item, "noAPlusUntilCatalystVerified", true, "No A+ hasta catalyst verificable.");
  setField(changes, item, "catalystTypeNote", "unknown_or_event_swing", "No inventar catalyst duro para VKTX.");
  setFieldIfExists(changes, item, "nextReviewAt", context.reviewDates.VKTX, "Revision semanal o hasta catalyst verificable.");
}

function applyPlrxUpdates(item, changes) {
  setField(changes, item, "classification", "needs_data", "PLRX score 0/post_failure_candidate requiere datos.");
  setField(changes, item, "scoreStatus", "incomplete", "PLRX tiene campos criticos faltantes.");
  setField(changes, item, "useForShortEdge", false, "No usar PLRX para edge hasta corregir datos.");
}

function applyDuplicateWatchlistUpdates(item, changes) {
  setField(changes, item, "inPortfolio", true, "Ticker tambien existe en positions; positions es source of truth.");
  setField(changes, item, "sourceOfTruth", "positions", "Ticker tambien existe en positions; positions es source of truth.");
  setField(changes, item, "noNewEntryFromWatchlist", true, "Watchlist no debe generar una nueva entrada para posicion abierta.");
}

function applyReviewDate(item, changes, ticker, context, reason) {
  const nextDate = context.reviewDates[ticker];

  if (nextDate) {
    setFieldIfExists(changes, item, "nextReviewAt", nextDate, reason);
  }
}

function buildFilePlan(file, context) {
  const nextValue = cloneJson(file.value);
  const operations = [];

  if (file.relativePath === "data/positions.json") {
    const positions = asArray(nextValue.positions);
    const ocs = findByTicker(positions, "OCS");
    const vktx = findByTicker(positions, "VKTX");
    const vrdn = findByTicker(positions, "VRDN");

    if (ocs) {
      const changes = [];
      applyOcsPositionUpdates(ocs, changes, context);
      pushOperation(operations, file.relativePath, "positions", "OCS", changes);
    }

    if (vktx) {
      const changes = [];
      applyVktxUpdates(vktx, changes, context);
      pushOperation(operations, file.relativePath, "positions", "VKTX", changes);
    }

    if (vrdn) {
      const changes = [];
      applyReviewDate(vrdn, changes, "VRDN", context, "Revision antes de PDUFA 2026-06-30.");
      pushOperation(operations, file.relativePath, "positions", "VRDN", changes);
    }
  }

  if (file.relativePath === "data/watchlist.json") {
    const watchlist = asArray(nextValue.watchlist);
    const ocs = findByTicker(watchlist, "OCS");
    const vrdn = findByTicker(watchlist, "VRDN");
    const vktx = findByTicker(watchlist, "VKTX");
    const vera = findByTicker(watchlist, "VERA");
    const mnkd = findByTicker(watchlist, "MNKD");

    if (ocs) {
      const changes = [];
      applyOcsWatchlistUpdates(ocs, changes, context);
      applyDuplicateWatchlistUpdates(ocs, changes);
      pushOperation(operations, file.relativePath, "watchlist", "OCS", changes);
    }

    if (vrdn) {
      const changes = [];
      applyDuplicateWatchlistUpdates(vrdn, changes);
      applyReviewDate(vrdn, changes, "VRDN", context, "Revision antes de PDUFA 2026-06-30.");
      pushOperation(operations, file.relativePath, "watchlist", "VRDN", changes);
    }

    if (vktx) {
      const changes = [];
      applyReviewDate(vktx, changes, "VKTX", context, "Revision semanal o hasta catalyst verificable.");
      pushOperation(operations, file.relativePath, "watchlist", "VKTX", changes);
    }

    if (vera) {
      const changes = [];
      applyReviewDate(vera, changes, "VERA", context, "Revision semanal si sigue en watchlist.");
      pushOperation(operations, file.relativePath, "watchlist", "VERA", changes);
    }

    if (mnkd) {
      const changes = [];
      applyReviewDate(mnkd, changes, "MNKD", context, "Revision inmediata por catalyst vencido 2026-05-29.");
      pushOperation(operations, file.relativePath, "watchlist", "MNKD", changes);
    }
  }

  if (file.relativePath === "data/fda.json") {
    const catalysts = asArray(nextValue.catalysts);
    const ocs = findByTicker(catalysts, "OCS");

    if (ocs) {
      const changes = [];
      setField(changes, ocs, "catalystStatus", "occurred_failed", REASON_OCS_BROKEN);
      setField(changes, ocs, "reason", REASON_OCS_BROKEN, REASON_OCS_BROKEN);
      setField(changes, ocs, "oldFutureCatalystStatus", "stale", "Old future catalyst is stale after DIAMOND result.");
      setField(changes, ocs, "eventDate", "2026-05-29", "DIAMOND result date used by audit dataset.");
      setField(changes, ocs, "newsDate", "2026-05-29", "DIAMOND result news date used by audit dataset.");
      pushOperation(operations, file.relativePath, "catalysts", "OCS", changes);
    }
  }

  if (file.relativePath === "examples/biotech-binary-events-expanded.example.json") {
    const events = asArray(nextValue.events);
    const plrx = findByTicker(events, "PLRX");

    if (plrx) {
      const changes = [];
      applyPlrxUpdates(plrx, changes);
      pushOperation(operations, file.relativePath, "events", "PLRX", changes);
    }
  }

  return {
    changed: !valuesEqual(file.value, nextValue),
    filePath: file.relativePath,
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

function buildSchemaWarnings(changes) {
  const warnings = [];

  changes.forEach((change) => {
    if (change.field === "status" && !VALID_STATUSES.includes(change.after)) {
      warnings.push({
        code: "STATUS_OUTSIDE_CURRENT_VALIDATORS",
        field: change.field,
        filePath: change.filePath,
        message: `status "${change.after}" no esta en VALID_STATUSES.`,
        ticker: change.ticker
      });
    }

    if (change.field === "catalystType" && !VALID_CATALYST_TYPES.includes(change.after)) {
      warnings.push({
        code: "CATALYST_TYPE_OUTSIDE_CURRENT_VALIDATORS",
        field: change.field,
        filePath: change.filePath,
        message: `catalystType "${change.after}" no esta en VALID_CATALYST_TYPES.`,
        ticker: change.ticker
      });
    }
  });

  return warnings;
}

function createBackups(filePlans, generatedAt) {
  const backupRunDir = path.join(BACKUP_DIR, generatedAt.replace(/[:.]/g, "-"));
  const changedPlans = filePlans.filter((filePlan) => filePlan.changed);
  const backups = [];

  changedPlans.forEach((filePlan) => {
    const sourcePath = path.join(ROOT_DIR, filePlan.filePath);
    const backupPath = path.join(backupRunDir, filePlan.filePath);
    const resolvedBackup = path.resolve(backupPath);
    const relativeBackup = path.relative(BACKUP_DIR, resolvedBackup);

    if (relativeBackup.startsWith("..") || path.isAbsolute(relativeBackup)) {
      throw new Error(`Backup fuera de backtests/data-hygiene-apply/backups/: ${filePlan.filePath}`);
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
    const relativePath = assertMutableInputPath(filePlan.filePath);
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

  if (!rows.length) {
    return "- Sin cambios.";
  }

  return rows.map(renderChangeLine).join("\n");
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Data Hygiene Apply v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push(`Fecha local: ${payload.currentDate}`);
  lines.push(`Modo: ${payload.mode}`);
  lines.push(`Data real modificada: ${payload.dataRealModified ? "true" : "false"}`);
  lines.push("");
  lines.push("## Archivos que modificaria/cambio");
  if (!payload.changedFiles.length) {
    lines.push("- Ninguno.");
  } else {
    payload.changedFiles.forEach((filePath) => lines.push(`- ${filePath}`));
  }
  lines.push("");
  lines.push("## Diff/propuesta");
  if (!payload.fileChanges.length) {
    lines.push("- Sin cambios pendientes.");
  } else {
    payload.fileChanges.forEach((change) => lines.push(renderChangeLine(change)));
  }
  lines.push("");
  lines.push("## OCS");
  lines.push(renderChangesForTicker(payload.fileChanges, "OCS"));
  lines.push("");
  lines.push("## VKTX");
  lines.push(renderChangesForTicker(payload.fileChanges, "VKTX"));
  lines.push("");
  lines.push("## PLRX");
  lines.push(renderChangesForTicker(payload.fileChanges, "PLRX"));
  lines.push("");
  lines.push("## Seguridad");
  lines.push(`- safeToApply: ${payload.safety.safeToApply ? "yes" : "no"}`);
  lines.push(`- proposed_changes.json presente: ${payload.safety.proposedChangesPresent ? "yes" : "no"}`);
  lines.push(`- rutas permitidas: ${payload.safety.pathsAllowed ? "yes" : "no"}`);
  lines.push(`- dry-run no modifico data real: ${payload.safety.dryRunNoDataRealModified ? "yes" : "no"}`);
  lines.push(`- backups antes de apply real: ${payload.safety.backupsBeforeApply ? "yes" : "no"}`);
  lines.push(`- backup requerido antes de apply real: ${payload.mode === "apply" ? "generado" : "pendiente hasta --apply"}`);
  if (payload.safety.schemaWarnings.length) {
    payload.safety.schemaWarnings.forEach((warning) => lines.push(`- schema warning: ${warning.ticker} ${warning.message}`));
  }
  lines.push("");
  lines.push("## Backups");
  if (!payload.backups.length) {
    lines.push("- Ninguno en dry-run.");
  } else {
    payload.backups.forEach((backup) => lines.push(`- ${backup.filePath} -> ${backup.backupPath}`));
  }
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
  const ocsFields = payload.fileChanges.filter((change) => change.ticker === "OCS").map((change) => change.field);
  const vktxFields = payload.fileChanges.filter((change) => change.ticker === "VKTX").map((change) => change.field);
  const plrxFields = payload.fileChanges.filter((change) => change.ticker === "PLRX").map((change) => change.field);

  return [
    "WALY Data Hygiene Apply v1 generado.",
    `mode: ${payload.mode}`,
    `dataRealModified: ${payload.dataRealModified ? "true" : "false"}`,
    `files ${payload.mode === "apply" ? "changed" : "would_change"}: ${files}`,
    `OCS changes: ${[...new Set(ocsFields)].join(", ") || "ninguno"}`,
    `VKTX changes: ${[...new Set(vktxFields)].join(", ") || "ninguno"}`,
    `PLRX changes: ${[...new Set(plrxFields)].join(", ") || "ninguno"}`,
    `safeToApply: ${payload.safety.safeToApply ? "yes" : "no"}`,
    payload.safety.schemaWarnings.length
      ? `schemaWarnings: ${payload.safety.schemaWarnings.map((warning) => `${warning.ticker}:${warning.code}`).join(" | ")}`
      : "schemaWarnings: ninguno",
    `latest.json: ${formatRelative(payload.paths.latestPath)}`,
    `summary.md: ${formatRelative(payload.paths.summaryPath)}`,
    `proposed_file_changes.json: ${formatRelative(payload.paths.proposedFileChangesPath)}`,
    "safe-to-commit: no",
    `Confirmacion: no operacion, no IBKR, no Binance, no ordenes, ${payload.mode === "dry-run" ? "no data real modificada, " : ""}no commit, no push.`
  ].join("\n");
}

function buildPayload(options = {}) {
  const generatedAt = new Date().toISOString();
  const proposedChanges = readAuditProposedChanges();
  const settings = readJsonFile("data/settings.json");
  const currentDate = getCurrentDateInTimezone(settings.value.timezone);
  const context = {
    proposedChanges,
    reviewDates: nextReviewPlan(currentDate)
  };
  const files = TARGET_FILES.map(readJsonFile);
  const filePlans = files.map((file) => buildFilePlan(file, context));
  const fileChanges = flattenChanges(filePlans);
  const schemaWarnings = buildSchemaWarnings(fileChanges);
  const changedFiles = filePlans.filter((filePlan) => filePlan.changed).map((filePlan) => filePlan.filePath);
  const mode = options.apply ? "apply" : "dry-run";
  const backupsBeforeApply = true;
  const dryRunNoDataRealModified = mode === "dry-run";
  const safety = {
    backupsBeforeApply,
    dryRunNoDataRealModified,
    pathsAllowed: true,
    proposedChangesPresent: true,
    safeToApply:
      schemaWarnings.length === 0 &&
      changedFiles.length > 0 &&
      mode === "dry-run" &&
      dryRunNoDataRealModified &&
      backupsBeforeApply,
    schemaWarnings
  };

  return {
    backups: [],
    changedFiles,
    confirmations: CONFIRMATIONS,
    currentDate,
    dataRealModified: false,
    fileChanges,
    filePlans,
    generatedAt,
    mode,
    proposedChangesApplied: false,
    safety,
    sourceProposedChangesPath: formatRelative(AUDIT_PROPOSED_CHANGES_PATH)
  };
}

function stripRuntimeOnly(payload) {
  const { filePlans, ...safePayload } = payload;
  return safePayload;
}

function writeApplyOutputs(payload) {
  const publicPayload = stripRuntimeOnly(payload);
  const summaryMarkdown = renderSummary(publicPayload);

  return {
    latestPath: writeJson(LATEST_PATH, publicPayload),
    outputDir: OUTPUT_DIR,
    proposedFileChangesPath: writeJson(PROPOSED_FILE_CHANGES_PATH, {
      changedFiles: publicPayload.changedFiles,
      fileChanges: publicPayload.fileChanges,
      mode: publicPayload.mode,
      sourceProposedChangesPath: publicPayload.sourceProposedChangesPath
    }),
    summaryPath: writeText(SUMMARY_PATH, summaryMarkdown)
  };
}

function runDataHygieneApply(options = {}) {
  const payload = buildPayload(options);

  if (payload.mode === "apply") {
    payload.backups = createBackups(payload.filePlans, payload.generatedAt);

    if (payload.changedFiles.length > 0 && payload.backups.length === 0) {
      throw new Error("Apply abortado: no hay backup generado.");
    }

    writeMutableFiles(payload.filePlans);
    payload.dataRealModified = payload.changedFiles.length > 0;
    payload.proposedChangesApplied = true;
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
  runDataHygieneApply
};
