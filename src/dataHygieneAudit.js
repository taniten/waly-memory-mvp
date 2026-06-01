"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "data-hygiene-audit");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const PROPOSED_CHANGES_PATH = path.join(OUTPUT_DIR, "proposed_changes.json");

const INPUT_PATHS = {
  settings: "data/settings.json",
  positions: "data/positions.json",
  watchlist: "data/watchlist.json",
  fda: "data/fda.json",
  earnings: "data/earnings.json",
  dailyLog: "data/daily_log.json",
  outcomes: "data/outcomes.json",
  biotechExpandedExample: "examples/biotech-binary-events-expanded.example.json",
  dailyRunLatest: "backtests/daily-run/latest.json",
  positionShockLatest: "backtests/position-shock-monitor/latest.json",
  preCatalystExitGuardLatest: "backtests/pre-catalyst-exit-guard/latest.json",
  biotechDatasetExpansionLatest: "backtests/biotech-binary-dataset-expansion/latest.json"
};

const CONFIRMATIONS = [
  "No opera.",
  "No usa IBKR.",
  "No usa Binance.",
  "No envia ordenes.",
  "No modifica data/*.json.",
  "No modifica outcomes.",
  "No modifica social_signals.",
  "No commit.",
  "No push.",
  "Output solo en backtests/data-hygiene-audit/."
];

function assertAuditOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("data-hygiene-audit solo puede escribir dentro de backtests/data-hygiene-audit/.");
  }
}

function writeJson(filePath, value) {
  assertAuditOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writeText(filePath, value) {
  assertAuditOutputPath(filePath);
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

function textIncludes(row, pattern) {
  const merged = [
    row && row.thesis,
    row && row.rationale,
    row && row.catalyst,
    row && row.notes,
    row && row.invalidation,
    row && row.source,
    row && row.setupType
  ].filter(Boolean).join(" ").toLowerCase();

  return pattern.test(merged);
}

function isPastDate(date, currentDate) {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < currentDate;
}

function collectInputStatus(inputs) {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, input]) => [
      key,
      {
        exists: input.exists,
        path: input.path
      }
    ])
  );
}

function addIssue(issues, issue) {
  issues.push({
    detectedAt: new Date().toISOString(),
    ...issue
  });
}

function buildInputs() {
  const settings = readJsonInput(INPUT_PATHS.settings);
  const positions = readJsonInput(INPUT_PATHS.positions);

  return {
    settings,
    positions,
    watchlist: readJsonInput(INPUT_PATHS.watchlist),
    fda: readJsonInput(INPUT_PATHS.fda),
    earnings: readJsonInput(INPUT_PATHS.earnings),
    dailyLog: readJsonInput(INPUT_PATHS.dailyLog),
    outcomes: readJsonInput(INPUT_PATHS.outcomes),
    biotechExpandedExample: readJsonInput(INPUT_PATHS.biotechExpandedExample),
    dailyRunLatest: readJsonInput(INPUT_PATHS.dailyRunLatest, false),
    positionShockLatest: readJsonInput(INPUT_PATHS.positionShockLatest, false),
    preCatalystExitGuardLatest: readJsonInput(INPUT_PATHS.preCatalystExitGuardLatest, false),
    biotechDatasetExpansionLatest: readJsonInput(INPUT_PATHS.biotechDatasetExpansionLatest, false)
  };
}

