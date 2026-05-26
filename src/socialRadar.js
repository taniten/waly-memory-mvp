"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, DATA_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "social-radar");
const EXAMPLE_SOURCES_PATH = path.join(EXAMPLES_DIR, "social-sources.example.json");
const EXAMPLE_MENTIONS_PATH = path.join(EXAMPLES_DIR, "social-mentions.example.json");
const WATCHLIST_PATH = path.join(DATA_DIR, "watchlist.json");
const TRACKER_DIR = path.join(BACKTESTS_DIR, "social-source-tracker");
const TRACKER_SOURCES_PATH = path.join(TRACKER_DIR, "sources-scored.json");
const INBOX_DIR = path.join(BACKTESTS_DIR, "social-inbox");
const INBOX_MENTIONS_PATH = path.join(INBOX_DIR, "normalized-mentions.json");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const ACTIONS = ["ignore", "research", "add_to_watchlist", "review_with_waly"];

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

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
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

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function looksLikeHypeWithoutData(mention) {
  const text = `${mention.thesis || ""} ${mention.catalyst || ""} ${mention.notes || ""}`;
  return /moon|rocket|guaranteed|sure thing|x10|100x|pump|hype|sin datos|without data/i.test(text);
}

function looksVerifiable(thesis) {
  return /catalyst|fda|pdufa|earnings|readout|data|liquidity|volume|trial|approval|cash|revenue/i.test(String(thesis || ""));
}

function sourceKey(source) {
  return source.sourceId || source.id || "";
}

function normalizeSourceFromExample(source) {
  return {
    displayName: source.displayName || source.sourceId || "unknown-source",
    finalReliabilityScore: isFiniteNumber(source.reliabilityScore) ? source.reliabilityScore : 0,
    finalStatus: source.status || "unknown",
    handle: source.handle || "",
    noBuyDirect: true,
    platform: source.platform || "other",
    sourceId: source.sourceId || "",
    trackingUse: "discovery/watchlist-only",
    url: source.url || null
  };
}

function normalizeSourceFromTracker(source) {
  return {
    displayName: source.displayName || source.sourceId || "unknown-source",
    finalReliabilityScore: isFiniteNumber(source.finalReliabilityScore) ? source.finalReliabilityScore : source.reliabilityScore || 0,
    finalStatus: source.finalStatus || source.status || "unknown",
    handle: source.handle || "",
    noBuyDirect: true,
    platform: source.platform || "other",
    sourceId: source.sourceId || "",
    trackingUse: source.trackingUse || "discovery/watchlist-only",
    url: source.url || null
  };
}

function normalizeMentionFromExample(mention) {
  return {
    catalyst: mention.catalyst || "",
    catalystDate: mention.catalystDate || null,
    confidence: mention.confidence || "low",
    date: mention.date || null,
    initialPrice: isFiniteNumber(mention.initialPrice) ? mention.initialPrice : null,
    mentionId: mention.mentionId || "",
    notes: mention.notes || "",
    sourceId: mention.sourceId || "",
    thesis: mention.thesis || "",
    ticker: normalizeTicker(mention.ticker),
    url: mention.url || null,
    verdict: mention.verdict || "pending"
  };
}

function normalizeMentionFromTracker(mention) {
  return {
    ...normalizeMentionFromExample(mention),
    mentionScore: mention.mentionScore || null,
    sourceDisplayName: mention.sourceDisplayName || null,
    sourceReliabilityScore: mention.sourceReliabilityScore || null,
    trackingAction: mention.trackingAction || null
  };
}

function normalizeMentionFromInbox(mention) {
  return {
    ...normalizeMentionFromExample(mention),
    inboxErrors: Array.isArray(mention.errors) ? mention.errors : [],
    inboxWarnings: Array.isArray(mention.warnings) ? mention.warnings : [],
    isValidForRadar: mention.isValidForRadar === true,
    reviewStatus: mention.reviewStatus || "pending",
    sourceDisplayName: mention.sourceDisplayName || null
  };
}

