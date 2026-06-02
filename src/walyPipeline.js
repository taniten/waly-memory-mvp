"use strict";

const fs = require("fs");
const path = require("path");
const {
  OUTPUT_DIR,
  buildPayload: buildSignalLogPayload,
  buildTickerUniverse,
  formatRelative,
  readCoreInputs,
  round,
  writePillarJson,
  writePillarText
} = require("./realSignalLog");
const { buildCatalystPayload } = require("./catalystEngine");
const { buildPostMortemPayload } = require("./postMortemEngine");
const {
  buildRealTickerSet,
  productionAllowsTicker,
  resolveRuntimeMode
} = require("./runtimeMode");
const {
  EXIT_ACTIONS,
  buildPreCatalystExitGuardPayload,
  writePreCatalystExitGuardOutputs
} = require("./preCatalystExitGuard");
const {
  buildPositionShockPayload,
  isFreezeOrWorse,
  writePositionShockOutputs
} = require("./positionShockMonitor");
const { buildPayload: buildLifecycleGuardPayload } = require("./failureAuditLifecycleGuard");
const { buildSizingPayload } = require("./sizingEngine");
const { buildTimingPayload } = require("./timingEngine");
const { buildTrainTestPayload } = require("./trainTestEngine");

const ALLOWED_ACTIONS = new Set([
  "no_operar",
  "mantener",
  "vigilar",
  "revisar_manual",
  "candidato_manual",
  "descartar",
  "reducir_riesgo_sugerido"
]);

const PROHIBITED_ACTIONS = new Set([
  "buy",
  "sell",
  "auto_execute",
  "market_order",
  "limit_order",
  "ibkr",
  "binance"
]);
const PIPELINE_LATEST_PATH = path.join(OUTPUT_DIR, "waly-pipeline-latest.json");

function filterRowsByTicker(rows, allowTicker) {
  return Array.isArray(rows) ? rows.filter((row) => allowTicker(row && row.ticker)) : rows;
}

function filterMarketDataByTicker(marketData, allowTicker) {
  if (!marketData || typeof marketData !== "object") {
    return marketData;
  }

  return Object.fromEntries(
    Object.entries(marketData).filter(([ticker]) => allowTicker(ticker))
  );
}

function filterProductionInputs(inputs) {
  const realTickers = buildRealTickerSet(inputs);
  const allowTicker = (ticker) => productionAllowsTicker(ticker, realTickers, { realOnly: true });
  const dailyCockpit = inputs.dailyCockpit ? {
    ...inputs.dailyCockpit,
    marketData: filterMarketDataByTicker(inputs.dailyCockpit.marketData, allowTicker),
    portfolio: filterRowsByTicker(inputs.dailyCockpit.portfolio, allowTicker),
    router: inputs.dailyCockpit.router ? {
      ...inputs.dailyCockpit.router,
      manualCandidates: Array.isArray(inputs.dailyCockpit.router.manualCandidates)
        ? inputs.dailyCockpit.router.manualCandidates.filter(allowTicker)
        : inputs.dailyCockpit.router.manualCandidates
    } : inputs.dailyCockpit.router,
    watchlist: filterRowsByTicker(inputs.dailyCockpit.watchlist, allowTicker)
  } : inputs.dailyCockpit;
  const selectorEngine = inputs.selectorEngine ? {
    ...inputs.selectorEngine,
    ranking: filterRowsByTicker(inputs.selectorEngine.ranking, allowTicker)
  } : inputs.selectorEngine;
  const socialRadar = inputs.socialRadar ? {
    ...inputs.socialRadar,
    mentions: filterRowsByTicker(inputs.socialRadar.mentions, allowTicker)
  } : inputs.socialRadar;

  return {
    ...inputs,
    dailyCockpit,
    selectorEngine,
    socialRadar
  };
}

function fmt(value, decimals = 1) {
  return typeof value === "number" ? round(value, decimals).toFixed(decimals) : "n/d";
}

function indexByTicker(rows) {
  return new Map((rows || []).map((row) => [row.ticker, row]));
}

function portfolioRows(inputs) {
  return ((inputs.positions && inputs.positions.positions) || []).map((position) => ({
    action: "mantener",
    avgPrice: position.avgPrice,
    lastPrice: position.lastPrice,
    quantity: position.quantity,
    ticker: position.ticker
  }));
}

function socialRows(inputs) {
  return ((inputs.socialRadar && inputs.socialRadar.mentions) || [])
    .filter((mention) => mention.suggestedAction !== "ignore")
    .slice(0, 5)
    .map((mention) => ({
      action: mention.suggestedAction,
      score: mention.socialScore,
      source: mention.displayName,
      ticker: mention.ticker || "n/d"
    }));
}

function isActionProhibited(value) {
  return typeof value === "string" && PROHIBITED_ACTIONS.has(value.trim().toLowerCase());
}

function lowerClassification(classification) {
  if (/^A\+/.test(classification || "")) {
    return "A candidate";
  }

  if (classification === "A candidate") {
    return "B watch";
  }

  if (classification === "B watch") {
    return "C research";
  }

  return classification || "C research";
}

function catalystByTicker(catalystRows) {
  return new Map((catalystRows || []).map((row) => [row.ticker, row]));
}

function hasClearCatalyst(selectorRow, catalystRow) {
  const selectorKind = selectorRow && selectorRow.context && selectorRow.context.catalystKind;
  const selectorDate = selectorRow && selectorRow.context && selectorRow.context.catalystDate;
  const catalystType = catalystRow && catalystRow.catalystType;

  return Boolean(
    selectorDate ||
    (selectorKind && selectorKind !== "unknown") ||
    (catalystType && !["unknown", "social-only"].includes(catalystType))
  );
}