function auditOcsThesis(inputs, proposedChanges, issues) {
  const positions = asArray(inputs.positions.value.positions);
  const watchlist = asArray(inputs.watchlist.value.watchlist);
  const fdaCatalysts = asArray(inputs.fda.value.catalysts);
  const shockRows = asArray(inputs.positionShockLatest.value && inputs.positionShockLatest.value.rows);
  const guardRows = asArray(inputs.preCatalystExitGuardLatest.value && inputs.preCatalystExitGuardLatest.value.rows);
  const datasetEvents = asArray(inputs.biotechDatasetExpansionLatest.value && inputs.biotechDatasetExpansionLatest.value.events);
  const ocsPosition = findByTicker(positions, "OCS");
  const ocsWatch = findByTicker(watchlist, "OCS");
  const ocsFda = findByTicker(fdaCatalysts, "OCS");
  const ocsShock = findByTicker(shockRows, "OCS");
  const ocsGuard = findByTicker(guardRows, "OCS");
  const ocsDataset = findByTicker(datasetEvents, "OCS");
  const hasOldDiamondThesis = [ocsPosition, ocsWatch].filter(Boolean).some((row) => textIncludes(row, /diamond|phase\s*3|topline/));
  const shockFreeze = ocsShock && ocsShock.shockSeverity === "freeze_position" && ocsShock.suggestedAction === "freeze";
  const guardExit = ocsGuard && ["reduce_or_exit_suggested", "do_not_hold_through_event"].includes(ocsGuard.suggestedAction);
  const datasetFailure = ocsDataset && ocsDataset.classification === "post_failure_candidate";

  if (hasOldDiamondThesis && shockFreeze && guardExit && datasetFailure) {
    addIssue(issues.critical, {
      code: "OCS_THESIS_BROKEN",
      evidence: {
        biotechDatasetClassification: ocsDataset.classification,
        guardSuggestedAction: ocsGuard.suggestedAction,
        oldPositionStatus: ocsPosition && ocsPosition.status,
        oldWatchlistStatus: ocsWatch && ocsWatch.status,
        shockSeverity: ocsShock.shockSeverity
      },
      message: "OCS sigue con tesis vieja de DIAMOND aunque shock, exit guard y dataset indican tesis rota.",
      severity: "critical",
      ticker: "OCS"
    });
  }

  const recommended = {
    noAdd: true,
    reason: "Phase 3 DIAMOND failed primary/key secondary; no FDA filing for DME currently planned.",
    requireManualReview: true,
    requireNewsCheck: true,
    status: "freeze / revisar_manual",
    suggestedAction: "exit_or_reduce_after_news_confirmed",
    thesisStatus: "thesis_broken"
  };

  proposedChanges.byTicker.OCS = {
    ...(proposedChanges.byTicker.OCS || {}),
    thesisBroken: recommended
  };

  proposedChanges.byFile["data/positions.json"].push({
    action: "propose_update_only",
    key: "positions[ticker=OCS]",
    reason: recommended.reason,
    set: recommended
  });

  if (ocsWatch) {
    proposedChanges.byFile["data/watchlist.json"].push({
      action: "propose_update_only",
      key: "watchlist[ticker=OCS]",
      reason: "Watchlist OCS debe dejar de generar entrada nueva tras la falla DIAMOND.",
      set: {
        catalystStatus: "occurred / failed",
        inPortfolio: true,
        noAdd: true,
        sourceOfTruth: "positions",
        status: "revisar_manual",
        thesisStatus: "thesis_broken"
      }
    });
  }

  return {
    datasetFailure,
    guardExit,
    hasOldDiamondThesis,
    ocsDataset,
    ocsFda,
    ocsGuard,
    ocsPosition,
    ocsShock,
    ocsWatch,
    recommendation: recommended,
    shockFreeze
  };
}

