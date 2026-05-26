"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const RESEARCH_DIR = path.join(BACKTESTS_DIR, "historical-research");
const OUTPUT_DIR = path.join(RESEARCH_DIR, "v3-2-signal-quality");
const GENERATED_SIGNALS_PATH = path.join(RESEARCH_DIR, "generated-signals.json");
const SIGNAL_TYPE_ANALYSIS_PATH = path.join(RESEARCH_DIR, "signal-type-analysis.json");
const PARAMETER_SWEEP_PATH = path.join(RESEARCH_DIR, "parameter-sweep.json");
const CATEGORIES = ["A_candidate", "B_watch", "C_research_only", "discard"];
const SIGNAL_TYPES = ["volume-spike", "drawdown-from-52w-high", "20d-low-rebound", "52w-high-breakout"];
const BIOTECH_CATALYST_TICKERS = new Set([
  "ACHV",
  "ALNY",
  "ARDX",
  "AXSM",
  "BBIO",
  "BEAM",
  "BNTX",
  "COGT",
  "CRSP",
  "CYTK",
  "DNLI",
  "EDIT",
  "FOLD",
  "IMVT",
  "IOVA",
  "KURA",
  "MNKD",
  "MRNA",
  "NBIX",
  "NTLA",
  "OCS",
  "RARE",
  "RCKT",
  "RVMD",
  "RXRX",
  "SRPT",
  "TGTX",
  "VERA",
  "VKTX",
  "VRDN"
]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Falta ${formatRelative(filePath)}. Ejecuta primero historical-research-lab y signal-type-analysis.`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${formatRelative(filePath)}: ${error.message}`);
    }

    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
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

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${value > 0 ? "+" : ""}${round(value, 1).toFixed(1)}%`;
}

function formatMoney(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `$${round(value, 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function classifyUniverse(ticker) {
  return BIOTECH_CATALYST_TICKERS.has(ticker) ? "biotech-catalyst-proxy" : "non-biotech";
}

function lookupPrice(signal, priceLookup) {
  const details = signal.details || {};
  const directClose = details.close;

  if (isFiniteNumber(directClose)) {
    return directClose;
  }

  return priceLookup.get(`${normalizeTicker(signal.ticker)}|${signal.signalDate}`) || null;
}

function estimateDollarVolume(signal, priceLookup) {
  const details = signal.details || {};
  const close = lookupPrice(signal, priceLookup);

  if (!isFiniteNumber(details.avgVolume20) || !isFiniteNumber(close)) {
    return null;
  }

  return details.avgVolume20 * close;
}

function hasSameDayVolumeSpike(signal, signalKeys) {
  return signalKeys.has(`${signal.ticker}|${signal.signalDate}|volume-spike`);
}

function baseSignalRecord(signal, priceLookup) {
  const ticker = normalizeTicker(signal.ticker);
  const details = signal.details || {};
  const close = lookupPrice({ ...signal, ticker }, priceLookup);

  return {
    catalystProxy: classifyUniverse(ticker) === "biotech-catalyst-proxy",
    close,
    dayReturnPct: isFiniteNumber(details.dayReturnPct) ? details.dayReturnPct : null,
    dollarVolumeProxy: estimateDollarVolume({ ...signal, ticker }, priceLookup),
    drawdownFrom52wHighPct: isFiniteNumber(details.drawdownFrom52wHighPct) ? details.drawdownFrom52wHighPct : null,
    reboundFromLowPct: isFiniteNumber(details.reboundFromLowPct) ? details.reboundFromLowPct : null,
    relativeVolume: isFiniteNumber(details.relativeVolume) ? details.relativeVolume : null,
    relativeVolume50: isFiniteNumber(details.relativeVolume50) ? details.relativeVolume50 : null,
    signalDate: signal.signalDate,
    signalType: signal.signalType,
    sourceKind: signal.sourceKind,
    ticker,
    universeSegment: classifyUniverse(ticker)
  };
}

function scoreVolumeSpike(signal, priceLookup) {
  const record = baseSignalRecord(signal, priceLookup);
  const reasons = [];
  const blockers = [];
  let score = 45;

  if (record.catalystProxy) {
    score += 12;
    reasons.push("ticker en universo biotech/catalyst proxy");
  } else {
    blockers.push("sin catalyst proxy");
  }

  if (isFiniteNumber(record.dollarVolumeProxy) && record.dollarVolumeProxy >= 10000000) {
    score += 14;
    reasons.push(`liquidez proxy >= 10M (${formatMoney(record.dollarVolumeProxy)})`);
  } else {
    score -= 14;
    blockers.push("liquidez proxy insuficiente o no disponible");
  }

  if (isFiniteNumber(record.relativeVolume) && record.relativeVolume >= 2 && record.relativeVolume <= 6) {
    score += 14;
    reasons.push(`relativeVolume saludable ${record.relativeVolume}`);
  } else if (isFiniteNumber(record.relativeVolume) && record.relativeVolume > 6) {
    score -= 16;
    blockers.push(`movimiento potencialmente parabolico relVol ${record.relativeVolume}`);
  } else {
    score -= 10;
    blockers.push("relativeVolume insuficiente");
  }

  if (isFiniteNumber(record.dayReturnPct) && Math.abs(record.dayReturnPct) >= 3 && Math.abs(record.dayReturnPct) <= 18) {
    score += 10;
    reasons.push(`movimiento no parabolico ${formatPercent(record.dayReturnPct)}`);
  } else if (isFiniteNumber(record.dayReturnPct) && Math.abs(record.dayReturnPct) > 18) {
    score -= 12;
    blockers.push(`day move parabolico ${formatPercent(record.dayReturnPct)}`);
  } else {
    score -= 6;
    blockers.push("day move debil");
  }

  let category = "C_research_only";
  if (score >= 75 && blockers.length === 0) {
    category = "A_candidate";
  } else if (score >= 55) {
    category = "B_watch";
  }

  return {
    ...record,
    blockers,
    category,
    reasons,
    score: Math.max(0, Math.min(100, round(score, 1)))
  };
}

function scoreDrawdown(signal, priceLookup) {
  const record = baseSignalRecord(signal, priceLookup);
  const reasons = ["drawdown-from-52w-high nunca es A directo"];
  const blockers = [];
  let score = 36;

  if (record.catalystProxy) {
    score += 8;
    reasons.push("ticker en universo biotech/catalyst proxy");
  }

  if (isFiniteNumber(record.drawdownFrom52wHighPct)) {
    if (record.drawdownFrom52wHighPct <= -75) {
      score -= 18;
      blockers.push(`drawdown extremo ${formatPercent(record.drawdownFrom52wHighPct)}`);
    } else if (record.drawdownFrom52wHighPct <= -55) {
      score -= 8;
      blockers.push(`drawdown alto ${formatPercent(record.drawdownFrom52wHighPct)}`);
    } else {
      score += 8;
      reasons.push(`drawdown manejable ${formatPercent(record.drawdownFrom52wHighPct)}`);
    }
  } else {
    score -= 10;
    blockers.push("sin drawdown medible");
  }

  score += 8;
  reasons.push("rebote y volumen son inferidos por regla generadora, no catalyst verificado");

  let category = "C_research_only";
  if (score >= 52 && blockers.length <= 1) {
    category = "B_watch";
  }
  if (score < 25) {
    category = "discard";
  }

  return {
    ...record,
    blockers,
    category,
    reasons,
    score: Math.max(0, Math.min(100, round(score, 1)))
  };
}

function scoreLowRebound(signal, signalKeys, priceLookup) {
  const record = baseSignalRecord(signal, priceLookup);
  const confirmedByVolumeSpike = hasSameDayVolumeSpike(record, signalKeys);
  const reasons = [];
  const blockers = [];
  let score = 28;

  if (isFiniteNumber(record.reboundFromLowPct) && record.reboundFromLowPct >= 4) {
    score += 8;
    reasons.push(`rebote desde low20 ${formatPercent(record.reboundFromLowPct)}`);
  } else {
    blockers.push("rebote debil o no medible");
  }

  if (confirmedByVolumeSpike) {
    score += 20;
    reasons.push("confirmacion por volume-spike mismo ticker/fecha");
  } else {
    score -= 8;
    blockers.push("sin confirmacion de volumen");
  }

  if (record.catalystProxy) {
    score += 6;
    reasons.push("ticker en universo biotech/catalyst proxy");
  }

  let category = confirmedByVolumeSpike && score >= 50 ? "B_watch" : "C_research_only";
  if (score < 20) {
    category = "discard";
  }

  return {
    ...record,
    blockers,
    category,
    reasons,
    score: Math.max(0, Math.min(100, round(score, 1)))
  };
}

function scoreBreakout(signal, priceLookup) {
  const record = baseSignalRecord(signal, priceLookup);
  const reasons = [];
  const blockers = [];
  let score = 24;

  if (isFiniteNumber(record.relativeVolume50) && record.relativeVolume50 >= 2) {
    score += 20;
    reasons.push(`volumen institucional proxy relVol50 ${record.relativeVolume50}`);
  } else if (isFiniteNumber(record.relativeVolume50) && record.relativeVolume50 >= 1.5) {
    score += 10;
    reasons.push(`volumen superior a promedio relVol50 ${record.relativeVolume50}`);
  } else {
    score -= 8;
    blockers.push("sin volumen institucional claro");
  }

  if (record.catalystProxy) {
    score += 4;
  }

  const category = score >= 45 && blockers.length === 0 ? "B_watch" : "C_research_only";

  return {
    ...record,
    blockers,
    category,
    reasons,
    score: Math.max(0, Math.min(100, round(score, 1)))
  };
}

function scoreSignal(signal, signalKeys, priceLookup) {
  switch (signal.signalType) {
    case "volume-spike":
      return scoreVolumeSpike(signal, priceLookup);
    case "drawdown-from-52w-high":
      return scoreDrawdown(signal, priceLookup);
    case "20d-low-rebound":
      return scoreLowRebound(signal, signalKeys, priceLookup);
    case "52w-high-breakout":
      return scoreBreakout(signal, priceLookup);
    default:
      return {
        ...baseSignalRecord(signal, priceLookup),
        blockers: ["signalType desconocido"],
        category: "discard",
        reasons: [],
        score: 0
      };
  }
}

function countBy(items, fieldName) {
  return items.reduce((counts, item) => {
    const key = item[fieldName] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function countByCategoryAndSignalType(scoredSignals) {
  return scoredSignals.reduce((counts, signal) => {
    const signalType = signal.signalType || "unknown";
    counts[signalType] = counts[signalType] || {};
    counts[signalType][signal.category] = (counts[signalType][signal.category] || 0) + 1;
    return counts;
  }, {});
}

function buildPriceLookup(signals) {
  return signals.reduce((lookup, signal) => {
    const details = signal.details || {};
    if (isFiniteNumber(details.close)) {
      lookup.set(`${normalizeTicker(signal.ticker)}|${signal.signalDate}`, details.close);
    }
    return lookup;
  }, new Map());
}

function countFilterHits(scoredSignals) {
  const filters = {};

  scoredSignals.forEach((signal) => {
    signal.blockers.forEach((blocker) => {
      filters[blocker] = (filters[blocker] || 0) + 1;
    });
  });

  return Object.entries(filters)
    .map(([filter, count]) => ({ count, filter }))
    .sort((left, right) => right.count - left.count || left.filter.localeCompare(right.filter));
}

function summarizeSignalTypeAnalysis(signalTypeAnalysis) {
  return (signalTypeAnalysis.signalTypes || []).reduce((summary, item) => {
    summary[item.signalType] = {
      bestRule: item.bestRule,
      verdict: item.verdict,
      walyFit: item.walyFit
    };
    return summary;
  }, {});
}

function decideWalyRules(parameterSweep, scoredSignals) {
  const globalTop = (parameterSweep.combinations || [])[0] || null;
  const aCandidates = scoredSignals.filter((signal) => signal.category === "A_candidate");
  const bWatch = scoredSignals.filter((signal) => signal.category === "B_watch");

  if (aCandidates.length === 0 && bWatch.length === 0) {
    return "mantener TP30/SL-10/20d solo como regla defensiva; falta calidad para ampliar riesgo";
  }

  if (globalTop && globalTop.takeProfitPct === 50 && Math.abs(globalTop.stopLossPct) >= 15 && globalTop.exitDays === 60) {
    return "usar reglas distintas por tipo: TP30/SL-10/20d defensivo para watch, TP50/SL15-20/60d solo research con filtros fuertes";
  }

  return "usar reglas distintas por tipo de senal; no hay una unica regla robusta";
}

function renderSummary({ filterHits, generatedAt, parameterSweep, scoredSignals, signalTypeFindings, summary, walyRuleDecision }) {
  const lines = [];
  const topA = scoredSignals
    .filter((signal) => signal.category === "A_candidate")
    .sort((left, right) => right.score - left.score || left.ticker.localeCompare(right.ticker))
    .slice(0, 25);

  lines.push("# WALY Signal Quality Gate v3.2");
  lines.push("");
  lines.push(`Generado: ${generatedAt}`);
  lines.push("Modo: research-only; no opera, no usa red, no toca memoria operativa.");
  lines.push("");
  lines.push("## 1. Cantidad por categoria");
  CATEGORIES.forEach((category) => {
    lines.push(`- ${category}: ${summary.byCategory[category] || 0}`);
  });
  lines.push("");
  lines.push("## 2. Cantidad por tipo de senal");
  SIGNAL_TYPES.forEach((signalType) => {
    lines.push(`- ${signalType}: ${summary.bySignalType[signalType] || 0}`);
  });
  lines.push("");
  lines.push("## 3. Top senales A_candidate");
  if (!topA.length) {
    lines.push("- Ninguna. El gate exige catalyst proxy, liquidez y movimiento no parabolico.");
  } else {
    topA.forEach((signal) => {
      lines.push(
        `- ${signal.ticker} ${signal.signalDate} ${signal.signalType} | score ${signal.score} | relVol ${signal.relativeVolume || "n/d"} | dollarProxy ${formatMoney(signal.dollarVolumeProxy)}`
      );
    });
  }
  lines.push("");
  lines.push("## 4. Filtros que eliminaron mas ruido");
  filterHits.slice(0, 10).forEach((item) => {
    lines.push(`- ${item.filter}: ${item.count}`);
  });
  lines.push("");
  lines.push("## 5. Reglas WALY v3.2");
  lines.push(`- Decision: ${walyRuleDecision}`);
  if (parameterSweep.combinations && parameterSweep.combinations[0]) {
    const top = parameterSweep.combinations[0];
    lines.push(
      `- Mejor regla global research: ${top.combo} | avg ${formatPercent(top.avgReturnPct)} | win ${formatPercent(top.winRatePct)} | DD ${formatPercent(top.avgMaxDrawdownPct)}`
    );
  }
  Object.entries(signalTypeFindings).forEach(([signalType, finding]) => {
    const best = finding.bestRule;
    lines.push(
      `- ${signalType}: ${finding.verdict || "n/d"} | fit ${finding.walyFit || "n/d"}${best ? ` | best proxy ${best.combo}` : ""}`
    );
  });
  lines.push("");
  lines.push("## 6. Advertencia de sobreajuste");
  lines.push("- Este gate esta calibrado sobre el mismo universo expandido del research lab.");
  lines.push("- Catalyst proxy por ticker no equivale a catalyst verificado en fecha de senal.");
  lines.push("- Liquidez proxy usa datos disponibles en la senal; no reemplaza dollar volume real del dia para todos los tipos.");
  lines.push("- No incluir estas categorias en outcomes ni win rate operativo hasta validacion forward.");

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  return [
    "WALY Signal Quality Gate v3.2 generado.",
    `Output dir: ${formatRelative(OUTPUT_DIR)}`,
    `Scored signals: ${result.scoredSignals.length}`,
    `Categorias: ${CATEGORIES.map((category) => `${category}=${result.summary.byCategory[category] || 0}`).join(" | ")}`,
    `Tipos: ${SIGNAL_TYPES.map((signalType) => `${signalType}=${result.summary.bySignalType[signalType] || 0}`).join(" | ")}`,
    `Decision WALY v3.2: ${result.walyRuleDecision}`,
    `scored-signals.json: ${formatRelative(result.paths.scoredSignalsPath)}`,
    `summary.md: ${formatRelative(result.paths.summaryPath)}`,
    "Confirmacion: research-only; no opera, no red, no data/*.json, no outcomes."
  ].join("\n");
}

function runSignalQualityGate() {
  const generatedSignals = readJson(GENERATED_SIGNALS_PATH);
  const signalTypeAnalysis = readJson(SIGNAL_TYPE_ANALYSIS_PATH);
  const parameterSweep = readJson(PARAMETER_SWEEP_PATH);
  const signals = Array.isArray(generatedSignals.signals) ? generatedSignals.signals : [];
  const signalKeys = new Set(
    signals.map((signal) => `${normalizeTicker(signal.ticker)}|${signal.signalDate}|${signal.signalType}`)
  );
  const priceLookup = buildPriceLookup(signals);
  const scoredSignals = signals
    .map((signal) => scoreSignal(signal, signalKeys, priceLookup))
    .sort((left, right) =>
      CATEGORIES.indexOf(left.category) - CATEGORIES.indexOf(right.category) ||
      right.score - left.score ||
      `${left.ticker}:${left.signalDate}:${left.signalType}`.localeCompare(`${right.ticker}:${right.signalDate}:${right.signalType}`)
    );
  const filterHits = countFilterHits(scoredSignals);
  const summary = {
    byCategory: countBy(scoredSignals, "category"),
    byCategoryAndSignalType: countByCategoryAndSignalType(scoredSignals),
    bySignalType: countBy(scoredSignals, "signalType"),
    byUniverseSegment: countBy(scoredSignals, "universeSegment")
  };
  const signalTypeFindings = summarizeSignalTypeAnalysis(signalTypeAnalysis);
  const walyRuleDecision = decideWalyRules(parameterSweep, scoredSignals);
  const generatedAt = new Date().toISOString();
  const paths = {
    outputDir: OUTPUT_DIR,
    scoredSignalsPath: path.join(OUTPUT_DIR, "scored-signals.json"),
    summaryPath: path.join(OUTPUT_DIR, "summary.md")
  };
  const payload = {
    generatedAt,
    mode: "research-only",
    inputs: {
      generatedSignalsPath: formatRelative(GENERATED_SIGNALS_PATH),
      parameterSweepPath: formatRelative(PARAMETER_SWEEP_PATH),
      signalTypeAnalysisPath: formatRelative(SIGNAL_TYPE_ANALYSIS_PATH)
    },
    notes: [
      "No opera.",
      "No usa red.",
      "No toca data/*.json, positions ni outcomes.",
      "Catalyst proxy es inferencia por universo, no catalyst verificado."
    ],
    scoredSignals,
    signalTypeFindings,
    summary,
    topFilters: filterHits.slice(0, 20),
    walyRuleDecision
  };
  const markdown = renderSummary({
    filterHits,
    generatedAt,
    parameterSweep,
    scoredSignals,
    signalTypeFindings,
    summary,
    walyRuleDecision
  });

  writeJson(paths.scoredSignalsPath, payload);
  writeText(paths.summaryPath, markdown);

  return {
    ...payload,
    consoleReport: renderConsoleReport({
      paths,
      scoredSignals,
      summary,
      walyRuleDecision
    }),
    paths
  };
}

module.exports = {
  runSignalQualityGate
};