function findProhibitedActionHits({ decision, selectorRanking, sizingRows, socialSignals }) {
  const hits = [];

  function check(source, ticker, fieldName, value) {
    if (isActionProhibited(value)) {
      hits.push({
        fieldName,
        source,
        ticker: ticker || null,
        value: String(value).toLowerCase()
      });
    }
  }

  check("decision", null, "finalAction", decision && decision.finalAction);
  (selectorRanking || []).forEach((row) => check("selector", row.ticker, "actionSuggested", row.actionSuggested));
  (sizingRows || []).forEach((row) => check("sizing", row.ticker, "sizingAction", row.sizingAction));
  (socialSignals || []).forEach((row) => check("social", row.ticker, "action", row.action));

  return hits;
}

function collectMissingData(payloadParts) {
  const rows = [
    ...((payloadParts.catalyst && payloadParts.catalyst.rows) || []),
    ...((payloadParts.timing && payloadParts.timing.rows) || []),
    ...((payloadParts.sizing && payloadParts.sizing.rows) || []),
    ...((payloadParts.selectorRanking) || [])
  ];
  const missing = [];

  rows.forEach((row) => {
    (row.missingData || []).forEach((item) => {
      missing.push(row.ticker ? `${row.ticker}: ${item}` : item);
    });
  });

  return [...new Set(missing)].sort();
}

function dataFreshness(inputs) {
  const marketDates = [];
  const modules = {
    dailyCockpit: inputs.dailyCockpit && inputs.dailyCockpit.generatedAt || null,
    selectorEngine: inputs.selectorEngine && inputs.selectorEngine.generatedAt || null,
    socialRadar: inputs.socialRadar && inputs.socialRadar.generatedAt || null
  };

  ((inputs.dailyCockpit && Object.values(inputs.dailyCockpit.marketData || {})) || []).forEach((row) => {
    if (row && row.lastDataDate) {
      marketDates.push(row.lastDataDate);
    }
  });

  return {
    latestMarketData: marketDates.sort().slice(-1)[0] || null,
    modules
  };
}

function buildHealth({
  conflicts,
  inputs,
  lifecycleGuard,
  missingData,
  positionShockMonitor,
  preCatalystExitGuard,
  prohibitedActionHits,
  redFlags
}) {
  const modulesLoaded = [
    "realSignalLog",
    "catalystEngine",
    "timingEngine",
    "sizingEngine",
    "trainTestEngine",
    "postMortemEngine",
    "preCatalystExitGuard",
    "positionShockMonitor",
    lifecycleGuard ? "failureAuditLifecycleGuard" : null,
    "walyPipeline",
    inputs.dailyCockpit ? "daily-cockpit" : null,
    inputs.selectorEngine ? "selector-engine" : null,
    inputs.socialRadar ? "social-radar" : null
  ].filter(Boolean);
  const modulesMissing = [
    !inputs.dailyCockpit ? "daily-cockpit latest" : null,
    !inputs.selectorEngine ? "selector-engine latest" : null,
    !inputs.socialRadar ? "social-radar latest" : null,
    !inputs.parameterSweep ? "historical parameter-sweep" : null,
    !inputs.signalTypeAnalysis ? "historical signal-type-analysis" : null,
    !inputs.v32Results ? "v3-2 signal-quality results" : null,
    !lifecycleGuard ? "failure-audit-lifecycle-guard" : null
  ].filter(Boolean);
  const reasons = [];
  const lifecycleIncompleteCount =
    lifecycleGuard && lifecycleGuard.lifecycle ? lifecycleGuard.lifecycle.incompleteCount || 0 : 0;

  if (prohibitedActionHits.length > 0) {
    reasons.push("accion prohibida detectada");
  }

  if (conflicts.length > 0) {
    reasons.push("conflictos entre modulos");
  }

  if (modulesMissing.length > 0) {
    reasons.push("modulos o historicos faltantes");
  }

  if (missingData.length > 0) {
    reasons.push("missingData presente");
  }

  if (redFlags.length > 0) {
    reasons.push("red flags activas");
  }

  if (preCatalystExitGuard && preCatalystExitGuard.summary && preCatalystExitGuard.summary.tickersToFreeze.length > 0) {
    reasons.push("pre-catalyst exit guard activo");
  }

  if (positionShockMonitor && positionShockMonitor.summary && positionShockMonitor.summary.freezeOrWorse > 0) {
    reasons.push("position shock monitor activo");
  }

  if (lifecycleIncompleteCount > 0) {
    reasons.push("lifecycle guard incompleto");
  }

  let healthStatus = "green";
  if (prohibitedActionHits.length > 0 || modulesLoaded.length < 7) {
    healthStatus = "red";
  } else if (
    conflicts.length > 0 ||
    modulesMissing.length > 0 ||
    missingData.length > 0 ||
    redFlags.length > 0 ||
    lifecycleIncompleteCount > 0 ||
    (preCatalystExitGuard && preCatalystExitGuard.summary && preCatalystExitGuard.summary.tickersToFreeze.length > 0) ||
    (positionShockMonitor && positionShockMonitor.summary && positionShockMonitor.summary.freezeOrWorse > 0)
  ) {
    healthStatus = "yellow";
  }

  return {
    dataFreshness: dataFreshness(inputs),
    healthStatus,
    lifecycleBlockers: lifecycleGuard && lifecycleGuard.lifecycle
      ? lifecycleGuard.lifecycle.positions.filter((row) => row.lifecycleStatus === "incomplete")
      : [],
    lifecycleGuard: {
      active: Boolean(lifecycleGuard),
      incompleteCount: lifecycleIncompleteCount
    },
    lifecycleIncompletePositions: lifecycleGuard && lifecycleGuard.lifecycle
      ? lifecycleGuard.lifecycle.positions.filter((row) => row.lifecycleStatus === "incomplete").map((row) => row.ticker)
      : [],
    modulesLoaded,
    modulesMissing,
    reasons: reasons.length ? reasons : ["pipeline consistente para revision"],
    safeToOperate: false,
    safeToReview: healthStatus !== "red"
  };
}

