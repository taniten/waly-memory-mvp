"use strict";

const fs = require("fs");
const path = require("path");
const {
  BACKTESTS_DIR,
  buildTickerUniverse,
  coerceNumber,
  firstValue,
  formatRelative,
  getMergedText,
  getMergedValue,
  readCoreInputs,
  readJsonIfExists,
  round
} = require("./realSignalLog");
const { isFiniteNumber } = require("./validators");

const OUTPUT_DIR = path.join(BACKTESTS_DIR, "position-shock-monitor");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const DAILY_RUN_PATH = path.join(BACKTESTS_DIR, "daily-run", "latest.json");
const PIPELINE_PATH = path.join(BACKTESTS_DIR, "7-pillars", "waly-pipeline-latest.json");

const NEWS_CHECKLIST = [
  "trial result",
  "FDA / PDUFA / CRL",
  "offering / dilution",
  "financing",
  "delay",
  "downgrade",
  "halt",
  "data readout",
  "management update"
];

const SHOCK_RANK = {
  none: 0,
  alert: 1,
  risk_event: 2,
  freeze_position: 3,
  thesis_broken_until_review: 4
};

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("position-shock-monitor solo puede escribir dentro de backtests/position-shock-monitor/.");
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

function isActivePosition(item) {
  const status = getMergedText(item, "status").toLowerCase();
  const quantity = coerceNumber(getMergedValue(item, "quantity"));

  return item.inPortfolio && status !== "descartar" && (!isFiniteNumber(quantity) || quantity > 0);
}

function severityForDayChange(dayChangePct) {
  if (!isFiniteNumber(dayChangePct)) {
    return "none";
  }

  if (dayChangePct <= -40) {
    return "thesis_broken_until_review";
  }

  if (dayChangePct <= -20) {
    return "freeze_position";
  }

  if (dayChangePct <= -12) {
    return "risk_event";
  }

  if (dayChangePct <= -8) {
    return "alert";
  }

  return "none";
}

function suggestedActionFor(shockSeverity) {
  if (shockSeverity === "thesis_broken_until_review") {
    return "thesis_broken_until_review";
  }

  if (shockSeverity === "freeze_position") {
    return "freeze";
  }

  if (shockSeverity === "risk_event") {
    return "review";
  }

  if (shockSeverity === "alert") {
    return "alert";
  }

  return "hold";
}

function isShock(row) {
  return SHOCK_RANK[row.shockSeverity] >= SHOCK_RANK.alert;
}

function isFreezeOrWorse(row) {
  return SHOCK_RANK[row.shockSeverity] >= SHOCK_RANK.freeze_position;
}

function marketDataFor(item) {
  const source = item.marketData || {};

  return {
    dayChangePct: coerceNumber(source.dayChangePct),
    dollarVolume: coerceNumber(source.dollarVolume),
    lastDataDate: source.lastDataDate || null,
    lastPrice: coerceNumber(firstValue(source.price, source.lastPrice, getMergedValue(item, "lastPrice"))),
    previousClose: coerceNumber(source.previousClose),
    relVol: coerceNumber(firstValue(source.relativeVolume, source.relVol)),
    source: source.source || source.sourceTag || null
  };
}