function auditOverdueReviews(inputs, currentDate, proposedChanges, issues) {
  const sources = [
    ["positions", "data/positions.json", asArray(inputs.positions.value.positions)],
    ["watchlist", "data/watchlist.json", asArray(inputs.watchlist.value.watchlist)]
  ];
  const rows = [];

  sources.forEach(([sourceKind, filePath, items]) => {
    items.forEach((item) => {
      const ticker = normalizeTicker(item && item.ticker);
      if (ticker && isPastDate(item.nextReviewAt, currentDate)) {
        rows.push({
          currentNextReviewAt: item.nextReviewAt,
          filePath,
          sourceKind,
          ticker
        });
      }
    });
  });

  const uniqueTickers = [...new Set(rows.map((row) => row.ticker))].sort();
  const reviewPlan = {
    MNKD: {
      suggestedCadence: "revisar catalyst ya vencido 2026-05-29",
      suggestedNextReviewAt: "2026-06-01"
    },
    OCS: {
      suggestedCadence: "inmediata / today",
      suggestedNextReviewAt: "2026-06-01"
    },
    VERA: {
      suggestedCadence: "revision semanal si sigue en watchlist",
      suggestedNextReviewAt: "weekly_review"
    },
    VKTX: {
      suggestedCadence: "cuando haya catalyst verificable o revision semanal",
      suggestedNextReviewAt: "weekly_review_or_verified_catalyst"
    },
    VRDN: {
      suggestedCadence: "antes de PDUFA 2026-06-30",
      suggestedNextReviewAt: "before_2026-06-30"
    }
  };

  if (rows.length) {
    addIssue(issues.minor, {
      code: "OVERDUE_NEXT_REVIEW",
      count: rows.length,
      message: "Hay nextReviewAt vencidos en posiciones/watchlist.",
      severity: "minor",
      tickers: uniqueTickers
    });
  }

  rows.forEach((row) => {
    const proposal = reviewPlan[row.ticker] || {
      suggestedCadence: "revision manual",
      suggestedNextReviewAt: currentDate
    };

    proposedChanges.byFile[row.filePath].push({
      action: "propose_update_only",
      key: `${row.sourceKind}[ticker=${row.ticker}].nextReviewAt`,
      reason: `nextReviewAt vencido: ${row.currentNextReviewAt}`,
      set: proposal
    });

    proposedChanges.byTicker[row.ticker] = {
      ...(proposedChanges.byTicker[row.ticker] || {}),
      nextReviewAt: proposal
    };
  });

  return {
    rows,
    uniqueTickers
  };
}

function auditPositionWatchlistDuplicates(inputs, proposedChanges, issues) {
  const positionTickers = new Set(asArray(inputs.positions.value.positions).map((item) => normalizeTicker(item && item.ticker)));
  const duplicates = asArray(inputs.watchlist.value.watchlist)
    .map((item) => normalizeTicker(item && item.ticker))
    .filter((ticker) => ticker && positionTickers.has(ticker))
    .sort();

  if (duplicates.length) {
    addIssue(issues.minor, {
      code: "POSITION_WATCHLIST_DUPLICATE",
      message: "Tickers aparecen en positions y watchlist; no es fatal, pero positions debe mandar.",
      severity: "minor",
      tickers: duplicates
    });
  }

  duplicates.forEach((ticker) => {
    const proposal = {
      inPortfolio: true,
      newEntryAllowed: false,
      sourceOfTruth: "positions"
    };

    proposedChanges.byFile["data/watchlist.json"].push({
      action: "propose_update_only",
      key: `watchlist[ticker=${ticker}]`,
      reason: "Ticker tambien esta en cartera abierta; la watchlist no debe generar nueva entrada.",
      set: proposal
    });

    proposedChanges.byTicker[ticker] = {
      ...(proposedChanges.byTicker[ticker] || {}),
      duplicatePositionWatchlist: proposal
    };
  });

  return duplicates;
}

