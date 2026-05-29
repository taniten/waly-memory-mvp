"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "forward-snapshots");
const PIPELINE_PATH = path.join(BACKTESTS_DIR, "7-pillars", "waly-pipeline-latest.json");
const SELECTOR_PATH = path.join(BACKTESTS_DIR, "selector-engine", "latest.json");
const DAILY_COCKPIT_PATH = path.join(BACKTESTS_DIR, "daily-cockpit", "latest.json");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SNAPSHOTS_PATH = path.join(OUTPUT_DIR, "snapshots.jsonl");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");

function assertForwardOutput(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("forward-snapshot-log solo puede escribir dentro de backtests/forward-snapshots/.");
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Falta ${formatRelative(filePath)}. Corre daily-cockpit, selector-engine y waly-pipeline primero.`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSON invalido en ${formatRelative(filePath)}: ${error.message}`);
    }

    throw error;
  }
}

function writeJson(filePath, value) {
  assertForwardOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  assertForwardOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function appendJsonLine(filePath, value) {
  assertForwardOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
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

function sameArray(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => item === right[index]);
}

function hashObject(value) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 12);
}

function sortStrings(values) {
  return [...(values || [])].map(String).sort((left, right) => left.localeCompare(right));
}

function indexByTicker(rows = []) {
  const index = new Map();

  rows.forEach((row) => {
    const ticker = normalizeTicker(row && row.ticker);
    if (ticker && !index.has(ticker)) {
      index.set(ticker, row);
    }
  });

  return index;
}

function dailyMarketIndex(dailyCockpit) {
  const rows = [];
  const marketData = dailyCockpit && dailyCockpit.marketData || {};

  Object.entries(marketData).forEach(([ticker, row]) => {
    rows.push({ ...(row || {}), ticker });
  });

  return indexByTicker(rows);
}

function firstNumber(...values) {
  return values.find((value) => isFiniteNumber(value));
}

function normalizeRankingRow({ dailyRow, pipelineRow, selectorRow }) {
  const ticker = normalizeTicker(
    (pipelineRow && pipelineRow.ticker) ||
    (selectorRow && selectorRow.ticker) ||
    (dailyRow && dailyRow.ticker)
  );
  const pipelineSizing = pipelineRow && pipelineRow.sizing || null;

  return {
    actionSuggested: (
      (pipelineRow && (pipelineRow.pipelineAction || pipelineRow.actionSuggested)) ||
      (selectorRow && selectorRow.actionSuggested) ||
      null
    ),
    classification: (
      (pipelineRow && (pipelineRow.pipelineClassification || pipelineRow.classification)) ||
      (selectorRow && selectorRow.classification) ||
      null
    ),
    dollarVolume: round(firstNumber(
      pipelineRow && pipelineRow.marketData && pipelineRow.marketData.dollarVolume,
      selectorRow && selectorRow.marketData && selectorRow.marketData.dollarVolume,
      dailyRow && dailyRow.dollarVolume
    ), 2),
    missingData: [
      ...((pipelineRow && pipelineRow.missingData) || []),
      ...((selectorRow && selectorRow.missingData) || [])
    ],
    noBuyDirect: true,
    outcomeStatus: "pending",
    price: round(firstNumber(
      pipelineRow && pipelineRow.marketData && pipelineRow.marketData.price,
      selectorRow && selectorRow.marketData && selectorRow.marketData.price,
      dailyRow && (dailyRow.price || dailyRow.lastPrice)
    ), 4),
    redFlags: [
      ...((pipelineRow && pipelineRow.pipelineRedFlags) || []),
      ...((pipelineRow && pipelineRow.redFlags) || []),
      ...((selectorRow && selectorRow.redFlags) || [])
    ],
    relVol: round(firstNumber(
      pipelineRow && pipelineRow.marketData && pipelineRow.marketData.relativeVolume,
      selectorRow && selectorRow.marketData && selectorRow.marketData.relativeVolume,
      dailyRow && dailyRow.relativeVolume
    ), 3),
    safeToOperate: false,
    selectorScore: round(firstNumber(
      pipelineRow && pipelineRow.totalScore,
      selectorRow && selectorRow.totalScore
    ), 1),
    sizingSuggested: pipelineSizing
      ? {
        action: pipelineSizing.sizingAction || null,
        shares: pipelineSizing.suggestedShares || 0,
        usd: pipelineSizing.suggestedSizeUSD || 0
      }
      : null,
    ticker
  };
}

