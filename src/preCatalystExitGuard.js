"use strict";

const fs = require("fs");
const path = require("path");
const {
  BACKTESTS_DIR,
  buildTickerUniverse,
  daysUntil,
  firstText,
  formatRelative,
  getItemText,
  getMergedText,
  getMergedValue,
  readCoreInputs,
  round
} = require("./realSignalLog");
const { detectCatalystType } = require("./catalystEngine");
const { isFiniteNumber } = require("./validators");

const OUTPUT_DIR = path.join(BACKTESTS_DIR, "pre-catalyst-exit-guard");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");

const BINARY_TYPES = new Set(["phase2", "phase3", "PDUFA", "FDA", "critical-earnings"]);
const EXIT_ACTIONS = new Set(["reduce_or_exit_suggested", "do_not_hold_through_event"]);

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("pre-catalyst-exit-guard solo puede escribir dentro de backtests/pre-catalyst-exit-guard/.");
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

function normalizeBoolean(value) {
  return value === true;
}

function isActivePosition(item) {
  const status = getMergedText(item, "status").toLowerCase();
  const quantity = getMergedValue(item, "quantity");

  return item.inPortfolio && status !== "descartar" && (!isFiniteNumber(quantity) || quantity > 0);
}

function detectCriticalEarnings(item, detectedType) {
  if (detectedType !== "earnings") {
    return false;
  }

  const text = getItemText(item).toLowerCase();
  return /binary|critical|transformational|make-or-break|guidance|going concern|covenant|cash runway|approval-dependent/.test(text);
}

function normalizeBinaryType(item) {
  const detectedType = detectCatalystType(item);
  const text = getItemText(item).toLowerCase();

  if (/phase\s*3|phase3|phase-3|topline|readout/.test(text)) {
    return "phase3";
  }

  if (/phase\s*2|phase2|phase-2/.test(text)) {
    return "phase2";
  }

  if (/pdufa/.test(text)) {
    return "PDUFA";
  }

  if (detectedType === "FDA" || /fda decision|approval decision|regulatory decision|crl/.test(text)) {
    return "FDA";
  }

  if (detectCriticalEarnings(item, detectedType)) {
    return "critical-earnings";
  }

  return detectedType;
}

function windowForDays(daysToCatalyst) {
  if (!isFiniteNumber(daysToCatalyst)) {
    return "missing_date";
  }

  if (daysToCatalyst < 0) {
    return "past_event";
  }

  if (daysToCatalyst <= 1) {
    return "T-1_to_T0";
  }

  if (daysToCatalyst <= 5) {
    return "T-5_to_T-2";
  }

  if (daysToCatalyst <= 10) {
    return "T-10_to_T-5";
  }

  return "outside_window";
}

function suggestedAction({ binaryType, daysToCatalyst, explicitHoldThroughBinary }) {
  if (!BINARY_TYPES.has(binaryType)) {
    return "no_binary_guard";
  }

  const window = windowForDays(daysToCatalyst);

  if (window === "missing_date") {
    return "review";
  }

  if (window === "past_event") {
    return "review_stale_catalyst";
  }

  if (window === "outside_window") {
    return "watch";
  }

  if (explicitHoldThroughBinary && window === "T-1_to_T0") {
    return "hold_through_binary_explicit";
  }

  if (!explicitHoldThroughBinary && window === "T-1_to_T0") {
    return "do_not_hold_through_event";
  }

  if (!explicitHoldThroughBinary) {
    return "reduce_or_exit_suggested";
  }

  if (window === "T-5_to_T-2") {
    return "reduce_or_exit_suggested";
  }

  return "binary_risk_alert";
}

function guardSeverity(action) {
  if (action === "do_not_hold_through_event") {
    return "critical";
  }

  if (action === "reduce_or_exit_suggested") {
    return "high";
  }

  if (action === "binary_risk_alert") {
    return "medium";
  }

  if (action === "review" || action === "review_stale_catalyst") {
    return "review";
  }

  return "low";
}

