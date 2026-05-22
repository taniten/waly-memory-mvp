"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { isFiniteNumber, isNonEmptyString, isValidDateOnlyString, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const ALLOWED_OUTPUTS = {
  outputDir: path.join(ROOT_DIR, "backtests", "historical-research"),
  priceOutputDir: path.join(ROOT_DIR, "historical_prices", "research"),
  signalOutputDir: path.join(ROOT_DIR, "historical_signals", "research")
};
const PRICE_COLUMNS = ["date", "open", "high", "low", "close", "volume"];
const HORIZONS = [5, 10, 20, 30, 60, 90];
const TAKE_PROFITS = [20, 30, 50];
const STOP_LOSSES = [-10, -15, -20];
const EXIT_DAYS = [10, 20, 30, 60];
const SIGNAL_TYPES = [
  "20d-low-rebound",
  "volume-spike",
  "52w-high-breakout",
  "drawdown-from-52w-high"
];

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`No existe la config ${filePath}.`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${filePath}: ${error.message}`);
    }

    throw error;
  }
}

function writeTextFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function writeJsonFile(filePath, value) {
  return writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveFromRoot(inputPath) {
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(ROOT_DIR, inputPath);
}

function assertAllowedDirectory(actualPath, allowedPath, label) {
  const resolvedActual = path.resolve(actualPath);
  const resolvedAllowed = path.resolve(allowedPath);
  const relative = path.relative(resolvedAllowed, resolvedActual);

  if (resolvedActual !== resolvedAllowed && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`${label} solo puede escribir dentro de ${formatRelative(resolvedAllowed)}.`);
  }

  return resolvedActual;
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const clean = values.filter((value) => isFiniteNumber(value));
  if (!clean.length) {
    return null;
  }

  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function percentage(part, total) {
  if (!total) {
    return null;
  }

  return round((part / total) * 100, 1);
}

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${value > 0 ? "+" : ""}${round(value, 1).toFixed(1)}%`;
}

function normalizeConfig(configPathInput) {
  const configPath = path.resolve(process.cwd(), configPathInput);
  const config = readJsonFile(configPath);

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("La config de historical-research-lab debe ser un objeto JSON.");
  }

  if (!isValidDateOnlyString(config.startDate) || !isValidDateOnlyString(config.endDate)) {
    throw new Error("startDate y endDate deben usar YYYY-MM-DD.");
  }

  if (config.startDate > config.endDate) {
    throw new Error("startDate no puede ser posterior a endDate.");
  }

  if (!Array.isArray(config.universe) || config.universe.length === 0) {
    throw new Error("universe debe ser un array no vacio.");
  }

  if (config.dataProvider !== "yahoo-chart") {
    throw new Error("historical-research-lab solo soporta dataProvider=yahoo-chart.");
  }

  const universe = [...new Set(config.universe.map(normalizeTicker).filter(Boolean))];

  if (!universe.length) {
    throw new Error("universe no contiene tickers validos.");
  }

  return {
    configPath,
    dataProvider: config.dataProvider,
    endDate: config.endDate,
    outputDir: assertAllowedDirectory(resolveFromRoot(config.outputDir || ALLOWED_OUTPUTS.outputDir), ALLOWED_OUTPUTS.outputDir, "outputDir"),
    priceOutputDir: assertAllowedDirectory(
      resolveFromRoot(config.priceOutputDir || ALLOWED_OUTPUTS.priceOutputDir),
      ALLOWED_OUTPUTS.priceOutputDir,
      "priceOutputDir"
    ),
    signalOutputDir: assertAllowedDirectory(
      resolveFromRoot(config.signalOutputDir || ALLOWED_OUTPUTS.signalOutputDir),
      ALLOWED_OUTPUTS.signalOutputDir,
      "signalOutputDir"
    ),
    startDate: config.startDate,
    universe
  };
}