function sizingIndex(pipeline) {
  return indexByTicker((pipeline && pipeline.sizing && pipeline.sizing.rows) || []);
}

function buildRanking({ dailyCockpit, pipeline, selector }) {
  const dailyByTicker = dailyMarketIndex(dailyCockpit);
  const selectorByTicker = indexByTicker((selector && selector.ranking) || []);
  const sizingByTicker = sizingIndex(pipeline);

  return ((pipeline && pipeline.selectorRanking) || [])
    .map((row) => normalizeRankingRow({
      dailyRow: dailyByTicker.get(normalizeTicker(row.ticker)),
      pipelineRow: {
        ...row,
        sizing: sizingByTicker.get(normalizeTicker(row.ticker)) || null
      },
      selectorRow: selectorByTicker.get(normalizeTicker(row.ticker))
    }))
    .filter((row) => row.ticker)
    .map((row) => ({
      ...row,
      missingData: [...new Set(row.missingData)].sort(),
      redFlags: [...new Set(row.redFlags)].sort()
    }));
}

function snapshotDate(createdAt, dailyCockpit, selector) {
  return (
    (dailyCockpit && dailyCockpit.currentDate) ||
    (selector && selector.currentDate) ||
    createdAt.slice(0, 10)
  );
}

function signatureForSnapshot(snapshot) {
  return {
    decisionFinal: snapshot.decisionFinal,
    manualCandidates: sortStrings(snapshot.manualCandidates),
    operables: sortStrings(snapshot.operables),
    prices: snapshot.ranking.map((row) => [row.ticker, row.price]),
    ranking: snapshot.ranking.map((row) => [
      row.ticker,
      row.selectorScore,
      row.classification,
      row.actionSuggested,
      row.relVol
    ])
  };
}

function buildSnapshot({ dailyCockpit, pipeline, selector }) {
  const createdAt = new Date().toISOString();
  const ranking = buildRanking({ dailyCockpit, pipeline, selector });
  const decision = pipeline && pipeline.decision || {};
  const snapshotBase = {
    createdAt,
    date: snapshotDate(createdAt, dailyCockpit, selector),
    decisionFinal: pipeline.decisionFinal || decision.finalAction || "missingData",
    healthStatus: pipeline.healthStatus || "missingData",
    manualCandidates: sortStrings(decision.manualCandidates || []),
    mode: pipeline.mode || "production",
    noBuyDirect: true,
    operables: sortStrings(decision.operables || []),
    outcomeStatus: "pending",
    ranking,
    safeToOperate: false
  };
  const signature = signatureForSnapshot(snapshotBase);
  const snapshotId = `forward-${snapshotBase.date}-${hashObject(signature)}`;

  return {
    ...snapshotBase,
    inputs: {
      dailyCockpitPath: formatRelative(DAILY_COCKPIT_PATH),
      pipelinePath: formatRelative(PIPELINE_PATH),
      selectorPath: formatRelative(SELECTOR_PATH)
    },
    missingData: [...new Set([
      ...((pipeline && pipeline.missingData) || []),
      ...ranking.flatMap((row) => row.missingData.map((item) => `${row.ticker}: ${item}`))
    ])].sort(),
    redFlags: [...new Set([
      ...((pipeline && pipeline.redFlags) || []),
      ...ranking.flatMap((row) => row.redFlags.map((item) => `${row.ticker}: ${item}`))
    ])].sort(),
    snapshotId,
    signature
  };
}