function buildSourceIndex(exampleSources, trackerSourcesPayload) {
  const index = new Map();

  exampleSources.forEach((source) => {
    const normalized = normalizeSourceFromExample(source);
    if (normalized.sourceId) {
      index.set(normalized.sourceId, normalized);
    }
  });

  const trackerSources = trackerSourcesPayload && Array.isArray(trackerSourcesPayload.scoredSources)
    ? trackerSourcesPayload.scoredSources
    : [];

  trackerSources.forEach((source) => {
    const normalized = normalizeSourceFromTracker(source);
    if (normalized.sourceId) {
      index.set(normalized.sourceId, normalized);
    }
  });

  return index;
}

function buildMentionListFromExamples(exampleMentions) {
  const byId = new Map();

  exampleMentions.forEach((mention) => {
    const normalized = normalizeMentionFromExample(mention);
    if (normalized.mentionId) {
      byId.set(normalized.mentionId, normalized);
    }
  });

  return [...byId.values()];
}

function buildMentionListFromInbox(inboxPayload) {
  const mentions = inboxPayload && Array.isArray(inboxPayload.normalizedMentions)
    ? inboxPayload.normalizedMentions
    : [];

  return mentions
    .map(normalizeMentionFromInbox)
    .filter((mention) => mention.mentionId);
}

function selectMentionInputs(inboxPayload, exampleMentions) {
  if (inboxPayload && Array.isArray(inboxPayload.normalizedMentions)) {
    return {
      inputMode: "social-inbox",
      inputPath: INBOX_MENTIONS_PATH,
      inputSummary: {
        examplesFallbackMentions: 0,
        socialInboxMentions: inboxPayload.normalizedMentions.length,
        used: "social-inbox"
      },
      mentions: buildMentionListFromInbox(inboxPayload)
    };
  }

  return {
    inputMode: "examples fallback",
    inputPath: EXAMPLE_MENTIONS_PATH,
    inputSummary: {
      examplesFallbackMentions: exampleMentions.length,
      socialInboxMentions: 0,
      used: "examples fallback"
    },
    mentions: buildMentionListFromExamples(exampleMentions)
  };
}

function buildWatchlistIndex(watchlistPayload) {
  const watchlist = Array.isArray(watchlistPayload.watchlist) ? watchlistPayload.watchlist : [];
  return new Map(watchlist.map((item) => [normalizeTicker(item.ticker), item]));
}

function addScore(parts, riskFlags, label, value) {
  if (value >= 0) {
    parts.push({ label, value });
  } else {
    riskFlags.push(label);
    parts.push({ label, value });
  }
}

