"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "social-source-tracker");
const SOURCES_PATH = path.join(EXAMPLES_DIR, "social-sources.example.json");
const MENTIONS_PATH = path.join(EXAMPLES_DIR, "social-mentions.example.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const SOURCES_SCORED_PATH = path.join(OUTPUT_DIR, "sources-scored.json");
const MENTIONS_SCORED_PATH = path.join(OUTPUT_DIR, "mentions-scored.json");
const PLATFORMS = new Set(["X", "Reddit", "Substack", "forum", "other"]);
const SPECIALTIES = new Set(["biotech", "smallcap", "options", "macro", "crypto", "undervalued", "catalyst", "other"]);
const STATUSES = ["active", "inactive", "decayed", "banned", "unknown"];
const CONFIDENCE = new Set(["low", "medium", "high"]);
const VERDICTS = new Set(["hit", "miss", "pending", "invalid"]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Falta ${formatRelative(filePath)}.`);
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

function clamp(value, min = 0, max = 100) {
  if (!isFiniteNumber(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatScore(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return round(value, 1).toFixed(1);
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(left, right) {
  if (!left || !right) {
    return null;
  }

  return Math.floor((right.getTime() - left.getTime()) / 86400000);
}

function normalizeSource(source) {
  const sourceId = typeof source.sourceId === "string" ? source.sourceId.trim() : "";
  const platform = PLATFORMS.has(source.platform) ? source.platform : "other";
  const specialty = SPECIALTIES.has(source.specialty) ? source.specialty : "other";
  const status = STATUSES.includes(source.status) ? source.status : "unknown";

  return {
    sourceId,
    displayName: source.displayName || sourceId || "unknown-source",
    platform,
    handle: source.handle || "",
    url: source.url || null,
    specialty,
    reliabilityScore: clamp(source.reliabilityScore, 0, 100),
    status,
    firstSeen: source.firstSeen || null,
    lastSeen: source.lastSeen || null,
    notes: source.notes || "",
    historicalHits: Number.isInteger(source.historicalHits) ? Math.max(0, source.historicalHits) : 0,
    historicalMisses: Number.isInteger(source.historicalMisses) ? Math.max(0, source.historicalMisses) : 0,
    pendingMentions: Number.isInteger(source.pendingMentions) ? Math.max(0, source.pendingMentions) : 0
  };
}

function normalizeMention(mention) {
  const verdict = VERDICTS.has(mention.verdict) ? mention.verdict : "invalid";
  const confidence = CONFIDENCE.has(mention.confidence) ? mention.confidence : "low";

  return {
    mentionId: mention.mentionId || "",
    sourceId: mention.sourceId || "",
    ticker: normalizeTicker(mention.ticker),
    date: mention.date || null,
    initialPrice: isFiniteNumber(mention.initialPrice) ? mention.initialPrice : null,
    thesis: mention.thesis || "",
    catalyst: mention.catalyst || "",
    catalystDate: mention.catalystDate || null,
    confidence,
    url: mention.url || null,
    result7d: isFiniteNumber(mention.result7d) ? mention.result7d : null,
    result30d: isFiniteNumber(mention.result30d) ? mention.result30d : null,
    result90d: isFiniteNumber(mention.result90d) ? mention.result90d : null,
    maxDrawdown: isFiniteNumber(mention.maxDrawdown) ? mention.maxDrawdown : null,
    verdict,
    notes: mention.notes || ""
  };
}

function isStrongMiss(mention) {
  return mention.verdict === "miss" && (
    (isFiniteNumber(mention.result30d) && mention.result30d <= -15) ||
    (isFiniteNumber(mention.result90d) && mention.result90d <= -25) ||
    (isFiniteNumber(mention.maxDrawdown) && mention.maxDrawdown <= -25)
  );
}

function lacksCatalyst(mention) {
  return !mention.catalyst || mention.catalyst.trim().length === 0;
}

function looksLikePumpOrFalseClaim(text) {
  return /false claim|claim falso|claims falsos|pump evidente|pump|fraud|banned/i.test(String(text || ""));
}

function scoreMention(mention, source) {
  let score = 10;
  const blockers = [];
  const reasons = [];

  if (mention.verdict === "hit") {
    score += 35;
    reasons.push("hit validado");
  } else if (mention.verdict === "miss") {
    score -= isStrongMiss(mention) ? 25 : 12;
    blockers.push(isStrongMiss(mention) ? "miss fuerte" : "miss");
  } else if (mention.verdict === "pending") {
    score += 5;
    reasons.push("mencion pendiente");
  } else {
    score = 0;
    blockers.push("mencion invalida");
  }

  if (!lacksCatalyst(mention)) {
    score += 10;
    reasons.push("incluye catalyst para revisar");
  } else if (mention.confidence === "high") {
    score -= 20;
    blockers.push("alta confianza sin catalyst");
  }

  if (isFiniteNumber(mention.result30d) && mention.result30d >= 15) {
    score += 12;
    reasons.push("resultado 30d fuerte");
  }

  if (isFiniteNumber(mention.maxDrawdown) && mention.maxDrawdown <= -25) {
    score -= 10;
    blockers.push("drawdown alto");
  }

  return {
    ...mention,
    blockers,
    noBuyDirect: true,
    reasons,
    sourceDisplayName: source ? source.displayName : "unknown-source",
    sourceReliabilityScore: source ? source.finalReliabilityScore : null,
    trackingAction: mention.verdict === "pending" ? "watchlist-discovery-only" : "audit-history-only",
    mentionScore: clamp(round(score, 1))
  };
}

function scoreSource(source, mentions, currentDate) {
  const sourceMentions = mentions.filter((mention) => mention.sourceId === source.sourceId);
  const mentionHits = sourceMentions.filter((mention) => mention.verdict === "hit").length;
  const mentionMisses = sourceMentions.filter((mention) => mention.verdict === "miss").length;
  const hits = Math.max(source.historicalHits, mentionHits);
  const misses = Math.max(source.historicalMisses, mentionMisses);
  const pendingMentions = Math.max(source.pendingMentions, sourceMentions.filter((mention) => mention.verdict === "pending").length);
  const strongMisses = sourceMentions.filter(isStrongMiss).length;
  const hypeWithoutCatalyst = sourceMentions.filter((mention) => mention.confidence === "high" && lacksCatalyst(mention)).length;
  const falseClaimOrPump =
    looksLikePumpOrFalseClaim(source.notes) ||
    sourceMentions.some((mention) => mention.verdict === "invalid" && looksLikePumpOrFalseClaim(mention.notes));
  const lastSeenDate = parseDate(source.lastSeen);
  const inactiveDays = daysBetween(lastSeenDate, currentDate);
  const isNewSource = hits === 0 && misses === 0;
  const scoreParts = [];
  let score = source.reliabilityScore;

  score += hits * 8;
  score -= misses * 9;
  score -= strongMisses * 8;
  score -= hypeWithoutCatalyst * 15;
  score += Math.min(pendingMentions, 3) * 1;

  if (hits > 0) {
    scoreParts.push(`hits validados +${hits * 8}`);
  }

  if (misses > 0) {
    scoreParts.push(`misses -${misses * 9}`);
  }

  if (strongMisses > 0) {
    scoreParts.push(`misses fuertes extra -${strongMisses * 8}`);
  }

  if (hypeWithoutCatalyst > 0) {
    scoreParts.push(`hype sin catalyst -${hypeWithoutCatalyst * 15}`);
  }

  if (isNewSource) {
    score = Math.min(score, 50);
    scoreParts.push("fuente nueva cap 50");
  }

  let finalStatus = source.status;
  if (falseClaimOrPump || source.status === "banned") {
    finalStatus = "banned";
    score = Math.min(score, 5);
    scoreParts.push("banned por claims falsos/pump");
  } else if (isFiniteNumber(inactiveDays) && inactiveDays > 90) {
    finalStatus = "inactive";
    score = Math.min(score, 45);
    scoreParts.push(`inactiva ${inactiveDays} dias`);
  } else if (source.status === "decayed" || strongMisses >= 3 || hypeWithoutCatalyst > 0) {
    finalStatus = "decayed";
    score = Math.min(score, 40);
    scoreParts.push("decay por misses/hype");
  } else if (isNewSource) {
    finalStatus = "unknown";
  } else if (source.status === "active" || score >= 55) {
    finalStatus = "active";
  } else {
    finalStatus = "unknown";
  }

  return {
    ...source,
    finalReliabilityScore: clamp(round(score, 1)),
    finalStatus,
    inactiveDays,
    metrics: {
      falseClaimOrPump,
      hits,
      hypeWithoutCatalyst,
      isNewSource,
      misses,
      pendingMentions,
      strongMisses,
      trackedMentions: sourceMentions.length
    },
    noBuyDirect: true,
    scoreParts,
    trackingUse: finalStatus === "banned" ? "exclude" : "discovery/watchlist-only"
  };
}

function countBy(items, fieldName) {
  return items.reduce((counts, item) => {
    const key = item[fieldName] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function renderTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function renderSummary({ generatedAt, pendingMentions, scoredMentions, scoredSources, sourcesByStatus, watchSources }) {
  const lines = [];
  const rankedSources = [...scoredSources].sort((left, right) =>
    right.finalReliabilityScore - left.finalReliabilityScore ||
    left.displayName.localeCompare(right.displayName)
  );
  const activeSources = scoredSources.filter((source) => source.finalStatus === "active");
  const decayedInactive = scoredSources.filter((source) => ["decayed", "inactive", "banned"].includes(source.finalStatus));

  lines.push("# WALY Social Source Tracker");
  lines.push("");
  lines.push(`Generado: ${generatedAt}`);
  lines.push("Modo: read-only local; no red, no scraping, no login, no paywalls, no opera.");
  lines.push("");
  lines.push("## 1. Fuentes por status");
  STATUSES.forEach((status) => {
    lines.push(`- ${status}: ${sourcesByStatus[status] || 0}`);
  });
  lines.push("");
  lines.push("## 2. Ranking por reliabilityScore");
  lines.push("| Fuente | Plataforma | Specialty | Status | Score | Uso |");
  lines.push("|---|---|---|---|---:|---|");
  rankedSources.forEach((source) => {
    lines.push(renderTableRow([
      source.displayName,
      source.platform,
      source.specialty,
      source.finalStatus,
      formatScore(source.finalReliabilityScore),
      source.trackingUse
    ]));
  });
  lines.push("");
  lines.push("## 3. Fuentes activas");
  if (activeSources.length === 0) {
    lines.push("- Ninguna fuente activa con historial suficiente.");
  } else {
    activeSources.forEach((source) => {
      lines.push(`- ${source.displayName}: score ${formatScore(source.finalReliabilityScore)} | ${source.specialty} | ${source.trackingUse}`);
    });
  }
  lines.push("");
  lines.push("## 4. Fuentes decayed/inactive/banned");
  if (decayedInactive.length === 0) {
    lines.push("- Ninguna.");
  } else {
    decayedInactive.forEach((source) => {
      lines.push(`- ${source.displayName}: ${source.finalStatus} | score ${formatScore(source.finalReliabilityScore)} | ${source.scoreParts.join("; ") || "sin detalle"}`);
    });
  }
  lines.push("");
  lines.push("## 5. Menciones pendientes");
  if (pendingMentions.length === 0) {
    lines.push("- Sin menciones pendientes.");
  } else {
    pendingMentions.forEach((mention) => {
      lines.push(`- ${mention.ticker} | ${mention.sourceDisplayName} | ${mention.date} | ${mention.confidence} | ${mention.trackingAction}`);
    });
  }
  lines.push("");
  lines.push("## 6. Fuentes que merecen seguimiento");
  if (watchSources.length === 0) {
    lines.push("- Ninguna fuente merece seguimiento activo todavia.");
  } else {
    watchSources.forEach((source) => {
      lines.push(`- ${source.displayName}: ${source.finalStatus} | score ${formatScore(source.finalReliabilityScore)} | revisar solo como discovery.`);
    });
  }
  lines.push("");
  lines.push("## 7. Advertencia");
  lines.push("- social = discovery, no senal operativa.");
  lines.push("- Ninguna fuente social puede generar BUY directo.");
  lines.push("- KrakenStockResearch queda como ejemplo manual inicial, no como fuente confiable automatica.");
  lines.push("- Para operar, WALY sigue exigiendo catalyst verificable, precio, volumen, liquidez, riesgo y decision manual.");
  lines.push("");
  lines.push("## Auditoria de menciones");
  lines.push(`- Menciones evaluadas: ${scoredMentions.length}`);
  lines.push(`- Pendientes: ${pendingMentions.length}`);

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  return [
    "WALY Social Source Tracker generado.",
    `Fuentes evaluadas: ${result.scoredSources.length}`,
    `Menciones evaluadas: ${result.scoredMentions.length}`,
    `Status: ${STATUSES.map((status) => `${status}=${result.sourcesByStatus[status] || 0}`).join(" | ")}`,
    `Top fuente: ${result.topSource ? `${result.topSource.displayName} (${formatScore(result.topSource.finalReliabilityScore)})` : "n/d"}`,
    `KrakenStockResearch: ${result.kraken ? `${result.kraken.finalStatus} | score ${formatScore(result.kraken.finalReliabilityScore)} | ${result.kraken.trackingUse}` : "no encontrado"}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    `sources-scored.json: ${formatRelative(SOURCES_SCORED_PATH)}`,
    `mentions-scored.json: ${formatRelative(MENTIONS_SCORED_PATH)}`,
    "Confirmacion: no operacion, no red, no IBKR, no Binance, no data/social_signals.json."
  ].join("\n");
}

