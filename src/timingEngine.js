"use strict";

const path = require("path");
const {
  OUTPUT_DIR,
  buildTickerUniverse,
  clamp,
  coerceNumber,
  firstValue,
  formatRelative,
  getMergedValue,
  readCoreInputs,
  round,
  writePillarJson
} = require("./realSignalLog");

const MIN_DOLLAR_VOLUME = 10000000;

function getTrigger(item) {
  const explicit = coerceNumber(firstValue(
    getMergedValue(item, "triggerPrice"),
    getMergedValue(item, "maxTriggerPrice"),
    getMergedValue(item, "entryTriggerPrice")
  ));

  if (explicit) {
    return {
      source: "item",
      value: explicit
    };
  }

  if (item.ticker === "VERA") {
    return {
      source: "daily-cockpit-vera-trigger",
      value: 34.5
    };
  }

  return {
    source: null,
    value: null
  };
}

function scoreTiming(item) {
  const market = item.marketData || {};
  const trigger = getTrigger(item);
  const price = market.price;
  const relVol = market.relativeVolume;
  const dollarVolume = market.dollarVolume;
  const dayMove = market.dayChangePct;
  const missingData = [];
  const redFlags = [];
  let timingScore = 0;

  if (typeof price === "number") {
    timingScore += 2;
  } else {
    missingData.push("price");
  }

  if (typeof relVol === "number") {
    if (relVol > 1.25) {
      timingScore += 5;
    } else if (relVol >= 0.75) {
      timingScore += 3;
    } else {
      timingScore += 1;
      redFlags.push("RelVol < 0.75: timing debil");
    }
  } else {
    missingData.push("RelVol");
  }

  if (typeof dollarVolume === "number") {
    if (dollarVolume >= MIN_DOLLAR_VOLUME) {
      timingScore += 4;
    } else if (dollarVolume >= 5000000) {
      timingScore += 2;
      redFlags.push("dollarVolume borderline");
    } else {
      redFlags.push("dollarVolume insuficiente");
    }
  } else {
    missingData.push("dollarVolume");
  }

  if (typeof dayMove === "number") {
    if (dayMove > 8) {
      redFlags.push("extended_risk por dayMove alto");
    } else if (Math.abs(dayMove) <= 5) {
      timingScore += 3;
    }
  } else {
    missingData.push("dayMove");
  }

  const priceVsTrigger = trigger.value && typeof price === "number"
    ? round(price - trigger.value, 3)
    : null;
  if (trigger.value && typeof price === "number" && price <= trigger.value) {
    timingScore += 1;
  } else if (!trigger.value) {
    missingData.push("trigger");
  }

  let status = "no_timing";
  if (typeof dayMove === "number" && dayMove > 8) {
    status = "extended_risk";
  } else if (typeof relVol !== "number" || typeof dollarVolume !== "number") {
    status = "no_timing";
  } else if (relVol > 1.25 && dollarVolume >= MIN_DOLLAR_VOLUME) {
    status = "trigger_confirmed";
  } else if (relVol >= 0.75 || (trigger.value && typeof price === "number" && price <= trigger.value)) {
    status = "trigger_near";
  } else if (typeof price === "number") {
    status = "early_watch";
  }

  if (status === "trigger_near" && dollarVolume < MIN_DOLLAR_VOLUME) {
    redFlags.push("precio/RelVol sin volumen suficiente no habilita entrada");
  }

  return {
    dayMove,
    dollarVolume,
    inPortfolio: item.inPortfolio,
    inWatchlist: item.inWatchlist,
    missingData: [...new Set(missingData)],
    price,
    priceVsTrigger,
    redFlags: [...new Set(redFlags)],
    relativeVolume: relVol,
    status,
    ticker: item.ticker,
    timingScore: clamp(round(timingScore, 1), 0, 15),
    trigger
  };
}

function buildTimingPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const rows = buildTickerUniverse(inputs)
    .filter((item) => item.inPortfolio || item.inWatchlist || item.selector)
    .map(scoreTiming)
    .sort((left, right) => right.timingScore - left.timingScore || left.ticker.localeCompare(right.ticker));
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "read-only-research",
    notes: [
      "No opera.",
      "Precio sin volumen no habilita entrada.",
      "RelVol < 0.75 = timing debil; 0.75-1.25 = vigilancia; >1.25 con dollarVolume suficiente = posible confirmacion."
    ],
    rows,
    summary: {
      confirmed: rows.filter((row) => row.status === "trigger_confirmed").length,
      extendedRisk: rows.filter((row) => row.status === "extended_risk").length,
      total: rows.length
    }
  };

  return {
    inputs,
    payload
  };
}

function renderConsoleReport(payload) {
  const top = payload.rows.slice(0, 5).map((row) => `${row.ticker}:${row.status}:${row.timingScore}`);

  return [
    "WALY Timing Engine generado.",
    `Tickers: ${payload.summary.total} | confirmed=${payload.summary.confirmed}`,
    `Top timing: ${top.join(" | ") || "ninguno"}`,
    `Output: ${formatRelative(path.join(OUTPUT_DIR, "timing-engine.json"))}`,
    "Confirmacion: no operacion, no IBKR, no Binance."
  ].join("\n");
}

function runTimingEngine(options = {}) {
  const { inputs, payload } = buildTimingPayload(options);
  let outputPath = null;

  if (options.writeOutput !== false) {
    outputPath = writePillarJson("timing-engine.json", payload);
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
  buildTimingPayload,
  runTimingEngine
};