function scoreMention(mention, source, watchlistIndex) {
  const riskFlags = [];
  const scoreParts = [];
  const sourceStatus = source ? source.finalStatus : "unknown";
  const sourceReliabilityScore = source ? clamp(source.finalReliabilityScore || 0) : 0;
  const watchlistMatch = watchlistIndex.has(mention.ticker);
  const explicitCatalyst = hasText(mention.catalyst);
  const datedCatalyst = hasDate(mention.catalystDate);
  const verifiableThesis = looksVerifiable(mention.thesis);
  const hypeWithoutData = looksLikeHypeWithoutData(mention);
  let socialScore = 0;

  if (mention.isValidForRadar === false && Array.isArray(mention.inboxErrors)) {
    mention.inboxErrors.forEach((error) => riskFlags.push(`inbox: ${error}`));
  }

  if (sourceStatus === "banned") {
    riskFlags.push("fuente banned");
  } else if (sourceStatus === "active") {
    addScore(scoreParts, riskFlags, "fuente active", 15);
    socialScore += 15;
  } else if (sourceStatus === "unknown") {
    addScore(scoreParts, riskFlags, "fuente unknown cap bajo", 5);
    socialScore += 5;
  } else if (sourceStatus === "inactive") {
    addScore(scoreParts, riskFlags, "fuente inactive", -10);
    socialScore -= 10;
  } else if (sourceStatus === "decayed") {
    addScore(scoreParts, riskFlags, "fuente decayed", -30);
    socialScore -= 30;
  }

  const reliabilityBonus = Math.min(25, sourceReliabilityScore * 0.25);
  addScore(scoreParts, riskFlags, "reliability proporcional", round(reliabilityBonus, 1));
  socialScore += reliabilityBonus;

  if (watchlistMatch) {
    addScore(scoreParts, riskFlags, "ticker ya en watchlist", 20);
    socialScore += 20;
  }

  if (explicitCatalyst) {
    addScore(scoreParts, riskFlags, "catalyst explicito", 20);
    socialScore += 20;
  } else {
    addScore(scoreParts, riskFlags, "sin catalyst", -20);
    socialScore -= 20;
  }

  if (datedCatalyst) {
    addScore(scoreParts, riskFlags, "catalyst fechado", 15);
    socialScore += 15;
  }

  if (verifiableThesis) {
    addScore(scoreParts, riskFlags, "tesis verificable", 10);
    socialScore += 10;
  }

  if (mention.confidence === "high") {
    addScore(scoreParts, riskFlags, "confidence high", 10);
    socialScore += 10;
  }

  if (hypeWithoutData) {
    addScore(scoreParts, riskFlags, "hype/promesa sin datos", -30);
    socialScore -= 30;
  }

  if (!isFiniteNumber(mention.initialPrice)) {
    addScore(scoreParts, riskFlags, "sin initialPrice", -10);
    socialScore -= 10;
  }

  if (!hasDate(mention.date)) {
    addScore(scoreParts, riskFlags, "sin date valida", -10);
    socialScore -= 10;
  }

  socialScore = clamp(round(socialScore, 1));

  let suggestedAction = "ignore";
  const catalystVerifiable = explicitCatalyst && datedCatalyst;
  if (mention.isValidForRadar === false) {
    suggestedAction = "ignore";
  } else if (mention.verdict && mention.verdict !== "pending") {
    riskFlags.push(`verdict ${mention.verdict}: auditoria historica, no candidato actual`);
    suggestedAction = "ignore";
  } else if (sourceStatus === "banned") {
    suggestedAction = "ignore";
  } else if (socialScore >= 70 && !["banned", "decayed"].includes(sourceStatus) && catalystVerifiable) {
    suggestedAction = "review_with_waly";
  } else if (socialScore >= 50) {
    suggestedAction = "add_to_watchlist";
  } else if (socialScore >= 30) {
    suggestedAction = "research";
  }

  return {
    ticker: mention.ticker,
    sourceId: mention.sourceId,
    displayName: source ? source.displayName : mention.sourceDisplayName || "unknown-source",
    platform: source ? source.platform : "other",
    sourceReliabilityScore: round(sourceReliabilityScore, 1),
    sourceStatus,
    date: mention.date,
    thesis: mention.thesis,
    catalyst: mention.catalyst,
    catalystDate: mention.catalystDate,
    initialPrice: mention.initialPrice,
    confidence: mention.confidence,
    url: mention.url || (source ? source.url : null),
    watchlistMatch,
    noBuyDirect: true,
    suggestedAction,
    socialScore,
    riskFlags,
    audit: {
      catalystVerifiable,
      mentionId: mention.mentionId,
      scoreParts,
      sourceTrackingUse: source ? source.trackingUse : "unknown"
    }
  };
}