function analyzePosition(item, currentDate) {
  const binaryType = normalizeBinaryType(item);
  const catalystDate = firstText(
    getMergedText(item, "catalystDate"),
    item.selector && item.selector.context && item.selector.context.catalystDate
  ) || null;
  const days = daysUntil(catalystDate, currentDate);
  const explicitHoldThroughBinary = normalizeBoolean(getMergedValue(item, "explicitHoldThroughBinary"));
  const action = suggestedAction({
    binaryType,
    daysToCatalyst: days,
    explicitHoldThroughBinary
  });
  const marketData = item.marketData || {};
  const avgPrice = getMergedValue(item, "avgPrice");
  const lastPrice = firstValue(marketData.price, getMergedValue(item, "lastPrice"));
  const quantity = getMergedValue(item, "quantity");
  const plPct = isFiniteNumber(avgPrice) && isFiniteNumber(lastPrice) && avgPrice > 0
    ? round(((lastPrice / avgPrice) - 1) * 100, 2)
    : null;
  const plUsd = isFiniteNumber(avgPrice) && isFiniteNumber(lastPrice) && isFiniteNumber(quantity)
    ? round((lastPrice - avgPrice) * quantity, 2)
    : null;
  const missingData = [];

  if (!catalystDate) {
    missingData.push("catalystDate");
  }

  if (!BINARY_TYPES.has(binaryType)) {
    missingData.push("recognizedBinaryCatalyst");
  }

  if (!explicitHoldThroughBinary) {
    missingData.push("explicitHoldThroughBinary");
  }

  return {
    avgPrice: isFiniteNumber(avgPrice) ? avgPrice : null,
    binaryType,
    catalyst: getMergedText(item, "catalyst") || null,
    catalystDate,
    catalystWindow: getMergedText(item, "catalystWindow") || null,
    daysToCatalyst: days,
    explicitHoldThroughBinary,
    inGuardWindow: ["T-10_to_T-5", "T-5_to_T-2", "T-1_to_T0"].includes(windowForDays(days)),
    lastPrice: isFiniteNumber(lastPrice) ? lastPrice : null,
    missingData: [...new Set(missingData)],
    plPct,
    plUsd,
    quantity: isFiniteNumber(quantity) ? quantity : null,
    severity: guardSeverity(action),
    setupRank: getMergedText(item, "setupRank") || null,
    setupType: getMergedText(item, "setupType") || null,
    source: getMergedText(item, "source") || null,
    suggestedAction: action,
    thesis: getMergedText(item, "thesis") || null,
    ticker: item.ticker,
    window: windowForDays(days)
  };
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function buildPreCatalystExitGuardPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const rows = buildTickerUniverse(inputs)
    .filter(isActivePosition)
    .map((item) => analyzePosition(item, inputs.currentDate))
    .sort((left, right) => {
      const severityOrder = {
        critical: 5,
        high: 4,
        medium: 3,
        review: 2,
        low: 1
      };

      if (severityOrder[right.severity] !== severityOrder[left.severity]) {
        return severityOrder[right.severity] - severityOrder[left.severity];
      }

      if (left.daysToCatalyst !== right.daysToCatalyst) {
        if (!isFiniteNumber(left.daysToCatalyst)) {
          return 1;
        }

        if (!isFiniteNumber(right.daysToCatalyst)) {
          return -1;
        }

        return left.daysToCatalyst - right.daysToCatalyst;
      }

      return left.ticker.localeCompare(right.ticker);
    });
  const exitRows = rows.filter((row) => EXIT_ACTIONS.has(row.suggestedAction));
  const alertRows = rows.filter((row) => ["binary_risk_alert", ...EXIT_ACTIONS].includes(row.suggestedAction));
  const payload = {
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No modifica data real.",
      "Output del guard solo en backtests/pre-catalyst-exit-guard/."
    ],
    currentDate: inputs.currentDate,
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    rows,
    safeToOperate: false,
    summary: {
      activePositions: rows.length,
      binaryAlerts: alertRows.length,
      doNotHoldThroughEvent: rows.filter((row) => row.suggestedAction === "do_not_hold_through_event").length,
      explicitHoldOverrides: rows.filter((row) => row.explicitHoldThroughBinary).length,
      reduceOrExitSuggested: rows.filter((row) => row.suggestedAction === "reduce_or_exit_suggested").length,
      tickersToFreeze: exitRows.map((row) => row.ticker),
      total: rows.length
    }
  };

  return {
    inputs,
    payload
  };
}

