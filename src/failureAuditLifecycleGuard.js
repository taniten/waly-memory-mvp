"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "failure-audit-lifecycle-guard");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const REQUIRED_RULES_PATH = path.join(OUTPUT_DIR, "required_system_rules.json");

const INPUT_PATHS = Object.freeze({
  dailyLog: "data/daily_log.json",
  dailyRunLatest: "backtests/daily-run/latest.json",
  dataHygieneAuditLatest: "backtests/data-hygiene-audit/latest.json",
  outcomes: "data/outcomes.json",
  positions: "data/positions.json",
  positionShockLatest: "backtests/position-shock-monitor/latest.json",
  preCatalystExitGuardLatest: "backtests/pre-catalyst-exit-guard/latest.json",
  settings: "data/settings.json",
  biotechExpandedExample: "examples/biotech-binary-events-expanded.example.json",
  watchlist: "data/watchlist.json"
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
  "Research-only.",
  "Output solo en backtests/failure-audit-lifecycle-guard/."
]);

const REQUIRED_SYSTEM_RULES = Object.freeze([
  {
    id: "active_position_lifecycle_required",
    severity: "blocker",
    rule: "Toda posicion activa debe tener tradeType, entryThesis, expectedPath, invalidationRule, exitRule, nextReviewAt y maxLossAccepted.",
    coveredBy: ["lifecycleGuard"],
    gapClosed: "Evita posiciones vivas con tesis verbal pero sin salida, perdida maxima o camino esperado."
  },
  {
    id: "options_trade_lifecycle_required",
    severity: "blocker",
    rule: "Todo trade de opciones o spread debe tener expiryDate, timeStop, maxPremiumLoss y reviewBeforeThetaDate.",
    coveredBy: ["lifecycleGuard", "sizingGuard"],
    gapClosed: "Evita trades con theta/decay sin reloj operativo."
  },
  {
    id: "binary_mode_classification_before_entry",
    severity: "blocker",
    rule: "Todo catalyst binario debe clasificarse antes de entrar como binary_runup o binary_lotto.",
    coveredBy: ["preCatalystExitGuard", "lifecycleGuard"],
    gapClosed: "Separa runup que debe salir antes del evento de lotto que acepta perdida total."
  },
  {
    id: "no_hold_through_binary_without_explicit_hold",
    severity: "blocker",
    rule: "No mantener a traves de evento binario sin explicitHoldThroughBinary=true y sizing lotto.",
    coveredBy: ["preCatalystExitGuard", "lifecycleGuard"],
    gapClosed: "Bloquea hold-through-event accidental."
  },
  {
    id: "binary_runup_exit_before_event_required",
    severity: "blocker",
    rule: "Todo binary_runup debe tener catalystDate y exitBeforeEventDate; si hoy >= exitBeforeEventDate, sugerir reduce_or_exit_suggested.",
    coveredBy: ["preCatalystExitGuard", "lifecycleGuard"],
    gapClosed: "Fuerza salida o reduccion antes del catalyst."
  },
  {
    id: "thesis_broken_lockdown",
    severity: "blocker",
    rule: "Si thesis_broken, entonces noAdd=true, requireManualReview=true y suggestedAction=exit_or_reduce_after_news_confirmed.",
    coveredBy: ["positionShockMonitor", "thesisIntegrityEngine", "lifecycleGuard"],
    gapClosed: "Impide que una tesis rota siga apareciendo como idea viva normal."
  },
  {
    id: "valuation_repricing_time_stop_required",
    severity: "blocker",
    rule: "Todo valuation_repricing debe tener thesisReviewDate, valuationTrigger y timeStop; no usar opciones sin timeStop.",
    coveredBy: ["lifecycleGuard", "thesisIntegrityEngine"],
    gapClosed: "Evita convertir repricing narrativo en trade sin reloj."
  },
  {
    id: "shock_detection_post_event_review",
    severity: "high",
    rule: "Todo shock freeze_position debe abrir review manual y bloquear add hasta noticia primaria revisada.",
    coveredBy: ["positionShockMonitor", "lifecycleGuard"],
    gapClosed: "Reduce retraso entre shock de precio y revision de tesis."
  }
]);

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("failure-audit-lifecycle-guard solo puede escribir dentro de backtests/failure-audit-lifecycle-guard/.");
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function findByTicker(rows, ticker) {
  const normalized = normalizeTicker(ticker);
  return asArray(rows).find((row) => normalizeTicker(row && row.ticker) === normalized) || null;
}