function capShockClassification(classification) {
  if (classification === "discard") {
    return "discard";
  }

  return "C research";
}

function combinedGuardFlags(exitGuardRow, shockRow) {
  const flags = [];

  if (exitGuardRow && EXIT_ACTIONS.has(exitGuardRow.suggestedAction)) {
    flags.push("preCatalystExitGuard");
  }

  if (shockRow && isFreezeOrWorse(shockRow)) {
    flags.push("positionShockMonitor", "thesisReviewRequired");
  }

  return flags;
}

function lifecycleRowsByTicker(lifecycleGuard) {
  return new Map(
    ((lifecycleGuard && lifecycleGuard.lifecycle && lifecycleGuard.lifecycle.positions) || [])
      .map((row) => [row.ticker, row])
  );
}

function isLifecycleIncomplete(row) {
  return Boolean(row && row.lifecycleStatus === "incomplete");
}

function isLifecycleThesisBroken(row) {
  return Boolean(
    row &&
      row.existingRiskFlags &&
      row.existingRiskFlags.thesisStatus === "thesis_broken"
  );
}

function applyGuardrails({
  catalyst,
  inputs,
  lifecycleGuard,
  positionShockMonitor,
  preCatalystExitGuard,
  selectorRanking,
  sizing,
  socialSignals,
  timing
}) {
  const timingByTicker = indexByTicker(timing.rows);
  const catalystMap = catalystByTicker(catalyst.rows);
  const exitGuardByTicker = new Map(
    ((preCatalystExitGuard && preCatalystExitGuard.rows) || []).map((row) => [row.ticker, row])
  );
  const shockByTicker = new Map(
    ((positionShockMonitor && positionShockMonitor.rows) || []).map((row) => [row.ticker, row])
  );
  const lifecycleByTicker = lifecycleRowsByTicker(lifecycleGuard);
  const conflicts = [];
  const correctedFalsePositives = [];
  const manualCandidateBlocklist = new Set();
  const redFlags = [];
  const biotechExposurePct = sizing.portfolio && sizing.portfolio.biotechCatalystExposurePct;

  const hardenedRanking = selectorRanking.map((row) => {
    const timingRow = timingByTicker.get(row.ticker);
    const catalystRow = catalystMap.get(row.ticker);
    const next = {
      ...row,
      pipelineAction: row.actionSuggested,
      pipelineClassification: row.classification,
      pipelineRedFlags: [...(row.redFlags || [])],
      guardFlags: [...(row.guardFlags || [])]
    };
    const socialScore = row.components && row.components.socialScore;
    const exitGuardRow = exitGuardByTicker.get(row.ticker);
    const shockRow = shockByTicker.get(row.ticker);
    const lifecycleRow = lifecycleByTicker.get(row.ticker);
    const strongShock = shockRow && isFreezeOrWorse(shockRow);
    const lifecycleIncomplete = isLifecycleIncomplete(lifecycleRow);
    const lifecycleThesisBroken = isLifecycleThesisBroken(lifecycleRow);

    if (lifecycleIncomplete) {
      next.lifecycleGuard = lifecycleRow;
      next.noAdd = true;
      next.requireManualReview = true;
      next.safeToOperate = false;
      next.pipelineAction = lifecycleThesisBroken ? "revisar_manual" : "revisar_manual";
      next.pipelineClassification = lifecycleThesisBroken ? "discard" : lowerClassification(next.pipelineClassification);
      next.pipelineRedFlags.push("lifecycle incomplete");
      next.guardFlags.push("lifecycleGuard");
      redFlags.push(`${row.ticker}: lifecycle incomplete`);
      conflicts.push(`${row.ticker}: posicion activa con lifecycle incompleto`);
      correctedFalsePositives.push(`${row.ticker}: bloqueado por lifecycle incomplete`);
    }

    if (lifecycleThesisBroken) {
      next.pipelineAction = "revisar_manual";
      next.pipelineClassification = "discard";
      next.pipelineRedFlags.push("thesis_broken/freeze lifecycle guard");
      next.guardFlags.push("thesisIntegrityEngine");
      redFlags.push(`${row.ticker}: thesis_broken/freeze requiere review manual o reduce_risk`);
      conflicts.push(`${row.ticker}: thesis_broken no puede tener clasificacion positiva`);
    }

    if (exitGuardRow && EXIT_ACTIONS.has(exitGuardRow.suggestedAction)) {
      next.pipelineAction = "reducir_riesgo_sugerido";
      next.pipelineClassification = lowerClassification(lowerClassification(next.pipelineClassification));
      next.pipelineRedFlags.push(`pre-catalyst exit guard: ${exitGuardRow.suggestedAction}`);
      redFlags.push(`${row.ticker}: ${exitGuardRow.suggestedAction} por ${exitGuardRow.binaryType} ${exitGuardRow.window}`);
      conflicts.push(`${row.ticker}: posicion activa con catalyst binario cercano requiere decision de salida/reduccion`);
      correctedFalsePositives.push(`${row.ticker}: mantener/B watch bloqueado por pre-catalyst exit guard`);
    }

    if (strongShock) {
      next.pipelineAction = "revisar_manual";
      next.pipelineClassification = capShockClassification(next.pipelineClassification);
      next.positionShockMonitor = {
        dayChangePct: shockRow.dayChangePct,
        noAdd: true,
        requireManualReview: true,
        requireNewsCheck: true,
        selectorOverride: shockRow.selectorOverride,
        shockSeverity: shockRow.shockSeverity,
        suggestedAction: shockRow.suggestedAction
      };
      next.pipelineRedFlags.push(`position shock monitor: ${shockRow.shockSeverity} day ${shockRow.dayChangePct}%`);
      redFlags.push(`${row.ticker}: ${shockRow.shockSeverity} por caida diaria ${shockRow.dayChangePct}%`);
      conflicts.push(`${row.ticker}: shock fuerte en posicion activa requiere news check y revision manual`);
      correctedFalsePositives.push(`${row.ticker}: classification positiva bloqueada por position shock monitor`);
    }

    combinedGuardFlags(exitGuardRow, shockRow).forEach((flag) => next.guardFlags.push(flag));

    if (!strongShock && /^A/.test(row.classification || "") && (!timingRow || timingRow.status !== "trigger_confirmed")) {
      next.pipelineAction = "candidato_manual";
      next.pipelineClassification = lowerClassification(next.pipelineClassification);
      next.pipelineRedFlags.push("selector A/A+ sin timing confirmado");
      conflicts.push(`${row.ticker}: selector ${row.classification} pero timing ${timingRow ? timingRow.status : "missing"}`);
      correctedFalsePositives.push(`${row.ticker}: A/A+ bloqueado hasta timing confirmado`);
    }

    if (!lifecycleIncomplete && row.classification === "discard" && ["candidato_manual", "revisar_manual"].includes(row.actionSuggested)) {
      next.pipelineAction = "descartar";
      next.pipelineClassification = "discard";
      next.pipelineRedFlags.push("discard aparecia como candidato");
      manualCandidateBlocklist.add(row.ticker);
      conflicts.push(`${row.ticker}: ticker discard aparecia como candidato`);
    }

    if (!strongShock && typeof socialScore === "number" && socialScore >= 7 && !hasClearCatalyst(row, catalystRow)) {
      if (next.pipelineClassification === "discard") {
        next.pipelineAction = "descartar";
        manualCandidateBlocklist.add(row.ticker);
        correctedFalsePositives.push(`${row.ticker}: social alto bloqueado por discard`);
      } else {
        next.pipelineAction = "revisar_manual";
        next.pipelineClassification = lowerClassification(next.pipelineClassification);
        if (next.pipelineClassification !== "C research") {
          next.pipelineClassification = "C research";
        }
        correctedFalsePositives.push(`${row.ticker}: social alto capado a research`);
      }
      next.pipelineRedFlags.push("social alto sin catalyst claro: max research");
      conflicts.push(`${row.ticker}: social alto sin catalyst verificable`);
    }

    if (lifecycleIncomplete && !lifecycleThesisBroken) {
      next.pipelineAction = "revisar_manual";
      next.pipelineClassification = "C research";
      manualCandidateBlocklist.delete(row.ticker);
    }

    next.guardFlags = [...new Set(next.guardFlags)];
    next.pipelineRedFlags = [...new Set(next.pipelineRedFlags)];
    return next;
  });

  const selectorByTicker = indexByTicker(hardenedRanking);
  const hardenedSizingRows = sizing.rows.map((row) => {
    const selectorRow = selectorByTicker.get(row.ticker);
    const timingRow = timingByTicker.get(row.ticker);
    const exitGuardRow = exitGuardByTicker.get(row.ticker);
    const shockRow = shockByTicker.get(row.ticker);
    const lifecycleRow = lifecycleByTicker.get(row.ticker);
    const strongShock = shockRow && isFreezeOrWorse(shockRow);
    const lifecycleIncomplete = isLifecycleIncomplete(lifecycleRow);
    const lifecycleThesisBroken = isLifecycleThesisBroken(lifecycleRow);
    const next = {
      ...row,
      guardFlags: [...(row.guardFlags || [])],
      redFlags: [...(row.redFlags || [])]
    };

    if (lifecycleIncomplete) {
      next.lifecycleGuard = lifecycleRow;
      next.maxNewPositionPct = 0;
      next.noAdd = true;
      next.requireManualReview = true;
      next.safeToOperate = false;
      next.sizingAction = lifecycleThesisBroken ? "reduce_risk" : "no_add";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push("lifecycle incomplete");
      next.guardFlags.push("lifecycleGuard");
      correctedFalsePositives.push(`${row.ticker}: sizing forzado a $0 por lifecycle incomplete`);
    }

    if (lifecycleThesisBroken) {
      next.sizingAction = "reduce_risk";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push("thesis_broken/freeze lifecycle guard");
      next.guardFlags.push("thesisIntegrityEngine");
    }

    if (exitGuardRow && EXIT_ACTIONS.has(exitGuardRow.suggestedAction)) {
      next.maxNewPositionPct = 0;
      next.sizingAction = "reduce_risk";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push(`pre-catalyst exit guard: ${exitGuardRow.suggestedAction}`);
      correctedFalsePositives.push(`${row.ticker}: sizing forzado a reduce_risk por catalyst binario cercano`);
    }

    if (strongShock) {
      next.maxNewPositionPct = 0;
      next.noAdd = true;
      next.positionShockMonitor = {
        dayChangePct: shockRow.dayChangePct,
        requireManualReview: true,
        requireNewsCheck: true,
        shockSeverity: shockRow.shockSeverity,
        suggestedAction: shockRow.suggestedAction
      };
      next.sizingAction = "reduce_risk";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push(`position shock monitor: ${shockRow.shockSeverity}`);
      correctedFalsePositives.push(`${row.ticker}: sizing forzado a $0 por shock fuerte`);
    }

    combinedGuardFlags(exitGuardRow, shockRow).forEach((flag) => next.guardFlags.push(flag));

    if (!strongShock && row.suggestedSizeUSD > 0 && (!timingRow || timingRow.status !== "trigger_confirmed")) {
      next.maxNewPositionPct = 0;
      next.sizingAction = "no_add";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push("guardrail: sizing >0 sin timing confirmado");
      conflicts.push(`${row.ticker}: sizing >0 pero timing no confirmado`);
      correctedFalsePositives.push(`${row.ticker}: sizing forzado a $0 por timing`);
    }

    if (!strongShock && selectorRow && selectorRow.pipelineClassification === "discard" && row.suggestedSizeUSD > 0) {
      next.maxNewPositionPct = 0;
      next.sizingAction = "no_add";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push("guardrail: discard no puede tener sizing positivo");
      conflicts.push(`${row.ticker}: discard tenia sizing positivo`);
      manualCandidateBlocklist.add(row.ticker);
    }

    if (!strongShock && biotechExposurePct !== null && biotechExposurePct > 65 && row.suggestedSizeUSD > 0) {
      next.maxNewPositionPct = 0;
      next.sizingAction = "no_add";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push("guardrail: exposicion catalyst >65%");
      redFlags.push("exposicion catalyst >65%: nuevas compras penalizadas");
      correctedFalsePositives.push(`${row.ticker}: sizing bloqueado por exposicion catalyst >65%`);
    }

    if (!strongShock && row.currentPositionPct !== null && row.currentPositionPct > 30) {
      next.maxNewPositionPct = 0;
      next.sizingAction = "no_add";
      next.suggestedShares = 0;
      next.suggestedSizeUSD = 0;
      next.redFlags.push("guardrail: posicion individual >30% cartera");
      redFlags.push(`${row.ticker}: posicion individual >30% cartera`);
    }

    next.guardFlags = [...new Set(next.guardFlags)];
    next.redFlags = [...new Set(next.redFlags)];
    return next;
  });

  return {
    conflicts: [...new Set(conflicts)],
    correctedFalsePositives: [...new Set(correctedFalsePositives)],
    manualCandidateBlocklist,
    redFlags: [...new Set(redFlags)],
    selectorRanking: hardenedRanking,
    sizing: {
      ...sizing,
      rows: hardenedSizingRows,
      summary: {
        ...sizing.summary,
        addsSuggested: hardenedSizingRows.filter((row) => row.suggestedSizeUSD > 0).length,
        guardrailCorrections: correctedFalsePositives.length,
        reduceRiskSuggested: hardenedSizingRows.filter((row) => row.sizingAction === "reduce_risk").length
      }
    }
  };
}

