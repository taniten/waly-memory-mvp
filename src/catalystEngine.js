"use strict";

const {
  buildTickerUniverse,
  clamp,
  daysUntil,
  firstText,
  formatRelative,
  getItemText,
  getMergedText,
  readCoreInputs,
  round,
  writePillarJson
} = require("./realSignalLog");

function detectCatalystType(item) {
  const text = getItemText(item).toLowerCase();
  const direct = getMergedText(item, "catalystType").toLowerCase();

  if (/phase\s*3|phase3|phase-3|topline|readout/.test(text)) {
    return "phase3";
  }

  if (/phase\s*2|phase2|phase-2/.test(text)) {
    return "phase2";
  }

  if (/pdufa/.test(text)) {
    return "PDUFA";
  }

  if (direct === "fda" || /fda|approval|priority review|breakthrough therapy/.test(text)) {
    return "FDA";
  }

  if (direct === "earnings" || /earnings|q[1-4]|guidance/.test(text)) {
    return "earnings";
  }

  if (direct === "insider" || /insider|form 4|director buy|ceo buy/.test(text)) {
    return "insider";
  }

  if (/m&a|merger|acquisition|takeover|buyout/.test(text)) {
    return "M&A";
  }

  if (/financing|offering|convertible|dilution|runway/.test(text)) {
    return "financing";
  }

  if (item.socialMentions.length > 0 && !firstText(getMergedText(item, "catalyst"), getMergedText(item, "catalystDate"))) {
    return "social-only";
  }

  return "unknown";
}

function binaryRiskFor(type, item) {
  const text = getItemText(item).toLowerCase();

  if (/crl|manufactur|binary|approval/.test(text)) {
    return "high";
  }

  if (["PDUFA", "FDA", "phase3"].includes(type)) {
    return "high";
  }

  if (["phase2", "earnings", "financing"].includes(type)) {
    return "medium";
  }

  return type === "unknown" || type === "social-only" ? "medium" : "low";
}

function scoreCatalyst(item, currentDate) {
  const catalystType = detectCatalystType(item);
  const catalystDate = firstText(
    getMergedText(item, "catalystDate"),
    item.selector && item.selector.context && item.selector.context.catalystDate
  ) || null;
  const catalystWindow = getMergedText(item, "catalystWindow") || null;
  const catalyst = getMergedText(item, "catalyst");
  const daysToCatalyst = daysUntil(catalystDate, currentDate);
  const missingData = [];
  let catalystScore = 0;

  if (catalyst) {
    catalystScore += 4;
  } else {
    missingData.push("catalyst");
  }

  if (catalystDate) {
    catalystScore += 6;
  } else if (catalystWindow) {
    catalystScore += 3;
    missingData.push("exactCatalystDate");
  } else {
    missingData.push("catalystDate");
  }

  if (typeof daysToCatalyst === "number") {
    if (daysToCatalyst >= 0 && daysToCatalyst <= 45) {
      catalystScore += 6;
    } else if (daysToCatalyst > 45 && daysToCatalyst <= 90) {
      catalystScore += 3;
    } else if (daysToCatalyst < 0) {
      catalystScore -= 4;
      missingData.push("freshCatalyst");
    }
  }

  if (["PDUFA", "FDA", "phase3"].includes(catalystType)) {
    catalystScore += 7;
  } else if (["phase2", "earnings"].includes(catalystType)) {
    catalystScore += 5;
  } else if (["insider", "M&A", "financing"].includes(catalystType)) {
    catalystScore += 4;
  } else if (catalystType === "social-only") {
    catalystScore += 1;
    missingData.push("hardDataCatalyst");
  } else {
    missingData.push("recognizedCatalystType");
  }

  return {
    binaryRisk: binaryRiskFor(catalystType, item),
    catalystDate,
    catalystScore: clamp(round(catalystScore, 1), 0, 25),
    catalystText: catalyst || null,
    catalystType,
    daysToCatalyst,
    inPortfolio: item.inPortfolio,
    inWatchlist: item.inWatchlist,
    missingData: [...new Set(missingData)],
    ticker: item.ticker
  };
}

function buildCatalystPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const rows = buildTickerUniverse(inputs)
    .filter((item) => item.inPortfolio || item.inWatchlist)
    .map((item) => scoreCatalyst(item, inputs.currentDate))
    .sort((left, right) => right.catalystScore - left.catalystScore || left.ticker.localeCompare(right.ticker));
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "read-only-research",
    notes: [
      "No opera.",
      "No usa red.",
      "No IBKR, no Binance, no ordenes.",
      "Catalyst Engine usa solo memoria local y marca missingData cuando falta evidencia."
    ],
    rows,
    summary: {
      highBinaryRisk: rows.filter((row) => row.binaryRisk === "high").length,
      missingCatalystDate: rows.filter((row) => row.missingData.includes("catalystDate")).length,
      total: rows.length
    }
  };

  return {
    inputs,
    payload
  };
}

function renderConsoleReport(payload) {
  const top = payload.rows.slice(0, 5).map((row) => `${row.ticker}:${row.catalystType}:${row.catalystScore}`);

  return [
    "WALY Catalyst Engine generado.",
    `Tickers: ${payload.summary.total} | highBinaryRisk=${payload.summary.highBinaryRisk}`,
    `Top catalysts: ${top.join(" | ") || "ninguno"}`,
    `Output: ${formatRelative(require("path").join(require("./realSignalLog").OUTPUT_DIR, "catalyst-engine.json"))}`,
    "Confirmacion: no operacion, no IBKR, no Binance."
  ].join("\n");
}

function runCatalystEngine(options = {}) {
  const { inputs, payload } = buildCatalystPayload(options);
  let outputPath = null;

  if (options.writeOutput !== false) {
    outputPath = writePillarJson("catalyst-engine.json", payload);
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
  buildCatalystPayload,
  detectCatalystType,
  runCatalystEngine
};
