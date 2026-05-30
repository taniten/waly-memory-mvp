"use strict";

const fs = require("fs");
const path = require("path");
const { runDailyCockpit } = require("./dailyCockpit");
const { runForwardSnapshotLog } = require("./forwardSnapshotLogger");
const { runSelectorEngine } = require("./selectorEngine");
const { BACKTESTS_DIR } = require("./storage");
const { runWalyHealth, runWalyPipeline } = require("./walyPipeline");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "daily-run");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");

function assertDailyRunOutput(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("waly-daily solo puede escribir dentro de backtests/daily-run/.");
  }
}

function writeJson(filePath, value) {
  assertDailyRunOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  assertDailyRunOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function formatNumber(value) {
  return typeof value === "number" ? value.toFixed(1) : "n/d";
}

function renderRanking(ranking) {
  if (!Array.isArray(ranking) || ranking.length === 0) {
    return "- Ninguno.";
  }

  return ranking.slice(0, 5).map((row, index) =>
    `${index + 1}. ${row.ticker}: ${row.classification || "n/d"} | score ${formatNumber(row.selectorScore)} | ${row.actionSuggested || "n/d"} | price ${row.price === null ? "n/d" : row.price}`
  ).join("\n");
}

function renderPortfolio(portfolio) {
  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    return "- Cartera vacia.";
  }

  return portfolio.map((row) =>
    `- ${row.ticker}: qty ${row.quantity} | avg ${row.avgPrice} | last ${row.lastPrice} | accion ${row.action}`
  ).join("\n");
}

function renderShockEvents(shockEvents) {
  if (!Array.isArray(shockEvents) || shockEvents.length === 0) {
    return "- Sin position shocks activos.";
  }

  return shockEvents.map((row) =>
    `- ${row.ticker}: ${row.shockSeverity} | day ${row.dayChangePct}% | relVol ${row.relVol === null ? "n/d" : row.relVol} | accion ${row.suggestedAction} | noAdd=${row.noAdd ? "true" : "false"}`
  ).join("\n");
}

function renderSummary(result) {
  const lines = [];

  lines.push("# WALY Daily Run");
  lines.push("");
  lines.push(`Fecha/hora: ${result.createdAt}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push(`decisionFinal: ${result.decisionFinal}`);
  lines.push(`healthStatus: ${result.healthStatus}`);
  lines.push(`safeToReview: ${result.safeToReview ? "true" : "false"}`);
  lines.push("safeToOperate: false");
  lines.push("");
  lines.push("## Operables");
  lines.push(result.operables.length ? `- ${result.operables.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## Manual candidates");
  lines.push(result.manualCandidates.length ? `- ${result.manualCandidates.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## Ranking top 5");
  lines.push(renderRanking(result.ranking));
  lines.push("");
  lines.push("## Cartera actual");
  lines.push(renderPortfolio(result.portfolio));
  lines.push("");
  lines.push("## Shock Events");
  lines.push(renderShockEvents(result.shockEvents));
  lines.push("");
  lines.push("## Pre-Catalyst Exit Guard");
  if (!result.preCatalystExitGuard || !result.preCatalystExitGuard.rows.length) {
    lines.push("- Sin posiciones activas evaluadas.");
  } else {
    result.preCatalystExitGuard.rows.forEach((row) => {
      lines.push(`- ${row.ticker}: ${row.suggestedAction} | ${row.binaryType} | ${row.window} | days ${row.daysToCatalyst === null ? "n/d" : row.daysToCatalyst}`);
    });
  }
  lines.push("");
  lines.push("## Forward snapshot");
  lines.push(`- snapshotId: ${result.forwardSnapshot.snapshotId}`);
  lines.push(`- status: ${result.forwardSnapshot.status}`);
  lines.push(`- reason: ${result.forwardSnapshot.reason}`);
  lines.push("");
  lines.push("## Confirmaciones");
  result.confirmations.forEach((confirmation) => lines.push(`- ${confirmation}`));

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  const top = result.ranking.slice(0, 5).map((row) =>
    `${row.ticker}:${formatNumber(row.selectorScore)}:${row.classification || "n/d"}`
  );
  const shocks = (result.shockEvents || []).map((row) => `${row.ticker}:${row.shockSeverity}:${row.suggestedAction}`);

  return [
    "WALY Daily Run generado.",
    `Mode: ${result.mode}`,
    `decisionFinal: ${result.decisionFinal}`,
    `healthStatus: ${result.healthStatus}`,
    `operables: ${result.operables.join(", ") || "ninguno"}`,
    `manualCandidates: ${result.manualCandidates.join(", ") || "ninguno"}`,
    `shockEvents: ${shocks.join(" | ") || "ninguno"}`,
    `preCatalystExitGuard: ${result.preCatalystExitGuard.summary.tickersToFreeze.join(", ") || "ninguno"}`,
    `ranking top 5: ${top.join(" | ") || "ninguno"}`,
    `forwardSnapshot: ${result.forwardSnapshot.status} | ${result.forwardSnapshot.snapshotId}`,
    `safeToReview: ${result.safeToReview ? "true" : "false"}`,
    "safeToOperate: false",
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no ordenes, no commit, no push."
  ].join("\n");
}

async function runWalyDaily() {
  const mode = "production";
  const createdAt = new Date().toISOString();
  const dailyCockpit = await runDailyCockpit();
  const selector = runSelectorEngine();
  const pipeline = runWalyPipeline({ mode });
  const health = runWalyHealth({ mode });
  const forwardSnapshot = runForwardSnapshotLog();
  const latestSnapshot = forwardSnapshot.latestSnapshot;
  const decision = pipeline.decision || {};
  const result = {
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No modifica outcomes.",
      "No modifica data/social_signals.json.",
      "No commit.",
      "No push.",
      "Output propio solo en backtests/daily-run/."
    ],
    createdAt,
    decisionFinal: pipeline.decisionFinal || decision.finalAction || "missingData",
    forwardSnapshot: {
      reason: forwardSnapshot.writeDecision.reason,
      snapshotId: latestSnapshot.snapshotId,
      status: forwardSnapshot.snapshotAppended ? "generated" : "omitted_duplicate"
    },
    healthStatus: health.healthStatus || pipeline.healthStatus || "missingData",
    manualCandidates: decision.manualCandidates || [],
    mode,
    moduleOutputs: {
      dailyCockpit: dailyCockpit.paths,
      forwardSnapshot: forwardSnapshot.paths,
      positionShockMonitor: pipeline.paths.positionShockMonitorPaths || null,
      preCatalystExitGuard: pipeline.paths.preCatalystExitGuardPaths || null,
      selector: selector.paths,
      walyPipeline: pipeline.paths
    },
    operables: decision.operables || [],
    paths: {
      latestPath: LATEST_PATH,
      outputDir: OUTPUT_DIR,
      summaryPath: SUMMARY_PATH
    },
    portfolio: pipeline.portfolio || [],
    preCatalystExitGuard: pipeline.preCatalystExitGuard,
    ranking: latestSnapshot.ranking || [],
    safeToOperate: false,
    safeToReview: health.safeToReview === true,
    shockEvents: pipeline.shockEvents || []
  };
  const summaryMarkdown = renderSummary(result);

  writeJson(LATEST_PATH, result);
  writeText(SUMMARY_PATH, summaryMarkdown);

  return {
    ...result,
    consoleReport: renderConsoleReport(result),
    summaryMarkdown
  };
}

module.exports = {
  runWalyDaily
};