function readSnapshots() {
  try {
    const raw = fs.readFileSync(SNAPSHOTS_PATH, "utf8").trim();
    if (!raw) {
      return [];
    }

    return raw.split(/\r?\n/).map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }

    if (error instanceof SyntaxError) {
      throw new Error(`JSONL invalido en ${formatRelative(SNAPSHOTS_PATH)}: ${error.message}`);
    }

    throw error;
  }
}

function priceChangedMoreThan2Pct(current, previous) {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous) || previous === 0) {
    return current !== previous;
  }

  return Math.abs((current - previous) / previous) > 0.02;
}

function relVolChanged(current, previous) {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous)) {
    return current !== previous;
  }

  return Math.abs(current - previous) >= 0.25 || Math.abs(current - previous) / Math.max(previous, 0.01) >= 0.25;
}

function rankingChanged(current, previous) {
  if (current.length !== previous.length) {
    return true;
  }

  const previousByTicker = indexByTicker(previous);

  return current.some((row, index) => {
    const old = previousByTicker.get(row.ticker);
    if (!old) {
      return true;
    }

    return (
      previous[index].ticker !== row.ticker ||
      Math.abs((row.selectorScore || 0) - (old.selectorScore || 0)) >= 0.1 ||
      row.classification !== old.classification ||
      row.actionSuggested !== old.actionSuggested
    );
  });
}

function relevantPriceOrRelVolChanged(current, previous) {
  const previousByTicker = indexByTicker(previous.ranking || []);
  const relevantTickers = new Set([
    ...(current.operables || []),
    ...(current.manualCandidates || []),
    ...current.ranking.slice(0, 5).map((row) => row.ticker)
  ]);

  return current.ranking.some((row) => {
    if (!relevantTickers.has(row.ticker)) {
      return false;
    }

    const old = previousByTicker.get(row.ticker);
    return !old || priceChangedMoreThan2Pct(row.price, old.price) || relVolChanged(row.relVol, old.relVol);
  });
}

function shouldAppendSnapshot(snapshot, snapshots) {
  const sameDay = snapshots.filter((item) => item.date === snapshot.date);
  const exactDuplicate = sameDay.find((item) =>
    item.decisionFinal === snapshot.decisionFinal &&
    JSON.stringify(item.signature && item.signature.prices) === JSON.stringify(snapshot.signature.prices)
  );

  if (exactDuplicate && JSON.stringify(exactDuplicate.signature) === JSON.stringify(snapshot.signature)) {
    return {
      append: false,
      reason: `snapshot duplicado del dia ${snapshot.date}`,
      snapshot: exactDuplicate
    };
  }

  if (!sameDay.length) {
    return {
      append: true,
      reason: "primer snapshot del dia"
    };
  }

  const latestSameDay = sameDay[sameDay.length - 1];
  const changed =
    latestSameDay.decisionFinal !== snapshot.decisionFinal ||
    !sameArray(sortStrings(latestSameDay.operables), snapshot.operables) ||
    !sameArray(sortStrings(latestSameDay.manualCandidates), snapshot.manualCandidates) ||
    rankingChanged(snapshot.ranking, latestSameDay.ranking || []) ||
    relevantPriceOrRelVolChanged(snapshot, latestSameDay);

  return {
    append: changed,
    reason: changed ? "cambio relevante intradia" : `sin cambio relevante el ${snapshot.date}`,
    snapshot: changed ? null : latestSameDay
  };
}

function renderRanking(rows) {
  if (!rows.length) {
    return "- Ninguno.";
  }

  return rows.slice(0, 5).map((row, index) =>
    `${index + 1}. ${row.ticker}: ${row.classification || "n/d"} | score ${row.selectorScore === null ? "n/d" : row.selectorScore} | ${row.actionSuggested || "n/d"} | price ${row.price === null ? "n/d" : row.price}`
  ).join("\n");
}