function runSocialSourceTracker() {
  const sourcePayload = readJson(SOURCES_PATH);
  const mentionPayload = readJson(MENTIONS_PATH);
  const sources = (Array.isArray(sourcePayload.sources) ? sourcePayload.sources : []).map(normalizeSource);
  const mentions = (Array.isArray(mentionPayload.mentions) ? mentionPayload.mentions : []).map(normalizeMention);
  const generatedAt = new Date().toISOString();
  const currentDate = new Date(`${generatedAt.slice(0, 10)}T00:00:00Z`);
  const scoredSources = sources
    .map((source) => scoreSource(source, mentions, currentDate))
    .sort((left, right) =>
      right.finalReliabilityScore - left.finalReliabilityScore ||
      left.displayName.localeCompare(right.displayName)
    );
  const sourceById = new Map(scoredSources.map((source) => [source.sourceId, source]));
  const scoredMentions = mentions
    .map((mention) => scoreMention(mention, sourceById.get(mention.sourceId)))
    .sort((left, right) =>
      (right.mentionScore || 0) - (left.mentionScore || 0) ||
      left.sourceDisplayName.localeCompare(right.sourceDisplayName) ||
      left.ticker.localeCompare(right.ticker)
    );
  const pendingMentions = scoredMentions.filter((mention) => mention.verdict === "pending");
  const sourcesByStatus = countBy(scoredSources, "finalStatus");
  const watchSources = scoredSources.filter((source) =>
    source.finalStatus !== "banned" &&
    source.finalReliabilityScore >= 45 &&
    source.metrics.pendingMentions > 0
  );
  const topSource = scoredSources[0] || null;
  const kraken = scoredSources.find((source) => source.displayName.toLowerCase() === "krakenstockresearch") || null;
  const sourceOutput = {
    generatedAt,
    inputs: {
      mentionsPath: formatRelative(MENTIONS_PATH),
      sourcesPath: formatRelative(SOURCES_PATH)
    },
    mode: "read-only-local",
    notes: [
      "No opera.",
      "No usa red.",
      "No scraping, no login, no paywalls.",
      "No toca data/social_signals.json.",
      "Social solo suma a discovery/watchlist."
    ],
    scoredSources,
    sourcesByStatus,
    watchSources: watchSources.map((source) => source.sourceId)
  };
  const mentionOutput = {
    generatedAt,
    inputs: {
      mentionsPath: formatRelative(MENTIONS_PATH),
      sourcesPath: formatRelative(SOURCES_PATH)
    },
    mode: "read-only-local",
    scoredMentions
  };
  const markdown = renderSummary({
    generatedAt,
    pendingMentions,
    scoredMentions,
    scoredSources,
    sourcesByStatus,
    watchSources
  });

  writeJson(SOURCES_SCORED_PATH, sourceOutput);
  writeJson(MENTIONS_SCORED_PATH, mentionOutput);
  writeText(SUMMARY_PATH, markdown);

  return {
    consoleReport: renderConsoleReport({
      kraken,
      scoredMentions,
      scoredSources,
      sourcesByStatus,
      topSource
    }),
    kraken,
    paths: {
      mentionsScoredPath: MENTIONS_SCORED_PATH,
      outputDir: OUTPUT_DIR,
      sourcesScoredPath: SOURCES_SCORED_PATH,
      summaryPath: SUMMARY_PATH
    },
    scoredMentions,
    scoredSources,
    sourcesByStatus,
    topSource,
    watchSources
  };
}

module.exports = {
  runSocialSourceTracker
};