function countBy(items, fieldName) {
  return items.reduce((counts, item) => {
    const key = item[fieldName] === true ? "true" : item[fieldName] === false ? "false" : item[fieldName] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function renderRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function renderSummary({ generatedAt, inputSummary, mentions, sources }) {
  const ranked = [...mentions].sort((left, right) =>
    right.socialScore - left.socialScore ||
    left.ticker.localeCompare(right.ticker) ||
    left.displayName.localeCompare(right.displayName)
  );
  const watchlistMatches = ranked.filter((mention) => mention.watchlistMatch);
  const newResearch = ranked.filter((mention) => !mention.watchlistMatch && ["research", "add_to_watchlist", "review_with_waly"].includes(mention.suggestedAction));
  const discarded = ranked.filter((mention) => mention.suggestedAction === "ignore");
  const usefulSources = [...sources.values()]
    .filter((source) => source.finalStatus !== "banned")
    .sort((left, right) => (right.finalReliabilityScore || 0) - (left.finalReliabilityScore || 0))
    .slice(0, 10);
  const lines = [];

  lines.push("# WALY Social Radar");
  lines.push("");
  lines.push(`Generado: ${generatedAt}`);
  lines.push("Modo: read-only local; no red, no scraping, no login, no paywalls, no opera.");
  lines.push("");
  lines.push("## 1. Total de menciones evaluadas");
  lines.push(`- Input usado: ${inputSummary.used}`);
  lines.push(`- Menciones desde social-inbox: ${inputSummary.socialInboxMentions}`);
  lines.push(`- Menciones desde examples fallback: ${inputSummary.examplesFallbackMentions}`);
  lines.push(`- Total: ${mentions.length}`);
  lines.push(`- review_with_waly: ${mentions.filter((item) => item.suggestedAction === "review_with_waly").length}`);
  lines.push(`- add_to_watchlist: ${mentions.filter((item) => item.suggestedAction === "add_to_watchlist").length}`);
  lines.push(`- research: ${mentions.filter((item) => item.suggestedAction === "research").length}`);
  lines.push(`- ignore: ${discarded.length}`);
  lines.push("");
  lines.push("## 2. Ranking de menciones por socialScore");
  lines.push("| Ticker | Fuente | Status | Watchlist | Score | Accion | Flags |");
  lines.push("|---|---|---|---|---:|---|---|");
  ranked.forEach((mention) => {
    lines.push(renderRow([
      mention.ticker,
      mention.displayName,
      mention.sourceStatus,
      mention.watchlistMatch ? "si" : "no",
      formatScore(mention.socialScore),
      mention.suggestedAction,
      mention.riskFlags.length ? mention.riskFlags.join("; ") : "ok"
    ]));
  });
  lines.push("");
  lines.push("## 3. Tickers que ya estan en watchlist");
  if (!watchlistMatches.length) {
    lines.push("- Ninguna mencion coincide con watchlist actual.");
  } else {
    watchlistMatches.forEach((mention) => {
      lines.push(`- ${mention.ticker}: ${mention.displayName} | score ${formatScore(mention.socialScore)} | ${mention.suggestedAction}`);
    });
  }
  lines.push("");
  lines.push("## 4. Tickers nuevos sugeridos para research");
  if (!newResearch.length) {
    lines.push("- Ningun ticker nuevo supera umbral de research.");
  } else {
    newResearch.forEach((mention) => {
      lines.push(`- ${mention.ticker}: ${mention.displayName} | score ${formatScore(mention.socialScore)} | ${mention.suggestedAction}`);
    });
  }
  lines.push("");
  lines.push("## 5. Fuentes mas utiles");
  usefulSources.forEach((source) => {
    lines.push(`- ${source.displayName}: ${source.finalStatus} | score ${formatScore(source.finalReliabilityScore)} | ${source.trackingUse}`);
  });
  lines.push("");
  lines.push("## 6. Menciones descartadas");
  if (!discarded.length) {
    lines.push("- Ninguna descartada.");
  } else {
    discarded.forEach((mention) => {
      lines.push(`- ${mention.ticker}: ${mention.displayName} | score ${formatScore(mention.socialScore)} | ${mention.riskFlags.join("; ") || "score bajo"}`);
    });
  }
  lines.push("");
  lines.push("## 7. Advertencia");
  lines.push("- Social Radar no compra, no opera y no genera ordenes.");
  lines.push("- Social solo propone revision/discovery; WALY exige catalyst verificable, precio, volumen, liquidez, riesgo y decision manual.");
  lines.push("- Ninguna fuente social puede generar BUY directo.");

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  const top = result.mentions.filter((mention) => mention.suggestedAction !== "ignore").slice(0, 3).map((mention) =>
    `${mention.ticker}:${mention.suggestedAction}:${formatScore(mention.socialScore)}`
  );

  return [
    "WALY Social Radar generado.",
    `Input usado: ${result.inputSummary.used} | inbox=${result.inputSummary.socialInboxMentions} | examples=${result.inputSummary.examplesFallbackMentions}`,
    `Menciones evaluadas: ${result.mentions.length}`,
    `Acciones: ${ACTIONS.map((action) => `${action}=${result.actionCounts[action] || 0}`).join(" | ")}`,
    `Watchlist matches: ${result.watchlistMatchCounts.true || 0}`,
    `Top sociales: ${top.length ? top.join(" | ") : "ninguno"}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no red, no scraping, no IBKR, no Binance, no data/social_signals.json."
  ].join("\n");
}

function runSocialRadar() {
  const sourcesPayload = readJson(EXAMPLE_SOURCES_PATH);
  const mentionsPayload = readJson(EXAMPLE_MENTIONS_PATH);
  const watchlistPayload = readJson(WATCHLIST_PATH);
  const trackerSourcesPayload = readJsonIfExists(TRACKER_SOURCES_PATH);
  const inboxPayload = readJsonIfExists(INBOX_MENTIONS_PATH);
  const sourceIndex = buildSourceIndex(sourcesPayload.sources || [], trackerSourcesPayload);
  const mentionSelection = selectMentionInputs(inboxPayload, mentionsPayload.mentions || []);
  const mentionInputs = mentionSelection.mentions;
  const watchlistIndex = buildWatchlistIndex(watchlistPayload);
  const generatedAt = new Date().toISOString();
  const mentions = mentionInputs
    .map((mention) => scoreMention(mention, sourceIndex.get(mention.sourceId), watchlistIndex))
    .sort((left, right) =>
      right.socialScore - left.socialScore ||
      left.ticker.localeCompare(right.ticker) ||
      left.displayName.localeCompare(right.displayName)
    );
  const actionCounts = countBy(mentions, "suggestedAction");
  const watchlistMatchCounts = countBy(mentions, "watchlistMatch");
  const payload = {
    generatedAt,
    inputs: {
      fallbackMentionsPath: formatRelative(EXAMPLE_MENTIONS_PATH),
      mentionsPath: formatRelative(mentionSelection.inputPath),
      mentionsSource: mentionSelection.inputMode,
      optionalSocialInboxPath: fs.existsSync(INBOX_MENTIONS_PATH) ? formatRelative(INBOX_MENTIONS_PATH) : null,
      optionalTrackerSourcesPath: fs.existsSync(TRACKER_SOURCES_PATH) ? formatRelative(TRACKER_SOURCES_PATH) : null,
      sourcesPath: formatRelative(EXAMPLE_SOURCES_PATH),
      watchlistPath: formatRelative(WATCHLIST_PATH)
    },
    mode: "read-only-local",
    notes: [
      "No opera.",
      "No usa red.",
      "No scraping, no login, no paywalls.",
      "No toca positions, outcomes ni data/social_signals.json.",
      "Social Radar solo propone discovery/revision."
    ],
    actionCounts,
    inputSummary: mentionSelection.inputSummary,
    mentions,
    watchlistMatchCounts
  };
  const markdown = renderSummary({
    generatedAt,
    inputSummary: mentionSelection.inputSummary,
    mentions,
    sources: sourceIndex
  });

  writeJson(LATEST_PATH, payload);
  writeText(SUMMARY_PATH, markdown);

  return {
    ...payload,
    consoleReport: renderConsoleReport({
      actionCounts,
      inputSummary: mentionSelection.inputSummary,
      mentions,
      watchlistMatchCounts
    }),
    paths: {
      latestPath: LATEST_PATH,
      outputDir: OUTPUT_DIR,
      summaryPath: SUMMARY_PATH
    }
  };
}

module.exports = {
  runSocialRadar
};
