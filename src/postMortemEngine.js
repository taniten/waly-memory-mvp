"use strict";

const path = require("path");
const {
  OUTPUT_DIR,
  buildPayload: buildSignalLogPayload,
  formatRelative,
  readCoreInputs,
  writePillarJson
} = require("./realSignalLog");
const { buildCatalystPayload } = require("./catalystEngine");
const { buildSizingPayload } = require("./sizingEngine");
const { buildTimingPayload } = require("./timingEngine");

function indexByTicker(rows) {
  return new Map((rows || []).map((row) => [row.ticker, row]));
}

function thesisQuality(signal) {
  if (!signal.thesis || /^missingData/.test(signal.thesis)) {
    return "missingData";
  }

  return signal.catalystDate ? "documentada" : "incompleta";
}

function buildPostMortemRow(signal, catalyst, timing, sizing) {
  const pending = signal.status !== "closed" && signal.verdict === "pending";
  const lessons = [];

  if (catalyst && catalyst.daysToCatalyst !== null && catalyst.daysToCatalyst < 0) {
    lessons.push("Revisar si el catalyst ya ocurrio y si la tesis sigue viva.");
  }

  if (timing && ["no_timing", "early_watch"].includes(timing.status)) {
    lessons.push("Timing aun no confirma; no convertir tesis en accion.");
  }

  if (sizing && sizing.sizingAction === "no_add") {
    lessons.push("Sizing bloquea agregar; respetar cartera primero.");
  }

  return {
    catalystOccurred: catalyst && typeof catalyst.daysToCatalyst === "number" ? catalyst.daysToCatalyst < 0 : null,
    catalystReview: catalyst ? `${catalyst.catalystType} | score ${catalyst.catalystScore}` : "missingData",
    exitOrPartial: "missingData: no se leen outcomes reales ni ejecuciones nuevas",
    lessons: lessons.length ? lessons : ["pending: falta resolucion nueva para aprender sin inventar."],
    pending,
    signalId: signal.signalId,
    sizingReview: sizing ? `${sizing.sizingAction} | suggested $${sizing.suggestedSizeUSD}` : "missingData",
    thesisQuality: thesisQuality(signal),
    ticker: signal.ticker,
    timingReview: timing ? `${timing.status} | score ${timing.timingScore}` : "missingData",
    verdict: pending ? "pending" : signal.verdict
  };
}

function buildPostMortemPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const signals = options.signalLogPayload || buildSignalLogPayload({ inputs }).payload;
  const catalyst = options.catalystPayload || buildCatalystPayload({ inputs }).payload;
  const timing = options.timingPayload || buildTimingPayload({ inputs }).payload;
  const sizing = options.sizingPayload || buildSizingPayload({ inputs, timingPayload: timing }).payload;
  const catalystByTicker = indexByTicker(catalyst.rows);
  const timingByTicker = indexByTicker(timing.rows);
  const sizingByTicker = indexByTicker(sizing.rows);
  const rows = signals.signals.map((signal) =>
    buildPostMortemRow(
      signal,
      catalystByTicker.get(signal.ticker),
      timingByTicker.get(signal.ticker),
      sizingByTicker.get(signal.ticker)
    )
  );
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "read-only-research",
    notes: [
      "No toca outcomes reales.",
      "Si no hay trades cerrados nuevos, marca pending.",
      "Estructura preparada para conectar outcomes futuros sin reescribir historial."
    ],
    rows,
    summary: {
      pending: rows.filter((row) => row.pending).length,
      total: rows.length,
      withCatalystOccurred: rows.filter((row) => row.catalystOccurred === true).length
    }
  };

  return {
    inputs,
    payload
  };
}

function renderConsoleReport(payload) {
  return [
    "WALY Post-mortem Engine generado.",
    `Rows: ${payload.summary.total} | pending=${payload.summary.pending} | catalystOccurred=${payload.summary.withCatalystOccurred}`,
    `Output: ${formatRelative(path.join(OUTPUT_DIR, "post-mortem-engine.json"))}`,
    "Confirmacion: no outcomes reales modificados, no operacion."
  ].join("\n");
}

function runPostMortemEngine(options = {}) {
  const { inputs, payload } = buildPostMortemPayload(options);
  let outputPath = null;

  if (options.writeOutput !== false) {
    outputPath = writePillarJson("post-mortem-engine.json", payload);
  }

  return {
    ...payload,
    inputsRaw: inputs,
    paths: {
      outputPath
    },
    consoleReport: renderConsoleReport(payload)
  };
}

module.exports = {
  buildPostMortemPayload,
  runPostMortemEngine
};
