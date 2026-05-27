"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR } = require("./storage");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "historical-catalysts");
const EXAMPLE_PATH = path.join(ROOT_DIR, "examples", "historical-catalysts.example.json");
const VALID_CATALYST_TYPES = new Set([
  "FDA",
  "PDUFA",
  "phase2",
  "phase3",
  "earnings",
  "insider",
  "M&A",
  "financing",
  "other"
]);
const VALID_OUTCOMES = new Set(["positive", "negative", "mixed", "pending", "unknown"]);
const REQUIRED_FIELDS = [
  "catalystId",
  "ticker",
  "catalystType",
  "knownFromDate",
  "catalystDate",
  "source",
  "expectedEvent",
  "actualOutcome"
];
const PRICE_FIELDS = [
  "priceBefore",
  "priceAfter7d",
  "priceAfter30d",
  "maxUpside30d",
  "maxDrawdown30d"
];

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

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

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Historical Catalyst Dataset solo puede escribir dentro de backtests/historical-catalysts/.");
  }
}

function writeOutput(fileName, contents) {
  const filePath = path.join(OUTPUT_DIR, fileName);
  assertOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function writeOutputJson(fileName, value) {
  return writeOutput(fileName, `${JSON.stringify(value, null, 2)}\n`);
}

function isDateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime());
}

function isMissing(value) {
  return value === null || value === undefined || value === "";
}

function isNumberOrMissing(value) {
  return isMissing(value) || Number.isFinite(value);
}

function normalizeTicker(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function validateCatalyst(raw, index) {
  const errors = [];
  const warnings = [];
  const missingData = [];
  const row = {
    actualOutcome: raw.actualOutcome || "unknown",
    catalystDate: raw.catalystDate || null,
    catalystId: raw.catalystId || `missing-id-${index}`,
    catalystType: raw.catalystType || null,
    expectedEvent: raw.expectedEvent || null,
    knownFromDate: raw.knownFromDate || null,
    maxDrawdown30d: raw.maxDrawdown30d ?? null,
    maxUpside30d: raw.maxUpside30d ?? null,
    notes: raw.notes || "",
    priceAfter30d: raw.priceAfter30d ?? null,
    priceAfter7d: raw.priceAfter7d ?? null,
    priceBefore: raw.priceBefore ?? null,
    source: raw.source || null,
    ticker: normalizeTicker(raw.ticker)
  };

  REQUIRED_FIELDS.forEach((fieldName) => {
    if (isMissing(row[fieldName])) {
      errors.push(`${fieldName} requerido`);
    }
  });

  if (row.ticker && !/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.ticker)) {
    errors.push("ticker invalido");
  }

  if (row.catalystType && !VALID_CATALYST_TYPES.has(row.catalystType)) {
    errors.push(`catalystType invalido: ${row.catalystType}`);
  }

  if (row.actualOutcome && !VALID_OUTCOMES.has(row.actualOutcome)) {
    errors.push(`actualOutcome invalido: ${row.actualOutcome}`);
  }

  if (row.knownFromDate && !isDateOnly(row.knownFromDate)) {
    errors.push("knownFromDate debe ser YYYY-MM-DD");
  }

  if (row.catalystDate && !isDateOnly(row.catalystDate)) {
    errors.push("catalystDate debe ser YYYY-MM-DD");
  }

  if (isDateOnly(row.knownFromDate) && isDateOnly(row.catalystDate) && row.knownFromDate > row.catalystDate) {
    errors.push("knownFromDate no puede ser posterior a catalystDate");
  }

  PRICE_FIELDS.forEach((fieldName) => {
    if (isMissing(row[fieldName])) {
      missingData.push(fieldName);
      return;
    }

    if (!isNumberOrMissing(row[fieldName])) {
      errors.push(`${fieldName} debe ser numerico o null`);
    }
  });

  if (["unknown", "pending"].includes(row.actualOutcome)) {
    missingData.push("actualOutcome verificado");
  }

  if (!row.knownFromDate) {
    warnings.push("no usar para edge validation fuerte sin knownFromDate");
  }

  return {
    ...row,
    antiLookAheadOk: errors.every((error) => error !== "knownFromDate no puede ser posterior a catalystDate"),
    errors,
    missingData: [...new Set(missingData)],
    usableForCatalystReplay: errors.length === 0 && Boolean(row.knownFromDate),
    usableForOutcomeEdge: errors.length === 0 &&
      Boolean(row.knownFromDate) &&
      !["unknown", "pending"].includes(row.actualOutcome) &&
      PRICE_FIELDS.every((fieldName) => Number.isFinite(row[fieldName])),
    warnings
  };
}

function countBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Historical Catalyst Dataset v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push("Modo: research-only. No opera, no usa IBKR, no usa Binance, no envia ordenes y no usa red.");
  lines.push("");
  lines.push("## Cantidad de catalysts");
  lines.push(`- Total: ${payload.summary.total}`);
  lines.push(`- Validos: ${payload.summary.valid}`);
  lines.push(`- Invalidos: ${payload.summary.invalid}`);
  lines.push(`- Con missingData: ${payload.summary.withMissingData}`);
  lines.push(`- Usables para catalyst replay: ${payload.summary.usableForCatalystReplay}`);
  lines.push(`- Usables para outcome edge: ${payload.summary.usableForOutcomeEdge}`);
  lines.push("");
  lines.push("## Tickers cubiertos");
  lines.push(payload.summary.tickers.length ? `- ${payload.summary.tickers.join(", ")}` : "- Ninguno.");
  lines.push("");
  lines.push("## Tipos de catalyst");
  Object.entries(payload.summary.byType).forEach(([type, count]) => lines.push(`- ${type}: ${count}`));
  lines.push("");
  lines.push("## Eventos pendientes");
  lines.push(`- pending: ${payload.summary.byOutcome.pending || 0}`);
  lines.push(`- unknown: ${payload.summary.byOutcome.unknown || 0}`);
  lines.push("");
  lines.push("## Eventos positivos/negativos/mixed");
  lines.push(`- positive: ${payload.summary.byOutcome.positive || 0}`);
  lines.push(`- negative: ${payload.summary.byOutcome.negative || 0}`);
  lines.push(`- mixed: ${payload.summary.byOutcome.mixed || 0}`);
  lines.push("");
  lines.push("## Missing data y errores");
  if (payload.catalysts.every((row) => row.errors.length === 0 && row.missingData.length === 0)) {
    lines.push("- Ninguno.");
  } else {
    payload.catalysts.forEach((row) => {
      const details = [
        row.errors.length ? `errors=${row.errors.join("; ")}` : null,
        row.missingData.length ? `missingData=${row.missingData.join("; ")}` : null,
        row.warnings.length ? `warnings=${row.warnings.join("; ")}` : null
      ].filter(Boolean);

      if (details.length) {
        lines.push(`- ${row.catalystId}: ${details.join(" | ")}`);
      }
    });
  }
  lines.push("");
  lines.push("## Advertencia anti look-ahead");
  lines.push("- knownFromDate debe ser menor o igual a catalystDate.");
  lines.push("- No usar catalysts sin knownFromDate para edge validation fuerte.");
  lines.push("- No completar actualOutcome ni precios si no estan verificados por fuente historica punto-en-tiempo.");
  lines.push("- Este comando valida estructura; no descarga fuentes y no infiere outcomes.");
  lines.push("");
  lines.push("## Confirmacion");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function buildPayload(options = {}) {
  const inputPath = options.inputPath || EXAMPLE_PATH;
  const input = readJson(inputPath);
  const catalysts = ((input && input.catalysts) || []).map(validateCatalyst);
  const validRows = catalysts.filter((row) => row.errors.length === 0);
  const payload = {
    catalysts,
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No usa red.",
      "No modifica positions.",
      "No modifica outcomes.",
      "No modifica data/*.json ni data/social_signals.json.",
      "No inventa outcomes.",
      "Output solo en backtests/historical-catalysts/.",
      "No commit.",
      "No push."
    ],
    generatedAt: new Date().toISOString(),
    input: {
      path: formatRelative(inputPath),
      schemaVersion: input.schemaVersion || null,
      updatedAt: input.updatedAt || null
    },
    mode: "research-only-historical-catalyst-dataset",
    summary: {
      byOutcome: countBy(catalysts, (row) => row.actualOutcome),
      byType: countBy(catalysts, (row) => row.catalystType),
      invalid: catalysts.filter((row) => row.errors.length > 0).length,
      tickers: [...new Set(catalysts.map((row) => row.ticker).filter(Boolean))].sort(),
      total: catalysts.length,
      usableForCatalystReplay: catalysts.filter((row) => row.usableForCatalystReplay).length,
      usableForOutcomeEdge: catalysts.filter((row) => row.usableForOutcomeEdge).length,
      valid: validRows.length,
      withMissingData: catalysts.filter((row) => row.missingData.length > 0).length
    }
  };

  return payload;
}

function writeOutputs(payload) {
  return {
    summaryPath: writeOutput("summary.md", renderSummary(payload)),
    validatedCatalystsPath: writeOutputJson("validated-catalysts.json", payload)
  };
}

function renderConsoleReport(payload, paths) {
  return [
    "WALY Historical Catalyst Dataset v1 generado.",
    `Catalysts ejemplo: ${payload.summary.total}`,
    `Validos: ${payload.summary.valid} | invalidos=${payload.summary.invalid} | missingData=${payload.summary.withMissingData}`,
    `Tickers: ${payload.summary.tickers.join(", ") || "ninguno"}`,
    `Tipos: ${Object.entries(payload.summary.byType).map(([type, count]) => `${type}:${count}`).join(" | ") || "ninguno"}`,
    `validated-catalysts.json: ${formatRelative(paths.validatedCatalystsPath)}`,
    `summary.md: ${formatRelative(paths.summaryPath)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no red, no commit, no push."
  ].join("\n");
}

function runHistoricalCatalystDataset(options = {}) {
  const payload = buildPayload(options);
  let paths = {
    summaryPath: null,
    validatedCatalystsPath: null
  };

  if (options.writeOutput !== false) {
    paths = writeOutputs(payload);
  }

  return {
    ...payload,
    consoleReport: renderConsoleReport(payload, paths),
    paths
  };
}

module.exports = {
  buildPayload,
  runHistoricalCatalystDataset
};