function textFor(row) {
  if (!row || typeof row !== "object") {
    return "";
  }

  return [
    row.ticker,
    row.thesis,
    row.rationale,
    row.catalyst,
    row.notes,
    row.setupType,
    row.playbookType,
    row.why,
    row.lessons,
    row.expectedMove,
    row.source,
    row.reason
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function isActivePosition(position) {
  return Boolean(position && Number(position.quantity || 0) > 0 && position.status !== "descartar");
}

function inferInstrumentType(row, ticker) {
  const text = textFor(row);
  const explicit = row && (row.instrumentType || row.assetType || row.allowedVehicle);

  if (explicit && /option/i.test(String(explicit))) {
    return "option";
  }

  if (explicit && /spread/i.test(String(explicit))) {
    return "spread";
  }

  if (ticker === "KVYO" || /option|spread|premium|expiry|theta/.test(text)) {
    return "spread";
  }

  return "stock";
}

function inferTradeTypes(row, ticker) {
  const text = textFor(row);
  const types = [];

  if (ticker === "KVYO") {
    types.push("valuation_repricing", "options_timebound");
  }

  if (/binary|phase\s*3|pdufa|fda|topline|readout|clinical|diamond/.test(text)) {
    types.push("binary_runup");
  }

  if (/lotto/.test(text)) {
    types.push("binary_lotto");
  }

  if (/valuation|repricing|rerating/.test(text)) {
    types.push("valuation_repricing");
  }

  if (/option|spread|expiry|theta|premium/.test(text)) {
    types.push("options_timebound");
  }

  if (/momentum|outlier|gap|follow-through/.test(text)) {
    types.push("momentum_outlier");
  }

  if (row && (row.classification === "post_failure_candidate" || row.thesisAfterEvent === "broken")) {
    types.push("post_failure_short_candidate");
  }

  return [...new Set(types)].length ? [...new Set(types)] : ["unknown"];
}

function primaryTradeType(tradeTypes) {
  if (tradeTypes.includes("options_timebound")) {
    return "options_timebound";
  }

  return tradeTypes[0] || "unknown";
}

function buildFailureCase({
  actualFailure,
  catalystDate,
  dataPresence = "present",
  entryThesis,
  expectedPath,
  exitRule,
  expiryDate = null,
  failureType,
  instrumentType,
  invalidationRule,
  lesson,
  maxLossAccepted,
  preventableBy,
  requiredSystemRule,
  reviewDate,
  ticker,
  timeStop,
  tradeTypes
}) {
  return {
    ticker,
    instrumentType,
    tradeType: primaryTradeType(tradeTypes),
    tradeTypes,
    entryThesis: entryThesis || null,
    expectedPath: expectedPath || null,
    catalystDate: catalystDate || null,
    reviewDate: reviewDate || null,
    expiryDate,
    invalidationRule: invalidationRule || null,
    exitRule: exitRule || null,
    timeStop: timeStop || null,
    maxLossAccepted: maxLossAccepted || null,
    actualFailure,
    dataPresence,
    failureType,
    preventableBy,
    lesson,
    requiredSystemRule
  };
}

function buildOcsFailure(inputs) {
  const positions = asArray(inputs.positions.value && inputs.positions.value.positions);
  const watchlist = asArray(inputs.watchlist.value && inputs.watchlist.value.watchlist);
  const events = asArray(inputs.biotechExpandedExample.value && inputs.biotechExpandedExample.value.events);
  const shocks = asArray(inputs.positionShockLatest.value && inputs.positionShockLatest.value.rows);
  const hygiene = inputs.dataHygieneAuditLatest.value && inputs.dataHygieneAuditLatest.value.audit;
  const position = findByTicker(positions, "OCS");
  const watch = findByTicker(watchlist, "OCS");
  const event = findByTicker(events, "OCS");
  const shock = findByTicker(shocks, "OCS");
  const source = position || watch || event || {};

  return buildFailureCase({
    actualFailure: "Phase 3 DIAMOND fallo primary/key secondary; WALY mantuvo una posicion real con shock tardio y tesis rota reconocida post-apply.",
    catalystDate: (event && event.eventDate) || source.eventDate || source.catalystDate,
    entryThesis: source.thesis || source.notes,
    expectedPath: "Capturar runup hacia DIAMOND sin sostener riesgo binario no explicitado.",
    exitRule: source.suggestedAction || "exit_or_reduce_after_news_confirmed",
    failureType: ["no_exit_before_event", "thesis_broken", "shock_not_detected"],
    instrumentType: "stock",
    invalidationRule: source.invalidation,
    lesson: "OCS demuestra que un catalyst binario no puede vivir solo con narrativa; debe existir salida pre-evento o explicitHoldThroughBinary con sizing de perdida aceptada.",
    maxLossAccepted: null,
    preventableBy: ["preCatalystExitGuard", "positionShockMonitor", "lifecycleGuard", "thesisIntegrityEngine"],
    requiredSystemRule: [
      "no hold through binary without explicitHoldThroughBinary=true",
      "if thesis_broken then noAdd and exit_or_reduce_after_news_confirmed"
    ],
    reviewDate: source.nextReviewAt || source.lastReviewedAt,
    ticker: "OCS",
    timeStop: null,
    tradeTypes: ["binary_runup"],
    dataPresence: hygiene && hygiene.ocs && hygiene.ocs.positionAcknowledged ? "present_post_apply_acknowledged" : "present"
  });
}

function buildAtyrFailure(inputs) {
  const events = asArray(inputs.biotechExpandedExample.value && inputs.biotechExpandedExample.value.events);
  const event = findByTicker(events, "ATYR") || {};

  return buildFailureCase({
    actualFailure: "Endpoint failure tras evento clinico; caso metodologico de hold-through binary sin salida disciplinada.",
    catalystDate: event.eventDate,
    entryThesis: event.notes || "Biotech binaria con Phase 3 topline.",
    expectedPath: "Runup hacia Phase 3 y salida antes del dato salvo modo lotto explicitado.",
    exitRule: "Salir antes del evento si no existe explicitHoldThroughBinary=true.",
    failureType: ["held_through_binary_event", "no_exit_before_event", "thesis_broken"],
    instrumentType: "stock",
    invalidationRule: event.thesisAfterEvent === "broken" ? "Endpoint failure rompe tesis." : null,
    lesson: "ATYR debe quedar como fixture: clasificar binary_runup vs binary_lotto antes de entrada y no improvisar despues del dato.",
    maxLossAccepted: null,
    preventableBy: ["preCatalystExitGuard", "lifecycleGuard", "thesisIntegrityEngine"],
    requiredSystemRule: ["classify binary mode before entry"],
    reviewDate: event.signalDate || event.knownFromDate,
    ticker: "ATYR",
    timeStop: null,
    tradeTypes: ["binary_runup"],
    dataPresence: event.ticker ? "present_example_dataset" : "missing_from_local_data"
  });
}

function buildKvyoFailure(inputs) {
  const dailyText = JSON.stringify(inputs.dailyLog.value || {}).toLowerCase();
  const outcomesText = JSON.stringify(inputs.outcomes.value || {}).toLowerCase();
  const exists = dailyText.includes("kvyo") || outcomesText.includes("kvyo");

  return buildFailureCase({
    actualFailure: exists
      ? "KVYO aparece en memoria local como trade problemático de options spread / valuation repricing."
      : "KVYO no aparece en data/outcomes ni daily_log; se registra como caso research minimo requerido por el usuario para cerrar el guardrail.",
    catalystDate: null,
    entryThesis: "Valuation repricing mediante options spread sin catalyst duro localmente verificable.",
    expectedPath: "Repricing dentro de ventana temporal limitada antes de theta/decay.",
    exitRule: null,
    expiryDate: null,
    failureType: ["missing_hard_catalyst", "missing_catalyst", "no_time_stop", "options_decay", "no_invalidation_rule"],
    instrumentType: "spread",
    invalidationRule: null,
    lesson: "KVYO obliga a tratar opciones como trades con reloj: catalyst/trigger duro, expiry, timeStop, invalidation, exitRule y perdida maxima antes de abrir.",
    maxLossAccepted: null,
    preventableBy: ["lifecycleGuard", "sizingGuard", "thesisIntegrityEngine"],
    requiredSystemRule: [
      "any options trade must have expiryDate, timeStop, invalidationRule, exitRule, maxLossAccepted"
    ],
    reviewDate: null,
    ticker: "KVYO",
    timeStop: null,
    tradeTypes: ["valuation_repricing", "options_timebound"],
    dataPresence: exists ? "present_local_text" : "missing_from_local_data"
  });
}

function buildAdditionalOutcomeFailures(inputs) {
  const outcomes = asArray(inputs.outcomes.value && inputs.outcomes.value.outcomes);

  return outcomes
    .filter((outcome) => ["fallo", "mixto"].includes(outcome.outcomeLabel))
    .filter((outcome) => !["ATYR", "OCS", "KVYO"].includes(normalizeTicker(outcome.ticker)))
    .map((outcome) => {
      const ticker = normalizeTicker(outcome.ticker);
      const tradeTypes = inferTradeTypes(outcome, ticker);
      const instrumentType = inferInstrumentType(outcome, ticker);
      const failureType = [];

      if (!outcome.catalystType) {
        failureType.push("missing_catalyst");
      }

      if (!outcome.invalidationRule && !outcome.invalidation) {
        failureType.push("no_invalidation_rule");
      }

      if (!outcome.timeStop) {
        failureType.push("no_time_stop");
      }

      return buildFailureCase({
        actualFailure: outcome.why || "Outcome fallido o mixto registrado en data/outcomes.",
        catalystDate: outcome.catalystDate || null,
        entryThesis: outcome.expectedMove || outcome.setupType,
        expectedPath: outcome.expectedMove || null,
        exitRule: outcome.exitRule || null,
        expiryDate: outcome.expiryDate || null,
        failureType: failureType.length ? failureType : ["data_stale"],
        instrumentType,
        invalidationRule: outcome.invalidationRule || null,
        lesson: outcome.lessons || "Convertir outcome fallido en regla verificable antes de repetir setup.",
        maxLossAccepted: outcome.maxLossAccepted || null,
        preventableBy: ["lifecycleGuard"],
        requiredSystemRule: ["active position or setup must have complete lifecycle before capital risk"],
        reviewDate: outcome.resolvedAt || outcome.loggedAt,
        ticker,
        timeStop: outcome.timeStop || null,
        tradeTypes,
        dataPresence: "present_outcomes"
      });
    });
}

function inferLifecycleTradeType(position) {
  const ticker = normalizeTicker(position.ticker);
  const tradeTypes = inferTradeTypes(position, ticker);

  if (position.tradeType) {
    return position.tradeType;
  }

  return primaryTradeType(tradeTypes);
}

function missingFieldsForPosition(position, currentDate) {
  const missing = [];
  const warnings = [];
  const ticker = normalizeTicker(position.ticker);
  const instrumentType = inferInstrumentType(position, ticker);
  const inferredTradeType = inferLifecycleTradeType(position);
  const actualTradeType = position.tradeType;
  const requiredGeneral = [
    "tradeType",
    "entryThesis",
    "expectedPath",
    "invalidationRule",
    "exitRule",
    "nextReviewAt",
    "maxLossAccepted"
  ];

  requiredGeneral.forEach((field) => {
    if (!hasValue(position[field])) {
      missing.push(field);
    }
  });

  if (instrumentType === "option" || instrumentType === "spread") {
    ["expiryDate", "timeStop", "maxPremiumLoss", "reviewBeforeThetaDate"].forEach((field) => {
      if (!hasValue(position[field])) {
        missing.push(field);
      }
    });
  }

  if (inferredTradeType === "binary_runup") {
    if (!hasValue(position.catalystDate)) {
      missing.push("catalystDate");
    }

    if (!hasValue(position.exitBeforeEventDate)) {
      missing.push("exitBeforeEventDate");
    } else if (currentDate >= position.exitBeforeEventDate) {
      warnings.push("reduce_or_exit_suggested");
    }

    if (position.explicitHoldThroughBinary === true) {
      warnings.push("binary_runup_cannot_hold_through_event");
    }
  }

  if (inferredTradeType === "binary_lotto") {
    if (position.explicitHoldThroughBinary !== true) {
      missing.push("explicitHoldThroughBinary");
    }

    if (!hasValue(position.maxLossAccepted)) {
      missing.push("maxLossAccepted");
    }

    if (!/lotto/i.test(String(position.sizingNote || position.sizeClass || ""))) {
      missing.push("lottoSize");
    }
  }

  if (inferredTradeType === "valuation_repricing") {
    ["thesisReviewDate", "valuationTrigger", "timeStop"].forEach((field) => {
      if (!hasValue(position[field])) {
        missing.push(field);
      }
    });

    if ((instrumentType === "option" || instrumentType === "spread") && !hasValue(position.timeStop)) {
      missing.push("timeStop");
    }
  }

  return {
    inferredTradeType,
    instrumentType,
    missingLifecycleFields: [...new Set(missing)],
    warnings: [...new Set(warnings)]
  };
}

function buildLifecycleRows(inputs, currentDate) {
  const positions = asArray(inputs.positions.value && inputs.positions.value.positions).filter(isActivePosition);

  return positions.map((position) => {
    const check = missingFieldsForPosition(position, currentDate);
    const incomplete = check.missingLifecycleFields.length > 0;
    const requiresAction = incomplete || check.warnings.length > 0;

    return {
      ticker: normalizeTicker(position.ticker),
      quantity: position.quantity,
      status: position.status,
      instrumentType: check.instrumentType,
      tradeType: position.tradeType || null,
      inferredTradeType: check.inferredTradeType,
      lifecycleStatus: incomplete ? "incomplete" : "complete",
      safeToOperate: false,
      noAdd: requiresAction ? true : position.noAdd === true,
      requireManualReview: requiresAction ? true : position.requireManualReview === true,
      missingLifecycleFields: check.missingLifecycleFields,
      warnings: check.warnings,
      suggestedAction: check.warnings.includes("reduce_or_exit_suggested")
        ? "reduce_or_exit_suggested"
        : incomplete
          ? "complete_lifecycle_before_any_add"
          : "review_only",
      existingRiskFlags: {
        catalystStatus: position.catalystStatus || null,
        noAdd: position.noAdd === true,
        riskStatus: position.riskStatus || null,
        thesisStatus: position.thesisStatus || null
      }
    };
  });
}

function buildInputs() {
  return {
    dailyLog: readJsonInput(INPUT_PATHS.dailyLog),
    dailyRunLatest: readJsonInput(INPUT_PATHS.dailyRunLatest, false),
    dataHygieneAuditLatest: readJsonInput(INPUT_PATHS.dataHygieneAuditLatest, false),
    outcomes: readJsonInput(INPUT_PATHS.outcomes),
    positions: readJsonInput(INPUT_PATHS.positions),
    positionShockLatest: readJsonInput(INPUT_PATHS.positionShockLatest, false),
    preCatalystExitGuardLatest: readJsonInput(INPUT_PATHS.preCatalystExitGuardLatest, false),
    settings: readJsonInput(INPUT_PATHS.settings),
    biotechExpandedExample: readJsonInput(INPUT_PATHS.biotechExpandedExample),
    watchlist: readJsonInput(INPUT_PATHS.watchlist)
  };
}

function wrapProvidedInput(key, value) {
  return {
    exists: value !== null && value !== undefined,
    path: INPUT_PATHS[key] || "provided",
    value
  };
}

function buildInputsFromProvided(providedInputs) {
  const emptyInputs = {
    biotechExpandedExample: {},
    dailyLog: {},
    dailyRunLatest: null,
    dataHygieneAuditLatest: null,
    outcomes: { outcomes: [] },
    positionShockLatest: null,
    positions: { positions: [] },
    preCatalystExitGuardLatest: null,
    settings: { timezone: "America/Argentina/Buenos_Aires" },
    watchlist: { watchlist: [] }
  };
  const merged = {
    ...emptyInputs,
    ...providedInputs,
    positions: providedInputs.positions || emptyInputs.positions,
    settings: providedInputs.settings || emptyInputs.settings,
    watchlist: providedInputs.watchlist || emptyInputs.watchlist
  };

  return Object.fromEntries(
    Object.keys(emptyInputs).map((key) => [key, wrapProvidedInput(key, merged[key])])
  );
}

function summarizePatterns(failures, lifecycleRows) {
  const patternCounts = new Map();

  failures.forEach((failure) => {
    failure.failureType.forEach((type) => {
      patternCounts.set(type, (patternCounts.get(type) || 0) + 1);
    });
  });

  return {
    commonPattern: [
      "El error recurrente no es discovery: es ciclo de vida incompleto despues de encontrar un setup.",
      "Los fallos combinan catalyst binario, falta de salida pre-evento, falta de time-stop y tesis rota reconocida tarde.",
      "social = discovery; data = conviction; lifecycle = supervivencia."
    ],
    failureTypeCounts: Object.fromEntries([...patternCounts.entries()].sort()),
    incompleteActivePositions: lifecycleRows.filter((row) => row.lifecycleStatus === "incomplete").length
  };
}

function modulesCoverage() {
  return [
    {
      module: "preCatalystExitGuard",
      covers: ["binary_runup exit window", "explicitHoldThroughBinary missing"],
      stillMissing: ["does not persist lifecycle fields into positions"]
    },
    {
      module: "positionShockMonitor",
      covers: ["shock_not_detected after current fix", "freeze/noAdd/manual review"],
      stillMissing: ["does not define pre-entry lifecycle"]
    },
    {
      module: "dataHygieneAudit",
      covers: ["post-apply stale acknowledgement", "schema-safe proposals"],
      stillMissing: ["does not block active positions without lifecycle"]
    },
    {
      module: "failureAuditLifecycleGuard",
      covers: ["failure memory", "active lifecycle completeness", "required system rules"],
      stillMissing: ["manual human confirmation before any real operation remains external"]
    }
  ];
}

function renderList(items, emptyMessage) {
  if (!items || items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function renderFailure(failure) {
  return [
    `- ${failure.ticker}: ${failure.tradeTypes.join(", ")} | ${failure.instrumentType}`,
    `  - failureType: ${failure.failureType.join(", ")}`,
    `  - preventableBy: ${failure.preventableBy.join(", ")}`,
    `  - lesson: ${failure.lesson}`
  ].join("\n");
}

function renderSummary(payload) {
  const incomplete = payload.lifecycle.positions.filter((row) => row.lifecycleStatus === "incomplete");
  const lines = [];

  lines.push("# WALY Failure Audit & Trade Lifecycle Guard v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push(`Fecha local: ${payload.currentDate}`);
  lines.push("Modo: research-only. No opera, no modifica data real.");
  lines.push("");
  lines.push("## 1. Fallas auditadas");
  lines.push(payload.failures.map(renderFailure).join("\n"));
  lines.push("");
  lines.push("## 2. Patron comun");
  lines.push(renderList(payload.patterns.commonPattern, "Sin patron comun detectado."));
  lines.push("");
  lines.push("## 3. Que hubiera prevenido cada falla");
  payload.failures.forEach((failure) => {
    lines.push(`- ${failure.ticker}: ${failure.preventableBy.join(", ")}.`);
  });
  lines.push("");
  lines.push("## 4. Posiciones actuales con lifecycle incompleto");
  if (!incomplete.length) {
    lines.push("- Ninguna.");
  } else {
    incomplete.forEach((row) => {
      lines.push(
        `- ${row.ticker}: ${row.lifecycleStatus} | inferredTradeType ${row.inferredTradeType} | missing ${row.missingLifecycleFields.join(", ")} | suggestedAction ${row.suggestedAction}`
      );
    });
  }
  lines.push("");
  lines.push("## 5. Reglas obligatorias nuevas");
  payload.requiredSystemRules.forEach((rule) => {
    lines.push(`- ${rule.id}: ${rule.rule}`);
  });
  lines.push("");
  lines.push("## 6. Modulos actuales que cubren el problema");
  payload.modulesCoverage.forEach((row) => {
    lines.push(`- ${row.module}: cubre ${row.covers.join(", ")}; falta ${row.stillMissing.join(", ")}.`);
  });
  lines.push("");
  lines.push("## 7. Que sigue faltando");
  lines.push(renderList(payload.stillMissing, "Nada adicional."));
  lines.push("");
  lines.push("## 8. Confirmacion no operacion / no IBKR / no Binance");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function buildPayload(options = {}) {
  const inputs = options.inputs ? buildInputsFromProvided(options.inputs) : buildInputs();
  const currentDate = getCurrentDateInTimezone(inputs.settings.value.timezone);
  const failures = [
    buildOcsFailure(inputs),
    buildAtyrFailure(inputs),
    buildKvyoFailure(inputs),
    ...buildAdditionalOutcomeFailures(inputs)
  ];
  const lifecycleRows = buildLifecycleRows(inputs, currentDate);
  const incompleteRows = lifecycleRows.filter((row) => row.lifecycleStatus === "incomplete");
  const patterns = summarizePatterns(failures, lifecycleRows);
  const stillMissing = [
    "Persistir campos lifecycle en data real solo mediante una futura revision humana/aprobada.",
    "Conectar lifecycleStatus a cualquier modulo futuro que proponga sizing.",
    "Agregar memoria estructurada para KVYO si se quiere medir ese caso con datos exactos.",
    "Convertir required_system_rules.json en tests de regresion si el guard pasa a ser obligatorio."
  ];

  return {
    confirmations: CONFIRMATIONS,
    currentDate,
    failureClassifications: Object.fromEntries(
      failures.map((failure) => [
        failure.ticker,
        {
          failureType: failure.failureType,
          instrumentType: failure.instrumentType,
          tradeType: failure.tradeType,
          tradeTypes: failure.tradeTypes
        }
      ])
    ),
    failures,
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
    lifecycle: {
      incompleteCount: incompleteRows.length,
      positions: lifecycleRows,
      safeToOperate: false
    },
    mode: "research-only",
    modulesCoverage: modulesCoverage(),
    outputScope: "backtests/failure-audit-lifecycle-guard/",
    patterns,
    requiredSystemRules: REQUIRED_SYSTEM_RULES,
    safeToCommit: false,
    safeToOperate: false,
    stillMissing,
    touchedDataReal: false,
    touchedOutcomes: false,
    touchedSocialSignals: false
  };
}

function renderConsoleReport(payload) {
  const failures = payload.failures.map((failure) => `${failure.ticker}:${failure.tradeTypes.join("+")}`).join(" | ");
  const incomplete = payload.lifecycle.positions
    .filter((row) => row.lifecycleStatus === "incomplete")
    .map((row) => `${row.ticker}:${row.missingLifecycleFields.length}`)
    .join(" | ");

  return [
    "WALY Failure Audit & Trade Lifecycle Guard v1 generado.",
    `mode: ${payload.mode}`,
    `failuresDetected: ${payload.failures.length} | ${failures || "ninguna"}`,
    `OCS classification: ${payload.failureClassifications.OCS.tradeTypes.join(", ")} | ${payload.failureClassifications.OCS.failureType.join(", ")}`,
    `ATYR classification: ${payload.failureClassifications.ATYR.tradeTypes.join(", ")} | ${payload.failureClassifications.ATYR.failureType.join(", ")}`,
    `KVYO classification: ${payload.failureClassifications.KVYO.tradeTypes.join(", ")} | ${payload.failureClassifications.KVYO.failureType.join(", ")}`,
    `incompleteActivePositions: ${payload.lifecycle.incompleteCount} | ${incomplete || "ninguna"}`,
    `requiredRules: ${payload.requiredSystemRules.length}`,
    `safeToOperate: ${payload.safeToOperate ? "true" : "false"}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    `required_system_rules.json: ${formatRelative(REQUIRED_RULES_PATH)}`,
    "safe-to-commit: no",
    "Confirmacion: no operacion, no IBKR, no Binance, no ordenes, no data real modificada, no commit, no push."
  ].join("\n");
}

function runFailureAuditLifecycleGuard(options = {}) {
  const payload = buildPayload();
  let paths = {
    latestPath: null,
    outputDir: OUTPUT_DIR,
    requiredSystemRulesPath: null,
    summaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = {
      latestPath: writeJson(LATEST_PATH, payload),
      outputDir: OUTPUT_DIR,
      requiredSystemRulesPath: writeJson(REQUIRED_RULES_PATH, {
        generatedAt: payload.generatedAt,
        mode: payload.mode,
        rules: payload.requiredSystemRules
      }),
      summaryPath: writeText(SUMMARY_PATH, renderSummary(payload))
    };
  }

  const result = {
    ...payload,
    paths
  };

  return {
    ...result,
    consoleReport: renderConsoleReport(result),
    summaryMarkdown: renderSummary(result)
  };
}

module.exports = {
  buildPayload,
  runFailureAuditLifecycleGuard
};
