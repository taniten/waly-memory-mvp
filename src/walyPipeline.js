"use strict";

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

function determineDecision({ inputs, selectorRanking, sizingRows, timingRows }) {
  const timingByTicker = indexByTicker(timingRows);
  const operables = selectorRanking.filter((row) =>
    row.classification &&
    row.classification.startsWith("A+") &&
    timingByTicker.get(row.ticker) &&
    timingByTicker.get(row.ticker).status === "trigger_confirmed"
  );
  const manualCandidates = new Set();

  ((inputs.dailyCockpit && inputs.dailyCockpit.router && inputs.dailyCockpit.router.manualCandidates) || [])
    .forEach((ticker) => manualCandidates.add(ticker));

  selectorRanking
    .filter((row) => ["candidato_manual", "revisar_manual"].includes(row.actionSuggested))
    .forEach((row) => manualCandidates.add(row.ticker));

  sizingRows
    .filter((row) => row.sizingAction === "reduce_risk")
    .forEach((row) => manualCandidates.add(row.ticker));

  const missingToAct = [];
  if (operables.length === 0) {
    missingToAct.push("trigger confirmado A+");
  }
  if (timingRows.every((row) => row.status !== "trigger_confirmed")) {
    missingToAct.push("timing confirmado por RelVol y dollarVolume");
  }

  const finalAction = operables.length > 0 ? "candidato_manual" : "no_operar";
  if (!ALLOWED_ACTIONS.has(finalAction)) {
    throw new Error(`Accion WALY no permitida: ${finalAction}`);
  }

  return {
    finalAction,
    finalDecision: operables.length > 0
      ? "revisar manualmente operables; pipeline no opera ni ejecuta."
      : "no_operar; mantener cartera y vigilar candidatos hasta trigger completo.",
    manualCandidates: [...manualCandidates].sort(),
    missingToAct: [...new Set(missingToAct)],
    operables: operables.map((row) => row.ticker)
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
  lines.push("## 1. Estado de cartera");
  lines.push(renderTable(
    ["Ticker", "Qty", "Avg", "Last", "Accion"],
    payload.portfolio.map((row) => [row.ticker, row.quantity, fmt(row.avgPrice, 2), fmt(row.lastPrice, 2), row.action])
  ));
  lines.push("");
  lines.push("## 2. Ranking selector");
  lines.push(renderTable(
    ["Ticker", "Score", "Clasificacion", "Accion", "Red flags"],
    payload.selectorRanking.slice(0, 8).map((row) => [
      row.ticker,
      fmt(row.totalScore, 1),
      row.classification,
      row.actionSuggested,
      (row.redFlags || []).join("; ") || "ninguna"
    ])
  ));
  lines.push("");
  lines.push("## 3. Catalyst por ticker");
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
  lines.push("## 4. Timing por ticker");
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
  lines.push("## 5. Sizing sugerido");
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
  lines.push("## 6. Senales sociales");
  if (payload.socialSignals.length === 0) {
    lines.push("- Sin senales sociales accionables.");
  } else {
    payload.socialSignals.forEach((row) => {
      lines.push(`- ${row.ticker}: ${row.action} | score ${fmt(row.score, 1)} | ${row.source}`);
    });
  }
  lines.push("");
  lines.push("## 7. Riesgo agregado");
  lines.push(`- Exposicion total: ${fmt(payload.sizing.portfolio.exposureTotalPct, 2)}%`);
  lines.push(`- Exposicion biotech/catalyst: ${fmt(payload.sizing.portfolio.biotechCatalystExposurePct, 2)}%`);
  lines.push(`- Cash estimado: $${payload.sizing.portfolio.cash}`);
  lines.push(`- Red flags: ${payload.redFlags.join("; ") || "ninguna"}`);
  lines.push("");
  lines.push("## 8. Operables del dia");
  lines.push(payload.decision.operables.length ? `- ${payload.decision.operables.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## 9. Manual candidates");
  lines.push(payload.decision.manualCandidates.length ? `- ${payload.decision.manualCandidates.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## 10. Decision WALY final");
  lines.push(`- Accion: ${payload.decision.finalAction}`);
  lines.push(`- Decision: ${payload.decision.finalDecision}`);
  lines.push(`- Falta para accionar: ${payload.decision.missingToAct.join("; ") || "nada"}`);
  lines.push("");
  lines.push("## Confirmaciones");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function buildPipelinePayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
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
  const selectorRanking = (inputs.selectorEngine && inputs.selectorEngine.ranking) || [];
  const redFlags = [
    ...selectorRanking.flatMap((row) => row.redFlags || []),
    ...catalyst.rows.filter((row) => row.binaryRisk === "high").map((row) => `${row.ticker}: binaryRisk high`),
    ...timing.rows.flatMap((row) => row.redFlags.map((flag) => `${row.ticker}: ${flag}`)),
    ...sizing.rows.flatMap((row) => row.redFlags.map((flag) => `${row.ticker}: ${flag}`))
  ];
  const decision = determineDecision({
    inputs,
    selectorRanking,
    sizingRows: sizing.rows,
    timingRows: timing.rows
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
    decision,
    generatedAt: new Date().toISOString(),
    mode: "read-only-research",
    portfolio: portfolioRows(inputs),
    postMortem,
    redFlags: [...new Set(redFlags)],
    selectorRanking,
    signalLog,
    sizing,
    socialSignals: socialRows(inputs),
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
  const latestPath = writePillarJson("waly-pipeline-latest.json", payload);
  const summaryPath = writePillarText("summary.md", renderSummary(payload));

  return {
    latestPath,
    summaryPath
  };
}

function renderConsoleReport(payload) {
  const top = payload.selectorRanking.slice(0, 5).map((row) => `${row.ticker}:${fmt(row.totalScore, 1)}:${row.classification}`);

  return [
    "WALY 7 Pillars Pipeline generado.",
    `Ranking: ${top.join(" | ") || "missingData"}`,
    `Operables: ${payload.decision.operables.join(", ") || "ninguno"}`,
    `Manual candidates: ${payload.decision.manualCandidates.join(", ") || "ninguno"}`,
    `Decision: ${payload.decision.finalAction} | ${payload.decision.finalDecision}`,
    `summary.md: ${formatRelative(path.join(OUTPUT_DIR, "summary.md"))}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no commit, no push."
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

module.exports = {
  buildPipelinePayload,
  runWalyPipeline
};