function renderSummary({ latestSnapshot, snapshots, writeDecision }) {
  const activeTickers = latestSnapshot.ranking
    .filter((row) => ["mantener", "vigilar", "revisar_manual", "candidato_manual"].includes(row.actionSuggested))
    .map((row) => row.ticker);
  const lines = [];

  lines.push("# WALY Forward Signal Snapshot Logger");
  lines.push("");
  lines.push(`Snapshots guardados: ${snapshots.length}`);
  lines.push(`Ultimo snapshot: ${latestSnapshot.snapshotId}`);
  lines.push(`Fecha: ${latestSnapshot.date}`);
  lines.push(`Decision final: ${latestSnapshot.decisionFinal}`);
  lines.push(`Health: ${latestSnapshot.healthStatus}`);
  lines.push(`Write decision: ${writeDecision.reason}`);
  lines.push("");
  lines.push("## Ranking top 5");
  lines.push(renderRanking(latestSnapshot.ranking));
  lines.push("");
  lines.push("## Tickers activos");
  lines.push(activeTickers.length ? `- ${[...new Set(activeTickers)].join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## Falta para validar edge");
  lines.push("- Acumular snapshots forward con outcomes futuros resueltos.");
  lines.push("- Comparar top ranking contra retornos 7d/30d/60d/90d sin editar senales pasadas.");
  lines.push("- Medir hit-rate, drawdown y dispersion por classification/actionSuggested.");
  lines.push("- Separar cambios intradia de cambios reales de tesis.");
  lines.push("");
  lines.push("## Advertencia");
  lines.push("- Forward snapshots no prueban edge hasta tener resultados futuros.");
  lines.push("- Research-only: no opera, no usa IBKR, no usa Binance y no escribe outcomes.");

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport({ latestSnapshot, snapshots, writeDecision }) {
  const top = latestSnapshot.ranking.slice(0, 5).map((row) =>
    `${row.ticker}:${row.selectorScore === null ? "n/d" : row.selectorScore}:${row.classification || "n/d"}`
  );

  return [
    "WALY Forward Snapshot Logger generado.",
    `Snapshot: ${latestSnapshot.snapshotId}`,
    `Write decision: ${writeDecision.append ? "appended" : "skipped"} | ${writeDecision.reason}`,
    `Decision final: ${latestSnapshot.decisionFinal}`,
    `Health: ${latestSnapshot.healthStatus}`,
    `Ranking guardado: ${top.join(" | ") || "ninguno"}`,
    `Snapshots totales: ${snapshots.length}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `snapshots.jsonl: ${formatRelative(SNAPSHOTS_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no ordenes, no outcomes, no data/*.json."
  ].join("\n");
}

function runForwardSnapshotLog() {
  const pipeline = readJson(PIPELINE_PATH);
  const selector = readJson(SELECTOR_PATH);
  const dailyCockpit = readJson(DAILY_COCKPIT_PATH);
  const snapshotsBefore = readSnapshots();
  const candidateSnapshot = buildSnapshot({ dailyCockpit, pipeline, selector });
  const writeDecision = shouldAppendSnapshot(candidateSnapshot, snapshotsBefore);
  const latestSnapshot = writeDecision.append ? candidateSnapshot : writeDecision.snapshot;
  const snapshots = writeDecision.append ? snapshotsBefore.concat(candidateSnapshot) : snapshotsBefore;

  if (writeDecision.append) {
    appendJsonLine(SNAPSHOTS_PATH, candidateSnapshot);
  }

  writeJson(LATEST_PATH, latestSnapshot);
  writeText(SUMMARY_PATH, renderSummary({
    latestSnapshot,
    snapshots,
    writeDecision
  }));

  return {
    latestSnapshot,
    paths: {
      latestPath: LATEST_PATH,
      outputDir: OUTPUT_DIR,
      snapshotsPath: SNAPSHOTS_PATH,
      summaryPath: SUMMARY_PATH
    },
    snapshotAppended: writeDecision.append,
    snapshots,
    writeDecision,
    consoleReport: renderConsoleReport({
      latestSnapshot,
      snapshots,
      writeDecision
    })
  };
}

module.exports = {
  buildSnapshot,
  runForwardSnapshotLog
};