function determineDecision({ guardrails, inputs, selectorRanking, sizingRows, timingRows }) {
  const timingByTicker = indexByTicker(timingRows);
  const operables = selectorRanking.filter((row) =>
    row.pipelineClassification &&
    row.pipelineClassification.startsWith("A+") &&
    timingByTicker.get(row.ticker) &&
    timingByTicker.get(row.ticker).status === "trigger_confirmed"
  );
  const manualCandidates = new Set();
  const riskReview = new Set();
  const blocklist = guardrails ? guardrails.manualCandidateBlocklist : new Set();

  ((inputs.dailyCockpit && inputs.dailyCockpit.router && inputs.dailyCockpit.router.manualCandidates) || [])
    .forEach((ticker) => manualCandidates.add(ticker));

  selectorRanking
    .filter((row) => ["candidato_manual", "revisar_manual"].includes(row.pipelineAction))
    .forEach((row) => manualCandidates.add(row.ticker));

  selectorRanking
    .filter((row) =>
      (row.guardFlags || []).includes("lifecycleGuard") ||
      (row.guardFlags || []).includes("thesisIntegrityEngine") ||
      (row.pipelineRedFlags || []).some((flag) => /lifecycle|thesis_broken|freeze/.test(flag))
    )
    .forEach((row) => riskReview.add(row.ticker));

  sizingRows
    .filter((row) => row.sizingAction === "reduce_risk")
    .forEach((row) => {
      manualCandidates.add(row.ticker);
      riskReview.add(row.ticker);
    });

  selectorRanking
    .filter((row) => row.pipelineClassification === "discard")
    .forEach((row) => blocklist.add(row.ticker));

  const missingToAct = [];
  if (operables.length === 0) {
    missingToAct.push("trigger confirmado A+");
  }
  if (timingRows.every((row) => row.status !== "trigger_confirmed")) {
    missingToAct.push("timing confirmado por RelVol y dollarVolume");
  }

  let finalAction = operables.length > 0 ? "candidato_manual" : "no_operar";
  let finalDecision = operables.length > 0
    ? "revisar manualmente operables; pipeline no opera ni ejecuta."
    : "no_operar; mantener cartera y vigilar candidatos hasta trigger completo.";

  if (guardrails && guardrails.conflicts.length > 0) {
    finalAction = "no_operar";
    finalDecision = "no_operar; hay conflictos entre modulos y se requiere revision manual.";
  }

  if (!ALLOWED_ACTIONS.has(finalAction)) {
    finalAction = "no_operar";
    finalDecision = "no_operar; guardrail forzo accion permitida.";
  }

  return {
    decisionFinal: finalAction,
    finalAction,
    finalDecision,
    manualCandidates: [...manualCandidates].filter((ticker) => !blocklist.has(ticker)).sort(),
    missingToAct: [...new Set(missingToAct)],
    operables: operables.map((row) => row.ticker),
    riskReview: [...riskReview].sort()
  };
}