function analyzePosition(item, inputs) {
  const marketData = marketDataFor(item);
  const qty = coerceNumber(getMergedValue(item, "quantity"));
  const avgPrice = coerceNumber(getMergedValue(item, "avgPrice"));
  const lastPrice = marketData.lastPrice;
  const previousClose = marketData.previousClose;
  const dayChangePct = marketData.dayChangePct;
  const totalCapital = coerceNumber(inputs.settings && inputs.settings.portfolio && inputs.settings.portfolio.totalCapitalEstimate);
  const shockSeverity = severityForDayChange(dayChangePct);
  const action = suggestedActionFor(shockSeverity);
  const unrealizedPnL = isFiniteNumber(qty) && isFiniteNumber(avgPrice) && isFiniteNumber(lastPrice)
    ? round((lastPrice - avgPrice) * qty, 2)
    : null;
  const unrealizedPnLPct = isFiniteNumber(avgPrice) && avgPrice > 0 && isFiniteNumber(lastPrice)
    ? round(((lastPrice / avgPrice) - 1) * 100, 2)
    : null;
  const estimatedDayPnL = isFiniteNumber(qty) && isFiniteNumber(previousClose) && isFiniteNumber(lastPrice)
    ? round((lastPrice - previousClose) * qty, 2)
    : null;
  const estimatedPortfolioImpact = isFiniteNumber(estimatedDayPnL) && isFiniteNumber(totalCapital) && totalCapital > 0
    ? round((estimatedDayPnL / totalCapital) * 100, 2)
    : null;
  const requireManualReview = SHOCK_RANK[shockSeverity] >= SHOCK_RANK.alert;
  const requireNewsCheck = requireManualReview;
  const noAdd = requireManualReview;
  const freezeOrWorse = SHOCK_RANK[shockSeverity] >= SHOCK_RANK.freeze_position;
  const missingData = [
    !isFiniteNumber(dayChangePct) ? "dayChangePct" : null
  ].filter(Boolean);

  return {
    avgPrice: isFiniteNumber(avgPrice) ? avgPrice : null,
    dayChangePct: isFiniteNumber(dayChangePct) ? dayChangePct : null,
    dollarVolume: isFiniteNumber(marketData.dollarVolume) ? marketData.dollarVolume : null,
    estimatedDayPnL,
    estimatedPortfolioImpact,
    lastDataDate: marketData.lastDataDate,
    lastPrice: isFiniteNumber(lastPrice) ? lastPrice : null,
    marketDataSource: marketData.source,
    missingData,
    newsChecklist: requireNewsCheck ? NEWS_CHECKLIST : [],
    noAdd,
    qty: isFiniteNumber(qty) ? qty : null,
    relVol: isFiniteNumber(marketData.relVol) ? marketData.relVol : null,
    requireManualReview,
    requireNewsCheck,
    selectorOverride: {
      action: freezeOrWorse ? "freeze/review" : (requireManualReview ? "review" : "none"),
      active: requireManualReview,
      reason: requireManualReview
        ? `positionShockMonitor: ${shockSeverity} on ${dayChangePct}% daily move`
        : null,
      sizingSuggested: freezeOrWorse ? 0 : null
    },
    shockSeverity,
    suggestedAction: action,
    ticker: item.ticker,
    unrealizedPnL,
    unrealizedPnLPct
  };
}

function readOptionalContext(options) {
  return {
    dailyRun: Object.prototype.hasOwnProperty.call(options, "dailyRun")
      ? options.dailyRun
      : readJsonIfExists(DAILY_RUN_PATH),
    pipelineLatest: Object.prototype.hasOwnProperty.call(options, "pipelineLatest")
      ? options.pipelineLatest
      : readJsonIfExists(PIPELINE_PATH)
  };
}

function buildPositionShockPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const context = readOptionalContext(options);
  const rows = buildTickerUniverse(inputs)
    .filter(isActivePosition)
    .map((item) => analyzePosition(item, inputs))
    .sort((left, right) => {
      if (SHOCK_RANK[right.shockSeverity] !== SHOCK_RANK[left.shockSeverity]) {
        return SHOCK_RANK[right.shockSeverity] - SHOCK_RANK[left.shockSeverity];
      }

      return Math.abs(right.dayChangePct || 0) - Math.abs(left.dayChangePct || 0) ||
        left.ticker.localeCompare(right.ticker);
    });
  const shockEvents = rows.filter(isShock);
  const freezeEvents = rows.filter(isFreezeOrWorse);
  const payload = {
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No modifica positions.",
      "No modifica outcomes.",
      "No modifica data/*.json.",
      "No modifica data/social_signals.json.",
      "No commit.",
      "No push.",
      "Output del monitor solo en backtests/position-shock-monitor/."
    ],
    currentDate: inputs.currentDate,
    generatedAt: new Date().toISOString(),
    inputs: {
      dailyCockpit: inputs.dailyCockpit ? "backtests/daily-cockpit/latest.json" : null,
      dailyRun: context.dailyRun ? formatRelative(DAILY_RUN_PATH) : null,
      pipelineLatest: context.pipelineLatest ? formatRelative(PIPELINE_PATH) : null,
      positions: "data/positions.json"
    },
    mode: "read-only",
    newsChecklist: NEWS_CHECKLIST,
    rows,
    safeToOperate: false,
    shockEvents,
    summary: {
      activePositions: rows.length,
      freezeOrWorse: freezeEvents.length,
      shockEvents: shockEvents.length,
      tickersToFreeze: freezeEvents.map((row) => row.ticker),
      totalEstimatedDayPnL: round(shockEvents.reduce((sum, row) => sum + (row.estimatedDayPnL || 0), 0), 2),
      totalEstimatedPortfolioImpact: round(shockEvents.reduce((sum, row) => sum + (row.estimatedPortfolioImpact || 0), 0), 2)
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
    "| Ticker | Qty | Avg | Last | Day % | RelVol | $Vol | U-PnL | Impact | Severity | Action |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |"
  ];

  rows.forEach((row) => {
    lines.push(
      `| ${row.ticker} | ${row.qty === null ? "n/d" : row.qty} | ${row.avgPrice === null ? "n/d" : row.avgPrice} | ${row.lastPrice === null ? "n/d" : row.lastPrice} | ${row.dayChangePct === null ? "n/d" : `${row.dayChangePct}%`} | ${row.relVol === null ? "n/d" : row.relVol} | ${row.dollarVolume === null ? "n/d" : `$${Math.round(row.dollarVolume).toLocaleString("en-US")}`} | ${row.unrealizedPnL === null ? "n/d" : `$${row.unrealizedPnL}`} | ${row.estimatedPortfolioImpact === null ? "n/d" : `${row.estimatedPortfolioImpact}%`} | ${row.shockSeverity} | ${row.suggestedAction} |`
    );
  });

  return lines.join("\n");
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Position Shock Monitor v1");
  lines.push("");
  lines.push(`Fecha local: ${payload.currentDate}`);
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: read-only. No opera, no usa IBKR, no usa Binance, no envia ordenes y no modifica data real.");
  lines.push("");
  lines.push("## Posiciones evaluadas");
  lines.push(renderRows(payload.rows));
  lines.push("");
  lines.push("## Shocks detectados");
  if (!payload.shockEvents.length) {
    lines.push("- Sin shocks detectados.");
  } else {
    payload.shockEvents.forEach((row) => {
      lines.push(`- ${row.ticker}: ${row.shockSeverity} | day ${row.dayChangePct}% | perdida diaria estimada $${row.estimatedDayPnL} | impacto ${row.estimatedPortfolioImpact}% | accion ${row.suggestedAction}.`);
    });
  }
  lines.push("");
  lines.push("## News checklist requerido");
  NEWS_CHECKLIST.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push("## Confirmacion: no operacion / no IBKR / no Binance");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function writePositionShockOutputs(payload) {
  const latestPath = writeJson(LATEST_PATH, payload);
  const summaryPath = writeText(SUMMARY_PATH, renderSummary(payload));

  return {
    latestPath,
    outputDir: OUTPUT_DIR,
    summaryPath
  };
}

function renderConsoleReport(payload) {
  const shocks = payload.shockEvents.map((row) => `${row.ticker}:${row.shockSeverity}:${row.suggestedAction}`);

  return [
    "WALY Position Shock Monitor v1 generado.",
    `Active positions: ${payload.summary.activePositions}`,
    `Shock events: ${payload.summary.shockEvents}`,
    `Freeze or worse: ${payload.summary.freezeOrWorse}`,
    `Shocks: ${shocks.join(" | ") || "ninguno"}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no commit, no push."
  ].join("\n");
}

function runPositionShockMonitor(options = {}) {
  const { inputs, payload } = buildPositionShockPayload(options);
  let paths = {
    latestPath: null,
    outputDir: OUTPUT_DIR,
    summaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = writePositionShockOutputs(payload);
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
  NEWS_CHECKLIST,
  SHOCK_RANK,
  buildPositionShockPayload,
  isFreezeOrWorse,
  runPositionShockMonitor,
  writePositionShockOutputs
};