function renderRows(rows) {
  if (!rows.length) {
    return "- Sin posiciones activas evaluadas.";
  }

  const lines = [
    "| Ticker | Binary type | Catalyst date | Days | Window | Explicit hold | Action | P/L |",
    "| --- | --- | ---: | ---: | --- | --- | --- | ---: |"
  ];

  rows.forEach((row) => {
    lines.push(
      `| ${row.ticker} | ${row.binaryType} | ${row.catalystDate || "n/d"} | ${row.daysToCatalyst === null ? "n/d" : row.daysToCatalyst} | ${row.window} | ${row.explicitHoldThroughBinary ? "true" : "false"} | ${row.suggestedAction} | ${row.plPct === null ? "n/d" : `${row.plPct}%`} |`
    );
  });

  return lines.join("\n");
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Pre-Catalyst Exit Guard v1");
  lines.push("");
  lines.push(`Fecha local: ${payload.currentDate}`);
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: read-only. No opera, no usa IBKR, no usa Binance, no envia ordenes y no modifica data real.");
  lines.push("");
  lines.push("## Reglas");
  lines.push("- T-10 a T-5: binary risk alert.");
  lines.push("- T-5 a T-2: reduce_or_exit_suggested.");
  lines.push("- T-1 a T0: do_not_hold_through_event salvo explicitHoldThroughBinary=true.");
  lines.push("- Si no existe explicitHoldThroughBinary, la posicion no puede pasar por default como hold-through.");
  lines.push("");
  lines.push("## Posiciones evaluadas");
  lines.push(renderRows(payload.rows));
  lines.push("");
  lines.push("## Acciones sugeridas");
  const actionable = payload.rows.filter((row) => ["reduce_or_exit_suggested", "do_not_hold_through_event"].includes(row.suggestedAction));
  if (!actionable.length) {
    lines.push("- Ninguna posicion activa exige reduccion/salida por ventana binaria hoy.");
  } else {
    actionable.forEach((row) => {
      lines.push(`- ${row.ticker}: ${row.suggestedAction} | ${row.binaryType} | ${row.window} | catalyst ${row.catalystDate || "n/d"} | explicitHoldThroughBinary=${row.explicitHoldThroughBinary}`);
    });
  }
  lines.push("");
  lines.push("## Caso OCS");
  const ocs = payload.rows.find((row) => row.ticker === "OCS");
  if (ocs) {
    lines.push(`- OCS: ${ocs.suggestedAction} | ${ocs.binaryType} | ${ocs.window} | daysToCatalyst=${ocs.daysToCatalyst}.`);
    lines.push("- Lectura brutal: OCS no debia quedar como mantener/B watch dentro de ventana DIAMOND sin explicitHoldThroughBinary.");
  } else {
    lines.push("- OCS no aparece como posicion activa en esta corrida.");
  }
  lines.push("");
  lines.push("## Confirmaciones");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function writePreCatalystExitGuardOutputs(payload) {
  const latestPath = writeJson(LATEST_PATH, payload);
  const summaryPath = writeText(SUMMARY_PATH, renderSummary(payload));

  return {
    latestPath,
    outputDir: OUTPUT_DIR,
    summaryPath
  };
}

function renderConsoleReport(payload) {
  const actionRows = payload.rows.filter((row) => ["reduce_or_exit_suggested", "do_not_hold_through_event"].includes(row.suggestedAction));

  return [
    "WALY Pre-Catalyst Exit Guard v1 generado.",
    `Active positions: ${payload.summary.activePositions}`,
    `Binary alerts: ${payload.summary.binaryAlerts}`,
    `Reduce/exit suggested: ${payload.summary.reduceOrExitSuggested}`,
    `Do-not-hold: ${payload.summary.doNotHoldThroughEvent}`,
    `Action tickers: ${actionRows.map((row) => `${row.ticker}:${row.suggestedAction}`).join(" | ") || "ninguno"}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no data real."
  ].join("\n");
}

function runPreCatalystExitGuard(options = {}) {
  const { inputs, payload } = buildPreCatalystExitGuardPayload(options);
  let paths = {
    latestPath: null,
    outputDir: OUTPUT_DIR,
    summaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = writePreCatalystExitGuardOutputs(payload);
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
  EXIT_ACTIONS,
  buildPreCatalystExitGuardPayload,
  runPreCatalystExitGuard,
  writePreCatalystExitGuardOutputs
};