function toUnix(dateString) {
  return Math.floor(new Date(`${dateString}T00:00:00Z`).getTime() / 1000);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function approxWeekdaysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let count = 0;

  for (let date = start; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      count += 1;
    }
  }

  return count;
}

async function fetchJson(url) {
  if (typeof fetch !== "function") {
    throw new Error("Node fetch no esta disponible.");
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al consultar Yahoo.`);
  }

  return response.json();
}

function extractRowsFromYahoo(ticker, payload) {
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  const timestamps = result && result.timestamp;
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];

  if (!Array.isArray(timestamps) || !quote) {
    throw new Error(`${ticker}: Yahoo no devolvio OHLCV diario.`);
  }

  return timestamps
    .map((timestamp, index) => ({
      close: quote.close && quote.close[index],
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      high: quote.high && quote.high[index],
      low: quote.low && quote.low[index],
      open: quote.open && quote.open[index],
      volume: quote.volume && quote.volume[index]
    }))
    .filter((row) =>
      PRICE_COLUMNS.every((field) => field === "date" || row[field] !== null && row[field] !== undefined)
    )
    .map((row) => ({
      date: row.date,
      open: round(Number(row.open), 4),
      high: round(Number(row.high), 4),
      low: round(Number(row.low), 4),
      close: round(Number(row.close), 4),
      volume: Number(row.volume)
    }));
}

async function downloadPrices(ticker, config) {
  const period1 = toUnix(config.startDate);
  const period2 = toUnix(addDays(config.endDate, 1));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const payload = await fetchJson(url);
  const rows = extractRowsFromYahoo(ticker, payload).filter(
    (row) => row.date >= config.startDate && row.date <= config.endDate
  );

  return rows;
}

function csvEscape(value) {
  return String(value);
}

function writePriceCsv(filePath, rows) {
  const lines = [
    PRICE_COLUMNS.join(","),
    ...rows.map((row) => PRICE_COLUMNS.map((column) => csvEscape(row[column])).join(","))
  ];

  writeTextFile(filePath, `${lines.join("\n")}\n`);
}

function validatePriceRows(ticker, rows, config) {
  const errors = [];
  const seen = new Set();
  let previousDate = null;

  rows.forEach((row, index) => {
    PRICE_COLUMNS.forEach((column) => {
      if (!(column in row)) {
        errors.push(`${ticker}[${index}] falta columna ${column}.`);
      }
    });

    if (!isValidDateOnlyString(row.date)) {
      errors.push(`${ticker}[${index}] date invalida.`);
    }

    if (previousDate && row.date <= previousDate) {
      errors.push(`${ticker}[${index}] fechas no ascendentes.`);
    }

    if (seen.has(row.date)) {
      errors.push(`${ticker}[${index}] fecha duplicada ${row.date}.`);
    }

    seen.add(row.date);
    previousDate = row.date;

    ["open", "high", "low", "close", "volume"].forEach((column) => {
      if (!isFiniteNumber(row[column])) {
        errors.push(`${ticker}[${index}] ${column} no numerico.`);
      }
    });
  });

  const firstDate = rows.length ? rows[0].date : null;
  const lastDate = rows.length ? rows[rows.length - 1].date : null;
  const expectedRows = firstDate && lastDate ? approxWeekdaysBetween(firstDate, lastDate) : approxWeekdaysBetween(config.startDate, config.endDate);
  const missingDaysApprox = Math.max(0, expectedRows - rows.length);

  return {
    errors,
    firstDate,
    lastDate,
    missingDaysApprox,
    rows: rows.length,
    startsAfterRequestedStart: Boolean(firstDate && firstDate > addDays(config.startDate, 7)),
    ticker
  };
}

function maxBy(rows, field) {
  if (!rows.length) {
    return null;
  }

  return rows.reduce((best, row) => (row[field] > best[field] ? row : best), rows[0]);
}

function minBy(rows, field) {
  if (!rows.length) {
    return null;
  }

  return rows.reduce((best, row) => (row[field] < best[field] ? row : best), rows[0]);
}

function rollingWindow(rows, endIndex, length) {
  const start = Math.max(0, endIndex - length);
  return rows.slice(start, endIndex);
}

function createSignal({ details, signalDate, signalType, ticker }) {
  return {
    assetType: "equity",
    details,
    entryPricePolicy: "next-open",
    playbookType: "event-swing",
    signalDate,
    signalType,
    sourceKind: "historical-research",
    ticker
  };
}

function generateSignalsForTicker(ticker, rows) {
  const signals = [];

  for (let index = 252; index < rows.length - 90; index += 1) {
    const row = rows[index];
    const previous20 = rollingWindow(rows, index, 20);
    const previous50 = rollingWindow(rows, index, 50);
    const previous252 = rollingWindow(rows, index, 252);
    const low20 = minBy(previous20, "low");
    const high252 = maxBy(previous252, "high");
    const avgVolume20 = average(previous20.map((item) => item.volume));
    const avgVolume50 = average(previous50.map((item) => item.volume));

    if (low20 && row.low <= low20.low * 1.01 && row.close >= row.open && row.close >= row.low * 1.04) {
      signals.push(createSignal({
        details: {
          close: row.close,
          low20: low20.low,
          reboundFromLowPct: round(((row.close / low20.low) - 1) * 100, 1)
        },
        signalDate: row.date,
        signalType: "20d-low-rebound",
        ticker
      }));
    }

    if (avgVolume20 && row.volume >= avgVolume20 * 2 && Math.abs(((row.close / row.open) - 1) * 100) >= 3) {
      signals.push(createSignal({
        details: {
          avgVolume20: Math.round(avgVolume20),
          dayReturnPct: round(((row.close / row.open) - 1) * 100, 1),
          relativeVolume: round(row.volume / avgVolume20, 2)
        },
        signalDate: row.date,
        signalType: "volume-spike",
        ticker
      }));
    }

    if (high252 && row.close > high252.high * 1.01 && row.volume >= (avgVolume50 || 0) * 1.25) {
      signals.push(createSignal({
        details: {
          close: row.close,
          high252: high252.high,
          relativeVolume50: avgVolume50 ? round(row.volume / avgVolume50, 2) : null
        },
        signalDate: row.date,
        signalType: "52w-high-breakout",
        ticker
      }));
    }

    if (high252 && row.close <= high252.high * 0.65 && row.close >= row.low * 1.03 && row.volume >= (avgVolume20 || 0) * 1.1) {
      signals.push(createSignal({
        details: {
          close: row.close,
          drawdownFrom52wHighPct: round(((row.close / high252.high) - 1) * 100, 1),
          high252: high252.high
        },
        signalDate: row.date,
        signalType: "drawdown-from-52w-high",
        ticker
      }));
    }
  }

  return signals;
}

function buildPriceIndex(priceDataByTicker) {
  const index = new Map();

  Object.entries(priceDataByTicker).forEach(([ticker, rows]) => {
    index.set(ticker, {
      byDate: new Map(rows.map((row, rowIndex) => [row.date, { row, rowIndex }])),
      rows
    });
  });

  return index;
}

function getEntry(priceSet, signalDate) {
  const after = priceSet.rows.find((row) => row.date > signalDate);

  if (!after) {
    return null;
  }

  const rowIndex = priceSet.rows.indexOf(after);
  return {
    price: after.open,
    row: after,
    rowIndex
  };
}

function maxDrawdownPct(entryPrice, rows) {
  if (!rows.length || !entryPrice) {
    return null;
  }

  const worstLow = Math.min(...rows.map((row) => row.low));
  return round(((worstLow / entryPrice) - 1) * 100, 2);
}

function runSignalHorizons(signal, priceSet) {
  const entry = getEntry(priceSet, signal.signalDate);

  if (!entry) {
    return {
      error: "sin next-open disponible",
      horizons: {}
    };
  }

  const horizons = {};

  HORIZONS.forEach((horizon) => {
    const exitIndex = entry.rowIndex + horizon;
    const exitRow = priceSet.rows[exitIndex];

    if (!exitRow) {
      horizons[`${horizon}d`] = {
        status: "pending"
      };
      return;
    }

    const windowRows = priceSet.rows.slice(entry.rowIndex, exitIndex + 1);
    horizons[`${horizon}d`] = {
      entryDate: entry.row.date,
      entryPrice: entry.price,
      exitDate: exitRow.date,
      exitPrice: exitRow.close,
      maxDrawdownPct: maxDrawdownPct(entry.price, windowRows),
      returnPct: round(((exitRow.close / entry.price) - 1) * 100, 2),
      status: "completed"
    };
  });

  return {
    error: null,
    horizons
  };
}

function summarizeBacktest(results) {
  const byType = {};
  const hitRatesByHorizon = {};

  SIGNAL_TYPES.forEach((type) => {
    const typeResults = results.filter((result) => result.signalType === type);
    const completed30 = typeResults
      .map((result) => result.horizons["30d"])
      .filter((item) => item && item.status === "completed");

    byType[type] = {
      avgMaxDrawdownPct: round(average(completed30.map((item) => item.maxDrawdownPct)), 2),
      avgReturn30dPct: round(average(completed30.map((item) => item.returnPct)), 2),
      completed30d: completed30.length,
      signals: typeResults.length
    };
  });

  HORIZONS.forEach((horizon) => {
    const key = `${horizon}d`;
    const completed = results
      .map((result) => result.horizons[key])
      .filter((item) => item && item.status === "completed");
    const winners = completed.filter((item) => item.returnPct > 0).length;

    hitRatesByHorizon[key] = {
      avgReturnPct: round(average(completed.map((item) => item.returnPct)), 2),
      completed: completed.length,
      hitRatePct: percentage(winners, completed.length)
    };
  });

  return {
    byType,
    generatedSignals: results.length,
    hitRatesByHorizon
  };
}

function simulateRule(signal, priceSet, takeProfitPct, stopLossPct, exitDays) {
  const entry = getEntry(priceSet, signal.signalDate);

  if (!entry) {
    return {
      status: "pending"
    };
  }

  const maxIndex = Math.min(priceSet.rows.length - 1, entry.rowIndex + exitDays);

  for (let index = entry.rowIndex; index <= maxIndex; index += 1) {
    const row = priceSet.rows[index];
    const highReturn = ((row.high / entry.price) - 1) * 100;
    const lowReturn = ((row.low / entry.price) - 1) * 100;

    if (lowReturn <= stopLossPct) {
      return {
        exitDate: row.date,
        exitReason: "stop-loss",
        maxDrawdownPct: stopLossPct,
        returnPct: stopLossPct,
        status: "closed"
      };
    }

    if (highReturn >= takeProfitPct) {
      return {
        exitDate: row.date,
        exitReason: "take-profit",
        maxDrawdownPct: maxDrawdownPct(entry.price, priceSet.rows.slice(entry.rowIndex, index + 1)),
        returnPct: takeProfitPct,
        status: "closed"
      };
    }
  }

  const exitRow = priceSet.rows[maxIndex];
  const windowRows = priceSet.rows.slice(entry.rowIndex, maxIndex + 1);

  return {
    exitDate: exitRow.date,
    exitReason: "time-exit",
    maxDrawdownPct: maxDrawdownPct(entry.price, windowRows),
    returnPct: round(((exitRow.close / entry.price) - 1) * 100, 2),
    status: "closed"
  };
}

function runParameterSweep(signals, priceIndex) {
  const rows = [];

  TAKE_PROFITS.forEach((takeProfitPct) => {
    STOP_LOSSES.forEach((stopLossPct) => {
      EXIT_DAYS.forEach((exitDays) => {
        const trades = signals
          .map((signal) => {
            const priceSet = priceIndex.get(signal.ticker);
            return priceSet ? simulateRule(signal, priceSet, takeProfitPct, stopLossPct, exitDays) : { status: "pending" };
          })
          .filter((trade) => trade.status === "closed");
        const wins = trades.filter((trade) => trade.returnPct > 0).length;
        const avgReturnPct = round(average(trades.map((trade) => trade.returnPct)), 2);
        const avgMaxDrawdownPct = round(average(trades.map((trade) => trade.maxDrawdownPct)), 2);

        rows.push({
          avgMaxDrawdownPct,
          avgReturnPct,
          closedTrades: trades.length,
          combo: `TP${takeProfitPct}_SL${Math.abs(stopLossPct)}_${exitDays}d`,
          exitDays,
          robustnessScore: round((avgReturnPct || 0) + ((percentage(wins, trades.length) || 0) / 10) - Math.abs(avgMaxDrawdownPct || 0) / 2, 3),
          stopLossPct,
          takeProfitPct,
          winRatePct: percentage(wins, trades.length)
        });
      });
    });
  });

  return rows.sort((left, right) => right.robustnessScore - left.robustnessScore);
}

function countSignalsByType(signals) {
  return SIGNAL_TYPES.reduce((summary, type) => {
    summary[type] = signals.filter((signal) => signal.signalType === type).length;
    return summary;
  }, {});
}

function renderMarkdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows
  ].join("\n");
}

function renderSummaryMarkdown({ backtestSummary, config, coverage, generatedAt, parameterSweep, signals }) {
  const signalCounts = countSignalsByType(signals);
  const bestRules = parameterSweep.slice(0, 5);
  const worstRules = [...parameterSweep].sort((left, right) => left.robustnessScore - right.robustnessScore).slice(0, 5);
  const qualityProblems = coverage.filter(
    (item) => item.errors.length || item.startsAfterRequestedStart || item.missingDaysApprox > 65
  );
  const lines = [];

  lines.push("# WALY Historical Research Lab");
  lines.push("");
  lines.push(`Generado: ${generatedAt}`);
  lines.push("Modo: read-only; no opera, no usa IBKR, no usa Binance, no toca memoria real.");
  lines.push("");
  lines.push("## 1. Tickers descargados");
  lines.push(`- ${coverage.filter((item) => item.errors.length === 0).length}/${coverage.length}`);
  lines.push("");
  lines.push("## 2. Cobertura por ticker");
  lines.push(renderMarkdownTable(
    ["Ticker", "First", "Last", "Rows", "Missing aprox", "Errores"],
    coverage.map((item) => `| ${item.ticker} | ${item.firstDate || "n/d"} | ${item.lastDate || "n/d"} | ${item.rows} | ${item.missingDaysApprox} | ${item.errors.length ? item.errors.slice(0, 2).join("; ") : "ok"} |`)
  ));
  lines.push("");
  lines.push("## 3. Senales por tipo");
  Object.entries(signalCounts).forEach(([type, count]) => lines.push(`- ${type}: ${count}`));
  lines.push("");
  lines.push("## 4. Retorno promedio por tipo");
  Object.entries(backtestSummary.byType).forEach(([type, summary]) => {
    lines.push(`- ${type}: 30d avg ${formatPercent(summary.avgReturn30dPct)} | avg DD ${formatPercent(summary.avgMaxDrawdownPct)} | n ${summary.completed30d}`);
  });
  lines.push("");
  lines.push("## 5. Hit rate por horizonte");
  Object.entries(backtestSummary.hitRatesByHorizon).forEach(([horizon, summary]) => {
    lines.push(`- ${horizon}: hit ${formatPercent(summary.hitRatePct)} | avg ${formatPercent(summary.avgReturnPct)} | n ${summary.completed}`);
  });
  lines.push("");
  lines.push("## 6. Max drawdown promedio");
  Object.entries(backtestSummary.byType).forEach(([type, summary]) => {
    lines.push(`- ${type}: ${formatPercent(summary.avgMaxDrawdownPct)}`);
  });
  lines.push("");
  lines.push("## 7. Mejores reglas");
  bestRules.forEach((row) => {
    lines.push(`- ${row.combo}: score ${row.robustnessScore} | avg ${formatPercent(row.avgReturnPct)} | win ${formatPercent(row.winRatePct)} | DD ${formatPercent(row.avgMaxDrawdownPct)} | n ${row.closedTrades}`);
  });
  lines.push("");
  lines.push("## 8. Peores reglas");
  worstRules.forEach((row) => {
    lines.push(`- ${row.combo}: score ${row.robustnessScore} | avg ${formatPercent(row.avgReturnPct)} | win ${formatPercent(row.winRatePct)} | DD ${formatPercent(row.avgMaxDrawdownPct)} | n ${row.closedTrades}`);
  });
  lines.push("");
  lines.push("## 9. Advertencias de sobreajuste");
  lines.push("- Universo chico y elegido a mano: no extrapolar a edge real.");
  lines.push("- Senales retroactivas simples: sirven para falsar ideas, no para declarar ventaja.");
  lines.push("- Muchas combinaciones de parametros sobre la misma muestra elevan riesgo de curve fitting.");
  lines.push("- Sin costos, spreads, liquidez intradia ni slippage.");
  lines.push("- Yahoo daily bars pueden tener ajustes/cambios metodologicos.");
  lines.push("");
  lines.push("## 10. Revision humana");
  if (!qualityProblems.length) {
    lines.push("- Revisar manualmente reglas top antes de incorporarlas a WALY.");
  } else {
    qualityProblems.forEach((item) => {
      const reason = item.errors.length
        ? item.errors[0]
        : item.startsAfterRequestedStart
          ? `historia empieza en ${item.firstDate}, despues de ${config.startDate}`
          : `${item.missingDaysApprox} missing aprox`;
      lines.push(`- ${item.ticker}: cobertura/validacion requiere revision (${reason}).`);
    });
  }
  lines.push("- Nota: missingDays aproximados usa weekdays y puede incluir feriados de mercado.");
  lines.push("");
  lines.push("## Config");
  lines.push(`- startDate: ${config.startDate}`);
  lines.push(`- endDate: ${config.endDate}`);
  lines.push(`- dataProvider: ${config.dataProvider}`);

  return `${lines.join("\n")}\n`;
}

function renderMondayReview({ backtestSummary, parameterSweep }) {
  const best = parameterSweep[0];
  const tp30Sl10 = parameterSweep.find((row) => row.takeProfitPct === 30 && row.stopLossPct === -10 && row.exitDays === 20);
  const lines = [];

  lines.push("# WALY Monday Review - Historical Research");
  lines.push("");
  lines.push("## 5 conclusiones accionables");
  lines.push("- Tratar este lab como research, no como generador de ordenes.");
  lines.push(`- Mejor regla preliminar: ${best ? `${best.combo} con avg ${formatPercent(best.avgReturnPct)} y win ${formatPercent(best.winRatePct)}` : "n/d"}.`);
  lines.push("- Separar resultados por tipo de senal antes de cambiar sizing.");
  lines.push("- Priorizar reglas que sobreviven varios horizontes, no solo una combinacion top.");
  lines.push("- Revisar manualmente outliers que expliquen gran parte del retorno.");
  lines.push("");
  lines.push("## 5 riesgos metodologicos");
  lines.push("- Universo pequeno y sesgado por nombres ya conocidos.");
  lines.push("- Senales definidas despues de conocer la historia.");
  lines.push("- Sin costos, spreads, borrow, halts ni slippage.");
  lines.push("- Salidas TP/SL evaluadas con OHLC diario; no hay secuencia intradia real.");
  lines.push("- Yahoo puede ajustar historicos y cambiar datos fuente.");
  lines.push("");
  lines.push("## Reglas NO adoptar todavia");
  lines.push("- No adoptar reglas optimizadas por una sola combinacion ganadora.");
  lines.push("- No adoptar TP50 si depende de pocos trades.");
  lines.push("- No adoptar stop amplio sin revisar drawdowns por ticker.");
  lines.push("- No usar volume-spike como compra directa sin catalyst.");
  lines.push("");
  lines.push("## Repetir con muestra mas grande");
  lines.push("- Repetir 20d-low-rebound y drawdown-from-52w-high con universo biotech ampliado.");
  lines.push("- Repetir 52w-high-breakout con small/mid caps liquidas fuera de la watchlist actual.");
  lines.push("- Repetir volume-spike separando gaps con noticia verificable vs ruido.");
  lines.push("");
  lines.push("## WALY v3.1 TP30/SL-10/20d");
  if (tp30Sl10) {
    const verdict = tp30Sl10.robustnessScore > 0
      ? "sigue pareciendo razonable como hipotesis, no como regla definitiva"
      : "no queda validado con esta muestra";
    lines.push(`- TP30/SL-10/20d: ${verdict}. Avg ${formatPercent(tp30Sl10.avgReturnPct)}, win ${formatPercent(tp30Sl10.winRatePct)}, DD ${formatPercent(tp30Sl10.avgMaxDrawdownPct)}, n ${tp30Sl10.closedTrades}.`);
  } else {
    lines.push("- TP30/SL-10/20d: no disponible en el sweep.");
  }
  lines.push("");
  lines.push("## Resumen por tipo");
  Object.entries(backtestSummary.byType).forEach(([type, summary]) => {
    lines.push(`- ${type}: 30d avg ${formatPercent(summary.avgReturn30dPct)} | DD ${formatPercent(summary.avgMaxDrawdownPct)} | n ${summary.completed30d}`);
  });

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  const best = result.parameterSweep.slice(0, 3);
  const qualityProblems = result.coverage.filter(
    (item) => item.errors.length || item.startsAfterRequestedStart || item.missingDaysApprox > 65
  );
  const lines = [];

  lines.push("WALY Historical Research Lab generado.");
  lines.push(`Output dir: ${formatRelative(result.paths.outputDir)}`);
  lines.push(`Price dir: ${formatRelative(result.paths.priceOutputDir)}`);
  lines.push(`Signal dir: ${formatRelative(result.paths.signalOutputDir)}`);
  lines.push(`Tickers descargados: ${result.coverage.filter((item) => item.errors.length === 0).length}/${result.coverage.length}`);
  lines.push(`Senales generadas: ${result.signals.length}`);
  lines.push("Top resultados:");
  best.forEach((row) => {
    lines.push(`- ${row.combo}: score ${row.robustnessScore} | avg ${formatPercent(row.avgReturnPct)} | win ${formatPercent(row.winRatePct)} | DD ${formatPercent(row.avgMaxDrawdownPct)}`);
  });
  lines.push("Problemas de calidad:");
  if (!qualityProblems.length) {
    lines.push("- Ninguno fuerte detectado.");
  } else {
    qualityProblems.slice(0, 6).forEach((item) => {
      const reason = item.errors.length
        ? item.errors[0]
        : item.startsAfterRequestedStart
          ? `historia empieza ${item.firstDate}`
          : `${item.missingDaysApprox} missingDays aprox`;
      lines.push(`- ${item.ticker}: ${reason}`);
    });
  }
  lines.push(`coverage.json: ${formatRelative(result.paths.coveragePath)}`);
  lines.push(`generated-signals.json: ${formatRelative(result.paths.generatedSignalsPath)}`);
  lines.push(`backtest-summary.json: ${formatRelative(result.paths.backtestSummaryPath)}`);
  lines.push(`parameter-sweep.json: ${formatRelative(result.paths.parameterSweepPath)}`);
  lines.push(`summary.md: ${formatRelative(result.paths.summaryPath)}`);
  lines.push(`monday-review.md: ${formatRelative(result.paths.mondayReviewPath)}`);
  lines.push("Confirmacion: read-only research; no opera, no IBKR, no Binance, no data/*.json, no outcomes.");

  return lines.join("\n");
}

async function runHistoricalResearchLab(configPathInput) {
  const config = normalizeConfig(configPathInput);
  const priceDataByTicker = {};
  const coverage = [];

  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.mkdirSync(config.priceOutputDir, { recursive: true });
  fs.mkdirSync(config.signalOutputDir, { recursive: true });

  for (const ticker of config.universe) {
    try {
      const rows = await downloadPrices(ticker, config);
      const diagnostics = validatePriceRows(ticker, rows, config);
      const csvPath = path.join(config.priceOutputDir, `${ticker}.csv`);

      writePriceCsv(csvPath, rows);
      priceDataByTicker[ticker] = rows;
      coverage.push({
        ...diagnostics,
        csvPath: formatRelative(csvPath)
      });
    } catch (error) {
      coverage.push({
        csvPath: null,
        errors: [error.message],
        firstDate: null,
        lastDate: null,
        missingDaysApprox: null,
        rows: 0,
        startsAfterRequestedStart: false,
        ticker
      });
      priceDataByTicker[ticker] = [];
    }
  }

  const signals = Object.entries(priceDataByTicker)
    .flatMap(([ticker, rows]) => generateSignalsForTicker(ticker, rows))
    .sort((left, right) => `${left.signalDate}:${left.ticker}:${left.signalType}`.localeCompare(`${right.signalDate}:${right.ticker}:${right.signalType}`));
  const priceIndex = buildPriceIndex(priceDataByTicker);
  const backtestResults = signals.map((signal) => {
    const priceSet = priceIndex.get(signal.ticker);
    const result = priceSet ? runSignalHorizons(signal, priceSet) : { error: "sin precios", horizons: {} };

    return {
      ...signal,
      error: result.error,
      horizons: result.horizons
    };
  });
  const backtestSummary = summarizeBacktest(backtestResults);
  const parameterSweep = runParameterSweep(signals, priceIndex);
  const generatedAt = new Date().toISOString();
  const paths = {
    backtestSummaryPath: path.join(config.outputDir, "backtest-summary.json"),
    coveragePath: path.join(config.outputDir, "coverage.json"),
    generatedSignalsPath: path.join(config.outputDir, "generated-signals.json"),
    mondayReviewPath: path.join(config.outputDir, "monday-review.md"),
    outputDir: config.outputDir,
    parameterSweepPath: path.join(config.outputDir, "parameter-sweep.json"),
    priceOutputDir: config.priceOutputDir,
    signalOutputDir: config.signalOutputDir,
    signalMirrorPath: path.join(config.signalOutputDir, "generated-signals.json"),
    summaryPath: path.join(config.outputDir, "summary.md")
  };
  const signalPayload = {
    generatedAt,
    mode: "read-only-research",
    signalTypes: SIGNAL_TYPES,
    signals
  };
  const result = {
    backtestResults,
    backtestSummary,
    config: {
      dataProvider: config.dataProvider,
      endDate: config.endDate,
      startDate: config.startDate,
      universe: config.universe
    },
    coverage,
    generatedAt,
    parameterSweep,
    paths,
    signals
  };

  writeJsonFile(paths.coveragePath, {
    generatedAt,
    coverage
  });
  writeJsonFile(paths.generatedSignalsPath, signalPayload);
  writeJsonFile(paths.signalMirrorPath, signalPayload);
  writeJsonFile(paths.backtestSummaryPath, {
    generatedAt,
    results: backtestResults,
    summary: backtestSummary
  });
  writeJsonFile(paths.parameterSweepPath, {
    generatedAt,
    combinations: parameterSweep
  });
  writeTextFile(paths.summaryPath, renderSummaryMarkdown(result));
  writeTextFile(paths.mondayReviewPath, renderMondayReview(result));

  return {
    ...result,
    consoleReport: renderConsoleReport(result)
  };
}

module.exports = {
  runHistoricalResearchLab
};
