"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, DATA_DIR } = require("./storage");
const {
  buildRealTickerSet,
  productionAllowsTicker,
  resolveRuntimeMode,
  shouldUseDemoExamples
} = require("./runtimeMode");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXAMPLES_DIR = path.join(ROOT_DIR, "examples");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "social-inbox");
const INBOX_PATH = path.join(EXAMPLES_DIR, "social-inbox.example.json");
const SOURCES_PATH = path.join(EXAMPLES_DIR, "social-sources.example.json");
const EXISTING_MENTIONS_PATH = path.join(EXAMPLES_DIR, "social-mentions.example.json");
const POSITIONS_PATH = path.join(DATA_DIR, "positions.json");
const WATCHLIST_PATH = path.join(DATA_DIR, "watchlist.json");
const NORMALIZED_PATH = path.join(OUTPUT_DIR, "normalized-mentions.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

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

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function looksLikeHypeWithoutData(entry) {
  const text = `${entry.rawText || ""} ${entry.thesis || ""}`;
  const hype = /100x|10x|moon|rocket|guaranteed|sure thing|do not miss|next nvda|pump/i.test(text);
  const dataWords = /catalyst|fda|pdufa|earnings|readout|trial|volume|liquidity|cash|revenue|guidance|filing/i.test(text);
  return hype && !dataWords;
}

function buildSourceIndex(sourcesPayload) {
  return new Map(
    (sourcesPayload.sources || [])
      .filter((source) => hasText(source.sourceId))
      .map((source) => [source.sourceId, source])
  );
}

function buildExistingMentionIds(existingMentionsPayload) {
  return new Set(
    ((existingMentionsPayload && existingMentionsPayload.mentions) || [])
      .map((mention) => mention.mentionId)
      .filter(hasText)
  );
}

function readRealTickerInputs() {
  return {
    positions: readJsonIfExists(POSITIONS_PATH) || { positions: [] },
    watchlist: readJsonIfExists(WATCHLIST_PATH) || { watchlist: [] }
  };
}

function selectInboxEntries({ entries, mode, realTickers, useExamples }) {
  if (mode === "demo" || useExamples) {
    return entries.filter((entry) =>
      mode === "demo" || productionAllowsTicker(entry.ticker, realTickers)
    );
  }

  return [];
}

function makeMentionId(entry, index, existingIds) {
  const baseParts = [
    entry.sourceId || "unknown-source",
    normalizeTicker(entry.ticker) || "unknown-ticker",
    entry.date || "no-date",
    String(index + 1).padStart(3, "0")
  ];
  let mentionId = `inbox-${baseParts.join("-")}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  let suffix = 2;

  while (existingIds.has(mentionId)) {
    mentionId = `${mentionId}-${suffix}`;
    suffix += 1;
  }

  existingIds.add(mentionId);
  return mentionId;
}

function validateEntry(entry, sourceIndex) {
  const errors = [];
  const warnings = [];
  const ticker = normalizeTicker(entry.ticker);

  if (!ticker) {
    errors.push("ticker faltante");
  }

  if (!isValidDate(entry.date)) {
    errors.push("fecha faltante");
  }

  if (!isFiniteNumber(entry.observedPrice)) {
    errors.push("precio faltante");
  }

  if (!hasText(entry.catalyst)) {
    errors.push("sin catalyst");
  }

  if (!hasText(entry.sourceId) || !sourceIndex.has(entry.sourceId)) {
    errors.push("fuente no registrada");
  }

  if (looksLikeHypeWithoutData(entry)) {
    errors.push("texto demasiado hype sin datos");
  }

  if (entry.catalystDate && !isValidDate(entry.catalystDate)) {
    warnings.push("catalystDate invalida");
  }

  if (!VALID_CONFIDENCE.has(entry.confidence)) {
    warnings.push("confidence invalida; normalizada a low");
  }

  return {
    errors,
    warnings
  };
}

function normalizeEntry(entry, index, sourceIndex, existingIds) {
  const validation = validateEntry(entry, sourceIndex);
  const source = sourceIndex.get(entry.sourceId) || null;
  const confidence = VALID_CONFIDENCE.has(entry.confidence) ? entry.confidence : "low";
  const ticker = normalizeTicker(entry.ticker);
  const mentionId = makeMentionId(entry, index, existingIds);

  return {
    mentionId,
    ticker,
    sourceId: entry.sourceId || "",
    sourceDisplayName: source ? source.displayName : null,
    platform: entry.platform || (source && source.platform) || "other",
    handle: entry.handle || (source && source.handle) || "",
    date: isValidDate(entry.date) ? entry.date : null,
    initialPrice: isFiniteNumber(entry.observedPrice) ? entry.observedPrice : null,
    thesis: entry.thesis || "",
    catalyst: entry.catalyst || "",
    catalystDate: isValidDate(entry.catalystDate) ? entry.catalystDate : null,
    confidence,
    url: entry.url || null,
    rawText: entry.rawText || "",
    notes: entry.notes || "",
    noBuyDirect: true,
    reviewStatus: "pending",
    verdict: "pending",
    errors: validation.errors,
    warnings: validation.warnings,
    isValidForRadar: validation.errors.length === 0
  };
}

function countBy(items, fieldName) {
  return items.reduce((counts, item) => {
    const key = item[fieldName] === true ? "true" : item[fieldName] === false ? "false" : item[fieldName] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function collectErrorCounts(normalizedMentions) {
  return normalizedMentions.reduce((counts, mention) => {
    mention.errors.forEach((error) => {
      counts[error] = (counts[error] || 0) + 1;
    });
    mention.warnings.forEach((warning) => {
      counts[warning] = (counts[warning] || 0) + 1;
    });
    return counts;
  }, {});
}

function renderRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function renderSummary({ errorCounts, generatedAt, mode, normalizedMentions, sourceCounts, sourceMode }) {
  const valid = normalizedMentions.filter((mention) => mention.isValidForRadar);
  const invalid = normalizedMentions.filter((mention) => !mention.isValidForRadar);
  const lines = [];

  lines.push("# WALY Social Inbox");
  lines.push("");
  lines.push(`Generado: ${generatedAt}`);
  lines.push(`Modo: ${mode}; input: ${sourceMode}; no red, no scraping, no login, no paywalls, no opera.`);
  lines.push("");
  lines.push("## 1. Resumen");
  lines.push(`- Entradas leidas: ${normalizedMentions.length}`);
  lines.push(`- Normalizadas validas para radar: ${valid.length}`);
  lines.push(`- Con errores: ${invalid.length}`);
  lines.push(`- Fuentes registradas usadas: ${Object.keys(sourceCounts).length}`);
  lines.push("");
  lines.push("## 2. Menciones normalizadas");
  lines.push("| MentionId | Ticker | Fuente | Fecha | Precio | Confidence | Valida | Errores |");
  lines.push("|---|---|---|---|---:|---|---|---|");
  normalizedMentions.forEach((mention) => {
    lines.push(renderRow([
      mention.mentionId,
      mention.ticker || "n/d",
      mention.sourceDisplayName || mention.sourceId || "n/d",
      mention.date || "n/d",
      mention.initialPrice === null ? "n/d" : String(mention.initialPrice),
      mention.confidence,
      mention.isValidForRadar ? "si" : "no",
      mention.errors.concat(mention.warnings).join("; ") || "ok"
    ]));
  });
  lines.push("");
  lines.push("## 3. Errores detectados");
  if (Object.keys(errorCounts).length === 0) {
    lines.push("- Ninguno.");
  } else {
    Object.entries(errorCounts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .forEach(([error, count]) => {
        lines.push(`- ${error}: ${count}`);
      });
  }
  lines.push("");
  lines.push("## 4. Uso permitido");
  lines.push("- Estas menciones quedan como pending y no generan BUY directo.");
  lines.push("- Para usar una mencion real, copiar el formato a un archivo privado local o promover manualmente a un flujo aprobado.");
  lines.push("- Social Inbox no escribe data/social_signals.json.");
  lines.push("- social = discovery; la decision exige catalyst, precio, volumen, liquidez, riesgo y revision WALY.");

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  const errors = Object.entries(result.errorCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([error, count]) => `${error}=${count}`)
    .join(" | ");

  return [
    "WALY Social Inbox generado.",
    `Mode: ${result.mode} | input=${result.sourceMode}`,
    `Entradas leidas: ${result.normalizedMentions.length}`,
    `Validas para radar: ${result.summary.validForRadar}`,
    `Con errores: ${result.summary.invalidForRadar}`,
    `Errores: ${errors || "ninguno"}`,
    `normalized-mentions.json: ${formatRelative(NORMALIZED_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no red, no scraping, no IBKR, no Binance, no data/social_signals.json."
  ].join("\n");
}

function runSocialInbox(options = {}) {
  const mode = resolveRuntimeMode(options);
  const useExamples = shouldUseDemoExamples(options);
  const inboxPayload = readJson(INBOX_PATH);
  const sourcesPayload = readJson(SOURCES_PATH);
  const existingMentionsPayload = readJsonIfExists(EXISTING_MENTIONS_PATH);
  const realTickerInputs = readRealTickerInputs();
  const realTickers = buildRealTickerSet(realTickerInputs);
  const sourceIndex = buildSourceIndex(sourcesPayload);
  const existingIds = buildExistingMentionIds(existingMentionsPayload);
  const rawEntries = Array.isArray(inboxPayload.entries) ? inboxPayload.entries : [];
  const entries = selectInboxEntries({
    entries: rawEntries,
    mode,
    realTickers,
    useExamples
  });
  const sourceMode = mode === "demo"
    ? "demo examples"
    : useExamples
      ? "explicit examples fallback"
      : "production real-data only";
  const generatedAt = new Date().toISOString();
  const normalizedMentions = entries.map((entry, index) => normalizeEntry(entry, index, sourceIndex, existingIds));
  const errorCounts = collectErrorCounts(normalizedMentions);
  const sourceCounts = countBy(normalizedMentions, "sourceId");
  const summary = {
    invalidForRadar: normalizedMentions.filter((mention) => !mention.isValidForRadar).length,
    validForRadar: normalizedMentions.filter((mention) => mention.isValidForRadar).length
  };
  const payload = {
    generatedAt,
    inputs: {
      inboxPath: formatRelative(INBOX_PATH),
      optionalExistingMentionsPath: fs.existsSync(EXISTING_MENTIONS_PATH) ? formatRelative(EXISTING_MENTIONS_PATH) : null,
      positionsPath: formatRelative(POSITIONS_PATH),
      sourcesPath: formatRelative(SOURCES_PATH),
      watchlistPath: formatRelative(WATCHLIST_PATH)
    },
    mode,
    notes: [
      "No opera.",
      "No usa red.",
      "No scraping, no login, no paywalls.",
      "No toca positions, outcomes ni data/social_signals.json.",
      "Salida compatible con Social Radar, reviewStatus pending.",
      mode === "production"
        ? "Production no usa examples salvo --use-examples; DEMO/TEST/MOON se excluyen salvo que esten en cartera/watchlist real."
        : "Demo permite examples para validacion."
    ],
    errorCounts,
    normalizedMentions,
    sourceMode,
    sourceCounts,
    summary
  };
  const markdown = renderSummary({
    errorCounts,
    generatedAt,
    mode,
    normalizedMentions,
    sourceCounts,
    sourceMode
  });

  writeJson(NORMALIZED_PATH, payload);
  writeText(SUMMARY_PATH, markdown);

  return {
    ...payload,
    consoleReport: renderConsoleReport({
      errorCounts,
      mode,
      normalizedMentions,
      sourceMode,
      summary
    }),
    paths: {
      normalizedMentionsPath: NORMALIZED_PATH,
      outputDir: OUTPUT_DIR,
      summaryPath: SUMMARY_PATH
    }
  };
}

module.exports = {
  runSocialInbox
};