function auditCatalystMismatch(ocsContext, proposedChanges, issues) {
  const positionDate = ocsContext.ocsPosition && ocsContext.ocsPosition.catalystDate;
  const watchlistDate = ocsContext.ocsWatch && ocsContext.ocsWatch.catalystDate;
  const fdaDate = ocsContext.ocsFda && ocsContext.ocsFda.catalystDate;
  const positionSource = ocsContext.ocsPosition && ocsContext.ocsPosition.source;
  const watchlistSource = ocsContext.ocsWatch && ocsContext.ocsWatch.source;
  const fdaSource = ocsContext.ocsFda && ocsContext.ocsFda.source;
  const dates = [...new Set([positionDate, watchlistDate, fdaDate].filter(Boolean))];
  const sources = [...new Set([positionSource, watchlistSource, fdaSource].filter(Boolean))];
  const hasMismatch = dates.length > 1 || sources.length > 1;

  if (hasMismatch) {
    addIssue(issues.critical, {
      code: "OCS_CATALYST_MISMATCH",
      evidence: {
        dates,
        sources
      },
      message: "OCS tiene catalystDate/source divergentes entre positions, watchlist y fda.",
      severity: "critical",
      ticker: "OCS"
    });
  }

  const proposal = {
    catalystStatus: "occurred / failed",
    eventDate: "2026-05-29",
    newsDate: "2026-05-29",
    oldFutureCatalystStatus: "stale",
    reason: "DIAMOND result ya ocurrio; no mantener fecha futura como catalyst operable."
  };

  ["data/positions.json", "data/watchlist.json", "data/fda.json"].forEach((filePath) => {
    proposedChanges.byFile[filePath].push({
      action: "propose_update_only",
      key: `${filePath.includes("fda") ? "catalysts" : filePath.includes("positions") ? "positions" : "watchlist"}[ticker=OCS]`,
      reason: proposal.reason,
      set: proposal
    });
  });

  proposedChanges.byTicker.OCS = {
    ...(proposedChanges.byTicker.OCS || {}),
    catalystMismatch: proposal
  };

  return {
    dates,
    hasMismatch,
    sources
  };
}

function auditVktxCatalystType(inputs, proposedChanges, issues) {
  const vktxPosition = findByTicker(asArray(inputs.positions.value.positions), "VKTX");
  const missingCatalystType = vktxPosition && !vktxPosition.catalystType;

  if (missingCatalystType) {
    addIssue(issues.minor, {
      code: "VKTX_MISSING_CATALYST_TYPE",
      message: "VKTX no tiene catalystType en positions; no inventar catalyst duro.",
      severity: "minor",
      ticker: "VKTX"
    });
  }

  const proposal = {
    catalystStatus: "research",
    catalystType: "unknown_or_event_swing",
    noAPlusUntil: "verified_catalyst",
    reason: "No clasificar como A+ hasta catalyst verificable."
  };

  proposedChanges.byFile["data/positions.json"].push({
    action: "propose_update_only",
    key: "positions[ticker=VKTX]",
    reason: "VKTX no debe heredar catalyst fda si el setup actual es event-swing de atencion.",
    set: proposal
  });

  proposedChanges.byTicker.VKTX = {
    ...(proposedChanges.byTicker.VKTX || {}),
    catalystType: proposal
  };

  return {
    missingCatalystType,
    proposal,
    vktxPosition
  };
}

function auditPlrxDataset(inputs, proposedChanges, issues) {
  const events = asArray(inputs.biotechDatasetExpansionLatest.value && inputs.biotechDatasetExpansionLatest.value.events);
  const scores = asArray(inputs.biotechDatasetExpansionLatest.value && inputs.biotechDatasetExpansionLatest.value.scores);
  const plrxEvent = findByTicker(events, "PLRX");
  const plrxScore = findByTicker(scores, "PLRX");
  const score = plrxEvent ? plrxEvent.binaryFragilityScore : (plrxScore && plrxScore.binaryFragilityScore);
  const classification = plrxEvent ? plrxEvent.classification : (plrxScore && plrxScore.classification);
  const inconsistent = score === 0 && classification === "post_failure_candidate";

  if (inconsistent) {
    addIssue(issues.minor, {
      code: "PLRX_SCORE_CLASSIFICATION_INCONSISTENCY",
      evidence: {
        binaryFragilityScore: score,
        classification,
        missingCriticalFields: (plrxEvent && plrxEvent.missingCriticalFields) || (plrxScore && plrxScore.missingCriticalFields) || []
      },
      message: "PLRX tiene score 0 pero classification post_failure_candidate.",
      severity: "minor",
      ticker: "PLRX"
    });
  }

  const proposal = {
    classification: "needs_data",
    edgeEligible: false,
    reason: "Datos criticos faltantes; no usarlo para edge hasta corregir.",
    scoreStatus: "incomplete"
  };

  proposedChanges.byFile["examples/biotech-binary-events-expanded.example.json"].push({
    action: "propose_update_only",
    key: "events[ticker=PLRX]",
    reason: proposal.reason,
    set: proposal
  });

  proposedChanges.byTicker.PLRX = {
    ...(proposedChanges.byTicker.PLRX || {}),
    datasetConsistency: proposal
  };

  return {
    inconsistent,
    plrxEvent,
    proposal
  };
}