function renderTable(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];

  rows.forEach((row) => {
    lines.push(`| ${row.join(" | ")} |`);
  });

  return lines.join("\n");
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY 7 Pillars Pipeline Dashboard");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: read-only / research-only. No opera, no usa IBKR, no usa Binance, no envia ordenes.");
  lines.push("");
  lines.push("## Estado WALY del dia");
  lines.push(`- Health: ${payload.healthStatus}`);
  lines.push(`- Safe to review: ${payload.safeToReview ? "true" : "false"}`);
  lines.push(`- Safe to operate: ${payload.safeToOperate ? "true" : "false"}`);
  lines.push(`- Razones: ${payload.health.reasons.join("; ")}`);
  lines.push("");
  lines.push("## Decision final");
  lines.push(`- decisionFinal: ${payload.decisionFinal}`);
  lines.push(`- Accion: ${payload.decision.finalAction}`);
  lines.push(`- Decision: ${payload.decision.finalDecision}`);
  lines.push(`- Falta para accionar: ${payload.decision.missingToAct.join("; ") || "nada"}`);
  lines.push("");
  lines.push("## Operables");
  lines.push(payload.decision.operables.length ? `- ${payload.decision.operables.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## Manual candidates");
  lines.push(payload.decision.manualCandidates.length ? `- ${payload.decision.manualCandidates.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## Risk review");
  lines.push(payload.decision.riskReview && payload.decision.riskReview.length ? `- ${payload.decision.riskReview.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## Lifecycle Guard");
  lines.push(`- Active: ${payload.lifecycleGuard ? "true" : "false"}`);
  lines.push(`- Incomplete positions: ${payload.lifecycleIncompletePositions.length ? payload.lifecycleIncompletePositions.map((row) => row.ticker).join(", ") : "ninguna"}`);
  if (payload.lifecycleIncompletePositions.length) {
    payload.lifecycleIncompletePositions.forEach((row) => {
      const riskText = row.existingRiskFlags && row.existingRiskFlags.thesisStatus === "thesis_broken"
        ? " | thesis_broken/freeze"
        : "";
      lines.push(`- ${row.ticker}: ${row.lifecycleStatus}${riskText} | missing ${row.missingLifecycleFields.join(", ")}`);
    });
  }
  lines.push("");
  lines.push("## Ranking final");
  lines.push(renderTable(
    ["Ticker", "Score", "Clasificacion", "Pipeline", "Accion", "Red flags"],
    payload.selectorRanking.slice(0, 8).map((row) => [
      row.ticker,
      fmt(row.totalScore, 1),
      row.classification,
      row.pipelineClassification || row.classification,
      row.pipelineAction || row.actionSuggested,
      (row.pipelineRedFlags || row.redFlags || []).join("; ") || "ninguna"
    ])
  ));
  lines.push("");
  lines.push("## Cartera actual");
  lines.push(renderTable(
    ["Ticker", "Qty", "Avg", "Last", "Accion"],
    payload.portfolio.map((row) => [row.ticker, row.quantity, fmt(row.avgPrice, 2), fmt(row.lastPrice, 2), row.action])
  ));
  lines.push("");
  lines.push("## Shock Events");
  if (!payload.shockEvents || !payload.shockEvents.length) {
    lines.push("- Sin position shocks activos.");
  } else {
    payload.shockEvents.forEach((row) => {
      lines.push(`- ${row.ticker}: ${row.shockSeverity} | day ${row.dayChangePct}% | relVol ${fmt(row.relVol, 3)} | action ${row.suggestedAction} | noAdd=${row.noAdd}`);
    });
  }
  lines.push("");
  lines.push("## Pre-Catalyst Exit Guard");
  if (!payload.preCatalystExitGuard || !payload.preCatalystExitGuard.rows.length) {
    lines.push("- Sin posiciones activas evaluadas.");
  } else {
    payload.preCatalystExitGuard.rows.forEach((row) => {
      lines.push(`- ${row.ticker}: ${row.suggestedAction} | ${row.binaryType} | ${row.window} | days ${row.daysToCatalyst === null ? "n/d" : row.daysToCatalyst}`);
    });
  }
  lines.push("");
  lines.push("## Catalyst engine");
  lines.push(renderTable(
    ["Ticker", "Tipo", "Fecha", "Dias", "Riesgo", "Score", "Falta"],
    payload.catalyst.rows.map((row) => [
      row.ticker,
      row.catalystType,
      row.catalystDate || "n/d",
      row.daysToCatalyst === null ? "n/d" : row.daysToCatalyst,
      row.binaryRisk,
      fmt(row.catalystScore, 1),
      row.missingData.join("; ") || "ninguna"
    ])
  ));
  lines.push("");
  lines.push("## Timing engine");
  lines.push(renderTable(
    ["Ticker", "RelVol", "$Vol", "DayMove", "Status", "Score", "Flags"],
    payload.timing.rows.map((row) => [
      row.ticker,
      fmt(row.relativeVolume, 3),
      row.dollarVolume === null ? "n/d" : `$${Math.round(row.dollarVolume).toLocaleString("en-US")}`,
      fmt(row.dayMove, 2),
      row.status,
      fmt(row.timingScore, 1),
      row.redFlags.join("; ") || "ninguna"
    ])
  ));
  lines.push("");
  lines.push("## Sizing engine");
  lines.push(renderTable(
    ["Ticker", "Action", "Max %", "USD", "Shares", "Flags"],
    payload.sizing.rows.map((row) => [
      row.ticker,
      row.sizingAction,
      fmt(row.maxNewPositionPct, 1),
      `$${row.suggestedSizeUSD}`,
      row.suggestedShares,
      row.redFlags.join("; ") || "ninguna"
    ])
  ));
  lines.push("");
  lines.push("## Social signals");
  if (payload.socialSignals.length === 0) {
    lines.push("- Sin senales sociales accionables.");
  } else {
    payload.socialSignals.forEach((row) => {
      lines.push(`- ${row.ticker}: ${row.action} | score ${fmt(row.score, 1)} | ${row.source}`);
    });
  }
  lines.push("");
  lines.push("## Riesgo agregado");
  lines.push(`- Exposicion total: ${fmt(payload.sizing.portfolio.exposureTotalPct, 2)}%`);
  lines.push(`- Exposicion biotech/catalyst: ${fmt(payload.sizing.portfolio.biotechCatalystExposurePct, 2)}%`);
  lines.push(`- Cash estimado: $${payload.sizing.portfolio.cash}`);
  lines.push(`- Red flags: ${payload.redFlags.join("; ") || "ninguna"}`);
  lines.push("");
  lines.push("## Missing data");
  lines.push(payload.missingData.length ? payload.missingData.map((item) => `- ${item}`).join("\n") : "- Ninguna.");
  lines.push("");
  lines.push("## Conflictos detectados");
  lines.push(payload.conflicts.length ? payload.conflicts.map((item) => `- ${item}`).join("\n") : "- Ninguno.");
  lines.push("");
  lines.push("## Proxima accion sugerida");
  lines.push(`- ${payload.decision.finalDecision}`);
  lines.push(`- Correcciones guardrail: ${payload.correctedFalsePositives.join("; ") || "ninguna"}`);
  lines.push("");
  lines.push("## Confirmacion: no operacion / no IBKR / no Binance");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function buildPipelinePayload(options = {}) {
  const mode = resolveRuntimeMode(options);
  const rawInputs = options.inputs || readCoreInputs();
  const inputs = mode === "production" ? filterProductionInputs(rawInputs) : rawInputs;
  const signalLog = buildSignalLogPayload({ inputs }).payload;
  const catalyst = buildCatalystPayload({ inputs }).payload;
  const timing = buildTimingPayload({ inputs }).payload;
  const sizing = buildSizingPayload({ inputs, timingPayload: timing }).payload;
  const trainTest = buildTrainTestPayload({ inputs }).payload;
  const postMortem = buildPostMortemPayload({
    catalystPayload: catalyst,
    inputs,
    signalLogPayload: signalLog,
    sizingPayload: sizing,
    timingPayload: timing
  }).payload;
  const preCatalystExitGuard = buildPreCatalystExitGuardPayload({ inputs }).payload;
  const positionShockMonitor = buildPositionShockPayload({
    dailyRun: null,
    inputs,
    pipelineLatest: null
  }).payload;
  const lifecycleGuard = buildLifecycleGuardPayload({ inputs });
  const rawSelectorRanking = (inputs.selectorEngine && inputs.selectorEngine.ranking) || [];
  const socialSignals = socialRows(inputs);
  const guardrails = applyGuardrails({
    catalyst,
    inputs,
    lifecycleGuard,
    positionShockMonitor,
    preCatalystExitGuard,
    selectorRanking: rawSelectorRanking,
    sizing,
    socialSignals,
    timing
  });
  const selectorRanking = guardrails.selectorRanking;
  const guardedSizing = guardrails.sizing;
  const redFlags = [
    ...selectorRanking.flatMap((row) => row.redFlags || []),
    ...selectorRanking.flatMap((row) => row.pipelineRedFlags || []),
    ...catalyst.rows.filter((row) => row.binaryRisk === "high").map((row) => `${row.ticker}: binaryRisk high`),
    ...timing.rows.flatMap((row) => row.redFlags.map((flag) => `${row.ticker}: ${flag}`)),
    ...guardedSizing.rows.flatMap((row) => row.redFlags.map((flag) => `${row.ticker}: ${flag}`)),
    ...preCatalystExitGuard.rows
      .filter((row) => EXIT_ACTIONS.has(row.suggestedAction))
      .map((row) => `${row.ticker}: ${row.suggestedAction}`),
    ...positionShockMonitor.shockEvents.map((row) => `${row.ticker}: ${row.shockSeverity}`),
    ...guardrails.redFlags
  ];
  const decision = determineDecision({
    guardrails,
    inputs,
    selectorRanking,
    sizingRows: guardedSizing.rows,
    timingRows: timing.rows
  });
  const prohibitedActionHits = findProhibitedActionHits({
    decision,
    selectorRanking,
    sizingRows: guardedSizing.rows,
    socialSignals
  });
  if (prohibitedActionHits.length > 0) {
    decision.decisionFinal = "no_operar";
    decision.finalAction = "no_operar";
    decision.finalDecision = "no_operar; accion prohibida detectada por guardrail.";
    redFlags.push("accion prohibida detectada: decision forzada no_operar");
  }
  const uniqueRedFlags = [...new Set(redFlags)];
  const missingData = collectMissingData({
    catalyst,
    selectorRanking,
    sizing: guardedSizing,
    timing
  });
  const health = buildHealth({
    conflicts: guardrails.conflicts,
    inputs,
    lifecycleGuard,
    missingData,
    positionShockMonitor,
    preCatalystExitGuard,
    prohibitedActionHits,
    redFlags: uniqueRedFlags
  });
  const payload = {
    allowedActions: [...ALLOWED_ACTIONS],
    catalyst,
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No toca outcomes reales.",
      "No modifica positions manualmente.",
      "No modifica data/social_signals.json.",
      "No commit.",
      "No push.",
      "Output solo en backtests/7-pillars/."
    ],
    conflicts: guardrails.conflicts,
    correctedFalsePositives: guardrails.correctedFalsePositives,
    decision,
    decisionFinal: decision.finalAction,
    generatedAt: new Date().toISOString(),
    health,
    healthStatus: health.healthStatus,
    lifecycleGuard,
    lifecycleIncompletePositions: lifecycleGuard.lifecycle.positions.filter((row) => row.lifecycleStatus === "incomplete"),
    lifecycleRequiredRules: lifecycleGuard.requiredSystemRules,
    missingData,
    mode,
    pipelineMode: "read-only-research",
    portfolio: portfolioRows(inputs),
    positionShockMonitor,
    preCatalystExitGuard,
    postMortem,
    prohibitedActionHits,
    redFlags: uniqueRedFlags,
    safeToOperate: false,
    safeToReview: health.safeToReview,
    selectorRanking,
    shockEvents: positionShockMonitor.shockEvents,
    signalLog,
    sizing: guardedSizing,
    socialSignals,
    timing,
    trainTest
  };

  return {
    inputs,
    payload
  };
}

function writePipelineOutputs(payload) {
  writePillarJson("real-signal-log.json", payload.signalLog);
  writePillarJson("catalyst-engine.json", payload.catalyst);
  writePillarJson("timing-engine.json", payload.timing);
  writePillarJson("sizing-engine.json", payload.sizing);
  writePillarJson("train-test-engine.json", payload.trainTest);
  writePillarJson("post-mortem-engine.json", payload.postMortem);
  const preCatalystExitGuardPaths = writePreCatalystExitGuardOutputs(payload.preCatalystExitGuard);
  const positionShockMonitorPaths = writePositionShockOutputs(payload.positionShockMonitor);
  const latestPath = writePillarJson(path.basename(PIPELINE_LATEST_PATH), payload);
  const summaryPath = writePillarText("summary.md", renderSummary(payload));

  return {
    latestPath,
    positionShockMonitorPaths,
    preCatalystExitGuardPaths,
    summaryPath
  };
}

function renderConsoleReport(payload) {
  const top = payload.selectorRanking.slice(0, 5).map((row) => `${row.ticker}:${fmt(row.totalScore, 1)}:${row.pipelineClassification || row.classification}`);
  const shocks = (payload.shockEvents || []).map((row) => `${row.ticker}:${row.shockSeverity}`);

  return [
    "WALY 7 Pillars Pipeline generado.",
    `Mode: ${payload.mode}`,
    `Health: ${payload.healthStatus} | safeToReview=${payload.safeToReview} | safeToOperate=false`,
    `Ranking: ${top.join(" | ") || "missingData"}`,
    `Operables: ${payload.decision.operables.join(", ") || "ninguno"}`,
    `Manual candidates: ${payload.decision.manualCandidates.join(", ") || "ninguno"}`,
    `Risk review: ${(payload.decision.riskReview || []).join(", ") || "ninguno"}`,
    `Lifecycle incomplete: ${(payload.lifecycleIncompletePositions || []).map((row) => row.ticker).join(", ") || "ninguno"}`,
    `Exit guard: ${payload.preCatalystExitGuard.summary.tickersToFreeze.join(", ") || "ninguno"}`,
    `Shock events: ${shocks.join(", ") || "ninguno"}`,
    `Conflictos: ${payload.conflicts.join(" | ") || "ninguno"}`,
    `Decision: ${payload.decisionFinal} | ${payload.decision.finalDecision}`,
    `summary.md: ${formatRelative(path.join(OUTPUT_DIR, "summary.md"))}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no commit, no push."
  ].join("\n");
}

function renderHealthConsoleReport(payload) {
  const decisionFinal = payload.decisionFinal || payload.decision && payload.decision.finalAction || "missingData";
  const operables = payload.decision && payload.decision.operables || [];
  const manualCandidates = payload.decision && payload.decision.manualCandidates || [];
  const riskReview = payload.decision && payload.decision.riskReview || [];
  const guardTickers =
    payload.preCatalystExitGuard &&
    payload.preCatalystExitGuard.summary &&
    payload.preCatalystExitGuard.summary.tickersToFreeze ||
    [];
  const shockEvents = payload.shockEvents || payload.positionShockMonitor && payload.positionShockMonitor.shockEvents || [];

  return [
    "WALY Health Check.",
    `mode: ${payload.mode || "production"}`,
    `healthStatus: ${payload.healthStatus || "missingData"}`,
    `decisionFinal: ${decisionFinal}`,
    `operables: ${operables.join(", ") || "ninguno"}`,
    `manualCandidates: ${manualCandidates.join(", ") || "ninguno"}`,
    `riskReview: ${riskReview.join(", ") || "ninguno"}`,
    `lifecycleGuard: ${payload.lifecycleGuard ? "active" : "inactive"}`,
    `lifecycleIncompletePositions: ${(payload.lifecycleIncompletePositions || []).map((row) => row.ticker).join(", ") || "ninguna"}`,
    `lifecycleBlockers: ${payload.health && payload.health.lifecycleBlockers ? payload.health.lifecycleBlockers.map((row) => `${row.ticker}:${row.missingLifecycleFields.length}`).join(" | ") || "ninguno" : "n/d"}`,
    `preCatalystExitGuard: ${guardTickers.join(", ") || "ninguno"}`,
    `shockEvents: ${shockEvents.map((row) => `${row.ticker}:${row.shockSeverity}`).join(", ") || "ninguno"}`,
    `missingData: ${(payload.missingData || []).join(" | ") || "ninguna"}`,
    `conflicts: ${(payload.conflicts || []).join(" | ") || "ninguno"}`,
    `safeToReview: ${payload.safeToReview ? "true" : "false"}`,
    "safeToOperate: false"
  ].join("\n");
}

function runWalyPipeline(options = {}) {
  const { inputs, payload } = buildPipelinePayload(options);
  let paths = {
    latestPath: null,
    summaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = writePipelineOutputs(payload);
  }

  return {
    ...payload,
    inputsRaw: inputs,
    paths,
    consoleReport: renderConsoleReport(payload),
    summaryMarkdown: renderSummary(payload)
  };
}

function runWalyHealth(options = {}) {
  const mode = resolveRuntimeMode(options);
  let payload = null;

  if (mode === "production") {
    payload = buildPipelinePayload({ ...options, mode }).payload;
  } else {
    try {
      payload = JSON.parse(fs.readFileSync(PIPELINE_LATEST_PATH, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        payload = {
          conflicts: ["waly-pipeline-latest.json missing"],
          decision: {
            finalAction: "no_operar",
            manualCandidates: [],
            operables: []
          },
          decisionFinal: "no_operar",
          healthStatus: "red",
          missingData: ["backtests/7-pillars/waly-pipeline-latest.json"],
          mode,
          safeToOperate: false,
          safeToReview: false
        };
      } else {
        throw error;
      }
    }
  }

  return {
    ...payload,
    consoleReport: renderHealthConsoleReport(payload)
  };
}

module.exports = {
  buildPipelinePayload,
  runWalyHealth,
  runWalyPipeline
};