function buildProposedChanges() {
  return {
    applied: false,
    byFile: {
      "data/positions.json": [],
      "data/watchlist.json": [],
      "data/fda.json": [],
      "data/earnings.json": [],
      "data/daily_log.json": [],
      "data/outcomes.json": [],
      "examples/biotech-binary-events-expanded.example.json": []
    },
    byTicker: {},
    mode: "proposal_only",
    untouched: [
      "data/*.json",
      "data/outcomes.json",
      "data/social_signals.json",
      "ordenes",
      "IBKR",
      "Binance",
      "commits",
      "pushes"
    ]
  };
}

function renderIssueList(items) {
  if (!items.length) {
    return "- Ninguna.";
  }

  return items.map((item) => {
    const tickerText = item.ticker ? `${item.ticker}: ` : "";
    const tickersText = item.tickers ? ` (${item.tickers.join(", ")})` : "";
    return `- ${tickerText}${item.code} - ${item.message}${tickersText}`;
  }).join("\n");
}

function renderChangesByFile(proposedChanges) {
  const lines = [];

  Object.entries(proposedChanges.byFile).forEach(([filePath, changes]) => {
    if (!changes.length) {
      return;
    }

    lines.push(`### ${filePath}`);
    changes.forEach((change) => {
      lines.push(`- ${change.key}: ${change.reason}`);
    });
    lines.push("");
  });

  return lines.length ? lines.join("\n").trimEnd() : "- Ninguno.";
}

function renderChangesByTicker(proposedChanges) {
  const tickers = Object.keys(proposedChanges.byTicker).sort();

  if (!tickers.length) {
    return "- Ninguno.";
  }

  return tickers.map((ticker) => {
    const buckets = Object.keys(proposedChanges.byTicker[ticker]).sort().join(", ");
    return `- ${ticker}: ${buckets}`;
  }).join("\n");
}

function renderHumanConfirmations(payload) {
  const lines = [
    "- Confirmar noticia primaria de OCS/DIAMOND y si la falla implica salida, reduccion o congelamiento hasta nueva tesis.",
    "- Confirmar si OCS debe permanecer en watchlist solo como post-failure research o salir de watchlist operativa.",
    "- Confirmar si VKTX sigue como event-swing research sin catalyst permitido.",
    "- Confirmar si PLRX queda como needs_data hasta completar campos criticos.",
    "- Confirmar nueva agenda de nextReviewAt para VKTX, VRDN, OCS, VERA y MNKD."
  ];

  if (payload.safeToOperate === false) {
    lines.push("- Confirmar que safeToOperate permanece false antes de cualquier decision operativa futura.");
  }

  return lines.join("\n");
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Data Hygiene Audit v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push(`Fecha local: ${payload.currentDate}`);
  lines.push("Modo: read-only. Propuesta de limpieza solamente; no modifica data real.");
  lines.push("");
  lines.push("## 1. Inconsistencias criticas");
  lines.push(renderIssueList(payload.issues.critical));
  lines.push("");
  lines.push("## 2. Inconsistencias menores");
  lines.push(renderIssueList(payload.issues.minor));
  lines.push("");
  lines.push("## 3. Cambios propuestos por archivo");
  lines.push(renderChangesByFile(payload.proposedChanges));
  lines.push("");
  lines.push("## 4. Cambios propuestos por ticker");
  lines.push(renderChangesByTicker(payload.proposedChanges));
  lines.push("");
  lines.push("## 5. Requiere confirmacion humana");
  lines.push(renderHumanConfirmations(payload));
  lines.push("");
  lines.push("## 6. Que NO se toco");
  payload.proposedChanges.untouched.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## 7. Confirmacion no operacion / no IBKR / no Binance / no data real modificada");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(payload) {
  const critical = payload.issues.critical.map((issue) => issue.ticker ? `${issue.ticker}:${issue.code}` : issue.code);
  const minor = payload.issues.minor.map((issue) => issue.ticker ? `${issue.ticker}:${issue.code}` : issue.code);
  const paths = payload.paths;

  return [
    "WALY Data Hygiene Audit v1 generado.",
    `Critical inconsistencies: ${payload.issues.critical.length} | ${critical.join(" | ") || "ninguna"}`,
    `Minor inconsistencies: ${payload.issues.minor.length} | ${minor.join(" | ") || "ninguna"}`,
    `OCS proposal: ${payload.proposedChanges.byTicker.OCS && payload.proposedChanges.byTicker.OCS.thesisBroken ? payload.proposedChanges.byTicker.OCS.thesisBroken.suggestedAction : "n/d"}`,
    `VKTX proposal: ${payload.proposedChanges.byTicker.VKTX && payload.proposedChanges.byTicker.VKTX.catalystType ? payload.proposedChanges.byTicker.VKTX.catalystType.catalystType : "n/d"}`,
    `VRDN proposal: ${payload.proposedChanges.byTicker.VRDN && payload.proposedChanges.byTicker.VRDN.nextReviewAt ? payload.proposedChanges.byTicker.VRDN.nextReviewAt.suggestedCadence : "n/d"}`,
    `PLRX proposal: ${payload.proposedChanges.byTicker.PLRX && payload.proposedChanges.byTicker.PLRX.datasetConsistency ? payload.proposedChanges.byTicker.PLRX.datasetConsistency.classification : "n/d"}`,
    `latest.json: ${formatRelative(paths.latestPath)}`,
    `summary.md: ${formatRelative(paths.summaryPath)}`,
    `proposed_changes.json: ${formatRelative(paths.proposedChangesPath)}`,
    "safe-to-commit: no",
    "Confirmacion: no operacion, no IBKR, no Binance, no data real modificada, no commit, no push."
  ].join("\n");
}

function buildAuditPayload() {
  const inputs = buildInputs();
  const currentDate = getCurrentDateInTimezone(inputs.settings.value.timezone);
  const proposedChanges = buildProposedChanges();
  const issues = {
    critical: [],
    minor: []
  };
  const ocs = auditOcsThesis(inputs, proposedChanges, issues);
  const overdueReviews = auditOverdueReviews(inputs, currentDate, proposedChanges, issues);
  const duplicates = auditPositionWatchlistDuplicates(inputs, proposedChanges, issues);
  const catalystMismatch = auditCatalystMismatch(ocs, proposedChanges, issues);
  const vktx = auditVktxCatalystType(inputs, proposedChanges, issues);
  const plrx = auditPlrxDataset(inputs, proposedChanges, issues);

  return {
    confirmations: CONFIRMATIONS,
    currentDate,
    generatedAt: new Date().toISOString(),
    inputStatus: collectInputStatus(inputs),
    issues,
    mode: "read-only",
    outputScope: "backtests/data-hygiene-audit/",
    proposedChanges,
    safeToOperate: false,
    safeToCommit: false,
    touchedDataReal: false,
    touchedOutcomes: false,
    touchedSocialSignals: false,
    audit: {
      catalystMismatch,
      duplicates,
      ocs,
      overdueReviews,
      plrx,
      vktx
    }
  };
}

function writeAuditOutputs(payload) {
  const summaryMarkdown = renderSummary(payload);

  return {
    latestPath: writeJson(LATEST_PATH, payload),
    outputDir: OUTPUT_DIR,
    proposedChangesPath: writeJson(PROPOSED_CHANGES_PATH, payload.proposedChanges),
    summaryPath: writeText(SUMMARY_PATH, summaryMarkdown)
  };
}

function runDataHygieneAudit(options = {}) {
  const payload = buildAuditPayload();
  let paths = {
    latestPath: null,
    outputDir: OUTPUT_DIR,
    proposedChangesPath: null,
    summaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = writeAuditOutputs(payload);
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
  buildAuditPayload,
  runDataHygieneAudit
};
