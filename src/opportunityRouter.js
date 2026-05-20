"use strict";

const fs = require("fs");
const path = require("path");
const { runPortfolioReview } = require("./portfolioEngine");
const { BACKTESTS_DIR, readJson } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "opportunity-router");
const SOURCE_FILES = [
  {
    sourceKind: "live-scan",
    filePath: path.join(BACKTESTS_DIR, "live-universe-scan", "filteredCandidates.json")
  },
  {
    sourceKind: "reversal-scan",
    filePath: path.join(BACKTESTS_DIR, "reversal-radar", "filteredCandidates.json")
  },
  {
    sourceKind: "short-scan",
    filePath: path.join(BACKTESTS_DIR, "short-radar", "filteredCandidates.json")
  }
];

const DIRECT_SCAN_SOURCES = new Set(["live-scan", "reversal-scan", "short-scan"]);
const DECISION_ORDER = {
  operate: 6,
  "manual-candidate": 5,
  "reduce-risk": 4,
  watch: 3,
  "wait-for-data": 2,
  discard: 1
};

const SIZE_PATHS = [
  "maxSuggestedPositionPct",
  "proposedPositionPct",
  "suggestedPositionPct",
  "targetPositionPct",
  "positionPct",
  "allocationPct",
  "riskBudgetPct",
  "maxPositionPct"
];

const SCORE_PATHS = [
  "walyScore",
  "score",
  "rankingScore",
  "qualityScore",
  "convictionScore",
  "maxReturnPct",
  "returnScore"
];

function ensureOutputDir() {
  const resolved = path.resolve(OUTPUT_DIR);
  const relative = path.relative(BACKTESTS_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("opportunity-router solo puede escribir dentro de backtests/.");
  }

  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function writeTextFile(directory, fileName, contents) {
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function writeJsonFile(directory, fileName, value) {
  return writeTextFile(directory, fileName, `${JSON.stringify(value, null, 2)}\n`);
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function coerceNumber(value) {
  if (isFiniteNumber(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.replace(/[$,%]/g, "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function getPathValue(source, dottedPath) {
  return dottedPath.split(".").reduce((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return current[segment];
  }, source);
}

function readFirstNumber(source, paths) {
  for (const dottedPath of paths) {
    const value = coerceNumber(getPathValue(source, dottedPath));

    if (isFiniteNumber(value)) {
      return value;
    }
  }

  return null;
}

function readJsonFileSafe(filePath) {
  try {
    return {
      data: JSON.parse(fs.readFileSync(filePath, "utf8")),
      error: null
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        data: null,
        error: null
      };
    }

    return {
      data: null,
      error: error.message
    };
  }
}

function getCurrentDateInTimezone(timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric"
    });
    const parts = formatter.formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch (error) {
    return new Date().toISOString().slice(0, 10);
  }
}

function pickFirstText(source, paths, fallback = "") {
  for (const dottedPath of paths) {
    const value = getPathValue(source, dottedPath);

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function collectTextArray(source, paths) {
  return paths.flatMap((dottedPath) => {
    const value = getPathValue(source, dottedPath);

    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }

          if (item && typeof item === "object") {
            return item.reason || item.message || item.thesis || item.description || "";
          }

          return "";
        })
        .filter((item) => typeof item === "string" && item.trim());
    }

    if (typeof value === "string" && value.trim()) {
      return [value.trim()];
    }

    return [];
  });
}

function inferDirection(sourceKind, item) {
  const text = [
    sourceKind,
    item && item.direction,
    item && item.side,
    item && item.positionSide,
    item && item.setupType,
    item && item.playbookType,
    item && item.playbook,
    item && item.assetType,
    item && item.etfCategory
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (sourceKind === "short-scan" || /\bshort\b/.test(text) || text.includes("inverse")) {
    return "short";
  }

  if (text.includes("neutral")) {
    return "neutral";
  }

  return "long";
}

function getMarketPrice(item) {
  return readFirstNumber(item, [
    "marketData.price",
    "marketData.lastPrice",
    "lastPrice",
    "price",
    "close",
    "entryPrice",
    "signalPrice"
  ]);
}

function hasMarketData(idea) {
  if (idea.sourceKind === "multibagger-lab") {
    return true;
  }

  return isFiniteNumber(idea.marketPrice);
}

function getCatalystType(item) {
  const direct = pickFirstText(item, [
    "catalystType",
    "metadata.catalystType",
    "localContext.catalystType",
    "currentCatalysts.0.catalystType",
    "catalysts.0.catalystType"
  ]);

  return normalizeLower(direct);
}

function hasCriticalCatalyst(idea) {
  if (idea.sourceKind === "reversal-scan") {
    return Boolean(idea.supportingReasons.length || idea.raw.possibleReboundReason);
  }

  if (idea.sourceKind === "short-scan") {
    return Boolean(idea.supportingReasons.length || idea.raw.shortThesis || idea.raw.borrowData);
  }

  if (idea.sourceKind === "multibagger-lab") {
    return true;
  }

  return Boolean(
    idea.catalystType ||
      idea.raw.catalyst ||
      idea.raw.catalystDate ||
      idea.raw.catalystWindow ||
      (Array.isArray(idea.raw.catalysts) && idea.raw.catalysts.length > 0) ||
      (Array.isArray(idea.raw.currentCatalysts) && idea.raw.currentCatalysts.length > 0)
  );
}

function hasDatedCatalyst(idea) {
  return Boolean(
    idea.catalystType &&
      (idea.raw.catalystDate ||
        idea.raw.catalystWindow ||
        getPathValue(idea.raw, "localContext.catalystDate") ||
        getPathValue(idea.raw, "localContext.catalystWindow") ||
        getPathValue(idea.raw, "metadata.catalystDate") ||
        getPathValue(idea.raw, "metadata.catalystWindow") ||
        getPathValue(idea.raw, "currentCatalysts.0.catalystDate") ||
        getPathValue(idea.raw, "catalysts.0.catalystDate"))
  );
}

function isHighQualityWatchlistClassification(classification) {
  return ["a", "a+"].includes(normalizeLower(classification));
}

function hasPositiveSizing(idea) {
  return isFiniteNumber(idea.maxSuggestedPositionPct) && idea.maxSuggestedPositionPct > 0;
}

function isManualCandidateEligible(idea, { alreadyInPortfolio, portfolioRisk }) {
  return Boolean(
    idea.sourceKind === "watchlist" &&
      !alreadyInPortfolio &&
      isHighQualityWatchlistClassification(idea.classificationOriginal) &&
      hasMarketData(idea) &&
      hasDatedCatalyst(idea) &&
      hasPositiveSizing(idea) &&
      !hasPortfolioRiskBlock(portfolioRisk)
  );
}

function normalizePlaybook(item, fallback) {
  return pickFirstText(item, [
    "playbook",
    "playbookType",
    "setupType",
    "localContext.playbookType",
    "metadata.playbookType"
  ], fallback);
}

function normalizeClassification(item) {
  return pickFirstText(item, [
    "classification",
    "setupRank",
    "setupRankAtEntry",
    "status",
    "analysis.classification"
  ], "n/d");
}

function normalizeInvalidation(item) {
  return pickFirstText(item, [
    "invalidation",
    "invalidatesIf",
    "risk.invalidation",
    "localContext.invalidation",
    "metadata.invalidation"
  ], "");
}

function hasOptionsAvailable(item) {
  const value = item && (item.optionsAvailable ?? getPathValue(item, "marketData.optionsAvailable"));
  return value === true;
}

function hasBorrowData(item) {
  return Boolean(item && (item.borrowData || item.borrowRate || item.shortBorrowAvailable || item.locateAvailable === true));
}

function normalizeSourceIdea(sourceKind, item, filePath) {
  const ticker = normalizeTicker(item && (item.ticker || getPathValue(item, "localContext.ticker")));

  if (!ticker) {
    return null;
  }

  const supportingReasons = [
    ...collectTextArray(item, [
      "supportingReasons",
      "discoveryReasons",
      "reasons",
      "rejectReasons",
      "hardRejectReasons"
    ]),
    pickFirstText(item, [
      "thesis",
      "rationale",
      "possibleReboundReason",
      "shortThesis",
      "whyNow",
      "expectedMove"
    ])
  ].filter(Boolean);

  return {
    assetType: normalizeLower(item.assetType || getPathValue(item, "localContext.assetType")) || "equity",
    catalystType: getCatalystType(item),
    classificationOriginal: normalizeClassification(item),
    direction: inferDirection(sourceKind, item),
    filePath,
    invalidation: normalizeInvalidation(item),
    marketPrice: getMarketPrice(item),
    maxSuggestedPositionPct: readFirstNumber(item, SIZE_PATHS),
    optionsAvailable: hasOptionsAvailable(item),
    playbook: normalizePlaybook(item, sourceKind),
    raw: item,
    scoreOriginal: readFirstNumber(item, SCORE_PATHS),
    sourceKind,
    supportingReasons: [...new Set(supportingReasons)],
    ticker
  };
}

function extractCandidates(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (!data || typeof data !== "object") {
    return [];
  }

  if (Array.isArray(data.candidates)) {
    return data.candidates;
  }

  if (Array.isArray(data.filteredCandidates)) {
    return data.filteredCandidates;
  }

  if (Array.isArray(data.signals)) {
    return data.signals;
  }

  return [];
}

function readConfiguredSourceFiles() {
  return SOURCE_FILES.map((source) => {
    const result = readJsonFileSafe(source.filePath);
    const ideas = result.data
      ? extractCandidates(result.data)
        .map((candidate) => normalizeSourceIdea(source.sourceKind, candidate, source.filePath))
        .filter(Boolean)
      : [];

    return {
      error: result.error,
      filePath: source.filePath,
      ideas,
      loaded: Boolean(result.data),
      sourceKind: source.sourceKind
    };
  });
}

function walkFiles(directory, depth = 0) {
  if (depth > 6 || !fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return walkFiles(entryPath, depth + 1);
    }

    return [entryPath];
  });
}

function readMultibaggerOutputs() {
  const root = path.join(BACKTESTS_DIR, "multibagger-lab");
  const files = walkFiles(root)
    .filter((filePath) => path.basename(filePath) === "analyzedSignals.json")
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

  return files.map((filePath) => {
    const result = readJsonFileSafe(filePath);
    const ideas = result.data
      ? extractCandidates(result.data)
        .map((candidate) => normalizeSourceIdea("multibagger-lab", candidate, filePath))
        .filter(Boolean)
      : [];

    return {
      error: result.error,
      filePath,
      ideas,
      loaded: Boolean(result.data),
      sourceKind: "multibagger-lab"
    };
  });
}

function readWatchlistIdeas(watchlist) {
  return (watchlist.watchlist || [])
    .map((item) => normalizeSourceIdea("watchlist", item, null))
    .filter(Boolean);
}

function readPositionIdeas(positions) {
  return (positions.positions || [])
    .map((item) => normalizeSourceIdea("portfolio-review", item, null))
    .filter(Boolean);
}

function buildPortfolioRiskIndex(portfolioReview) {
  const byTicker = new Map();
  const analysis = portfolioReview.analysis || {};
  const ideas = Array.isArray(analysis.ideas) ? analysis.ideas : [];

  ideas.forEach((idea) => {
    const ticker = normalizeTicker(idea && idea.ticker);
    const risk = idea && idea.risk;

    if (!ticker || !risk) {
      return;
    }

    byTicker.set(ticker, {
      action: risk.action || "",
      blockers: Array.isArray(risk.blockers) ? risk.blockers : [],
      passes: Array.isArray(risk.passes) ? risk.passes : [],
      proposedPct: risk.proposedPct
    });
  });

  return byTicker;
}

function getPositionRiskWarnings(ticker, portfolioReview) {
  const warnings = (((portfolioReview.analysis || {}).riskWarnings) || []).filter((warning) => {
    const text = String(warning || "");
    return text.includes(ticker) && text.includes("supera max");
  });

  return warnings;
}

function isAlreadyInPortfolio(ticker, positions) {
  return (positions.positions || []).some((position) => normalizeTicker(position && position.ticker) === ticker);
}

function buildOutcomesIndex(outcomes) {
  const byTicker = new Map();

  (outcomes.outcomes || []).forEach((outcome) => {
    const ticker = normalizeTicker(outcome && outcome.ticker);

    if (!ticker) {
      return;
    }

    const current = byTicker.get(ticker) || [];
    current.push(outcome);
    byTicker.set(ticker, current);
  });

  return byTicker;
}

function isDiscardedClassification(classification) {
  const normalized = normalizeLower(classification);
  return normalized === "descartar" || normalized === "discard" || normalized === "descartada" || normalized === "failed";
}

function hasPortfolioRiskBlock(portfolioRisk) {
  if (!portfolioRisk) {
    return false;
  }

  if (["no operar", "vigilar"].includes(portfolioRisk.action)) {
    return true;
  }

  return (portfolioRisk.blockers || []).length > 0;
}

function chooseAllowedVehicle(idea, decision, blockers) {
  if (decision === "discard" || decision === "wait-for-data") {
    return "no-trade";
  }

  if (decision === "reduce-risk") {
    return "manual-review";
  }

  if (idea.direction === "short") {
    if (idea.optionsAvailable) {
      return "put-spread";
    }

    if (hasBorrowData(idea.raw)) {
      return "manual-review";
    }

    blockers.push("short sin optionsAvailable=true ni borrow data local");
    return "manual-review";
  }

  const requestedVehicle = normalizeLower(idea.raw.allowedVehicle || idea.raw.vehicle || idea.raw.instrument);
  if (["call", "call-spread", "equity", "manual-review", "no-trade"].includes(requestedVehicle)) {
    return requestedVehicle;
  }

  if (idea.optionsAvailable && normalizeLower(idea.playbook).includes("options")) {
    return "call-spread";
  }

  if (idea.direction === "neutral") {
    return "manual-review";
  }

  return "equity";
}

function getInitialDecision(idea, context) {
  const { alreadyInPortfolio, portfolioRisk, positionRiskWarnings, priorOutcomes } = context;
  const blockers = [];
  const supportingReasons = [...idea.supportingReasons];
  let decision = "watch";

  if (isDiscardedClassification(idea.classificationOriginal)) {
    blockers.push("clasificacion original descartada");
    decision = "discard";
  }

  if (!hasMarketData(idea)) {
    blockers.push("falta market data local");
    decision = decision === "discard" ? "discard" : "wait-for-data";
  }

  if (!hasCriticalCatalyst(idea)) {
    blockers.push("falta catalyst o tesis critica verificable");
    decision = decision === "discard" ? "discard" : "wait-for-data";
  }

  if (idea.sourceKind === "multibagger-lab") {
    blockers.push("multibagger-lab es evidencia historica, no senal de compra directa");
    decision = decision === "discard" ? "discard" : "watch";
  }

  if (priorOutcomes.length > 0) {
    const failedOutcome = priorOutcomes.find((outcome) => outcome.outcomeLabel === "fallo" || outcome.falsePositive === true);
    const constructiveOutcome = priorOutcomes.find((outcome) =>
      ["funciono", "mixto"].includes(outcome.outcomeLabel)
    );

    if (failedOutcome) {
      blockers.push(`outcome previo debil para ${idea.ticker}: ${failedOutcome.outcomeLabel}`);
      decision = decision === "operate" ? "watch" : decision;
    } else if (constructiveOutcome) {
      supportingReasons.push(`outcome previo ${constructiveOutcome.outcomeLabel}: ${constructiveOutcome.horizon}`);
    }
  }

  if (positionRiskWarnings.length > 0 && alreadyInPortfolio) {
    blockers.push(...positionRiskWarnings);
    decision = "reduce-risk";
  }

  if (portfolioRisk) {
    if (portfolioRisk.action) {
      supportingReasons.push(`portfolio-review: ${portfolioRisk.action}`);
    }

    blockers.push(...(portfolioRisk.blockers || []));

    if (portfolioRisk.action === "no operar") {
      decision = "discard";
    } else if (hasPortfolioRiskBlock(portfolioRisk) && decision !== "discard" && decision !== "reduce-risk") {
      decision = alreadyInPortfolio ? "reduce-risk" : "watch";
    } else if (
      portfolioRisk.action === "preparar orden manual" &&
      DIRECT_SCAN_SOURCES.has(idea.sourceKind) &&
      decision === "watch"
    ) {
      decision = "operate";
    }
  }

  if (
    DIRECT_SCAN_SOURCES.has(idea.sourceKind) &&
    decision === "watch" &&
    !hasPortfolioRiskBlock(portfolioRisk) &&
    hasMarketData(idea) &&
    hasCriticalCatalyst(idea) &&
    isFiniteNumber(idea.maxSuggestedPositionPct)
  ) {
    decision = "operate";
  }

  if (decision === "operate" && !isFiniteNumber(idea.maxSuggestedPositionPct)) {
    blockers.push("sin maxSuggestedPositionPct/proposedPositionPct/riskBudgetPct local");
    decision = "watch";
  }

  if (decision === "operate" && idea.sourceKind === "watchlist") {
    decision = "watch";
  }

  if (decision === "watch" && isManualCandidateEligible(idea, { alreadyInPortfolio, portfolioRisk })) {
    decision = "manual-candidate";
  }

  return {
    blockers: [...new Set(blockers.filter(Boolean))],
    decision,
    supportingReasons: [...new Set(supportingReasons.filter(Boolean))]
  };
}

function scoreIdeaForOrdering(idea) {
  const decisionScore = DECISION_ORDER[idea.decision] || 0;
  const numericScore = isFiniteNumber(idea.scoreOriginal) ? idea.scoreOriginal : 0;
  const sourceScore = DIRECT_SCAN_SOURCES.has(idea.sourceKind) ? 20 : idea.sourceKind === "watchlist" ? 10 : 0;
  return decisionScore * 1000 + sourceScore + numericScore;
}

function computeConfidence(idea) {
  if (idea.decision === "operate" && idea.blockers.length === 0) {
    return "high";
  }

  if (idea.decision === "manual-candidate" && idea.blockers.length === 0) {
    return "medium";
  }

  if (idea.decision === "watch" && idea.supportingReasons.length > 0 && idea.blockers.length <= 2) {
    return "medium";
  }

  if (idea.decision === "reduce-risk") {
    return "medium";
  }

  return "low";
}

function routeIdea(idea, context) {
  const portfolioRisk = context.portfolioRiskIndex.get(idea.ticker);
  const positionRiskWarnings = getPositionRiskWarnings(idea.ticker, context.portfolioReview);
  const alreadyInPortfolio = isAlreadyInPortfolio(idea.ticker, context.positions);
  const priorOutcomes = context.outcomesIndex.get(idea.ticker) || [];
  const routed = getInitialDecision(idea, {
    alreadyInPortfolio,
    portfolioRisk,
    positionRiskWarnings,
    priorOutcomes
  });
  const blockers = [...routed.blockers];
  const allowedVehicle = chooseAllowedVehicle(idea, routed.decision, blockers);
  let decision = routed.decision;

  if (decision === "operate" && allowedVehicle === "manual-review") {
    decision = "watch";
  }

  return {
    ticker: idea.ticker,
    sourceKind: idea.sourceKind,
    direction: idea.direction,
    playbook: idea.playbook,
    classificationOriginal: idea.classificationOriginal,
    scoreOriginal: idea.scoreOriginal,
    portfolioRiskAction: portfolioRisk ? portfolioRisk.action : null,
    decision,
    allowedVehicle,
    maxSuggestedPositionPct: isFiniteNumber(idea.maxSuggestedPositionPct) ? idea.maxSuggestedPositionPct : null,
    blockers: [...new Set(blockers.filter(Boolean))],
    supportingReasons: routed.supportingReasons,
    invalidation: idea.invalidation || null,
    confidence: "low",
    alreadyInPortfolio,
    sourceFile: idea.filePath ? formatRelative(idea.filePath) : null
  };
}

function enforceOperateLimit(routedIdeas) {
  const sortedOperable = routedIdeas
    .filter((idea) => idea.decision === "operate")
    .sort((left, right) => scoreIdeaForOrdering(right) - scoreIdeaForOrdering(left));
  const allowed = new Set(sortedOperable.slice(0, 3).map((idea) => `${idea.ticker}:${idea.sourceKind}`));

  return routedIdeas.map((idea) => {
    const key = `${idea.ticker}:${idea.sourceKind}`;

    if (idea.decision !== "operate" || allowed.has(key)) {
      return idea;
    }

    return {
      ...idea,
      blockers: [...idea.blockers, "limite de 0-3 ideas operables alcanzado"],
      decision: "watch"
    };
  });
}

function finalizeRoutedIdeas(routedIdeas) {
  return enforceOperateLimit(routedIdeas)
    .map((idea) => ({
      ...idea,
      confidence: computeConfidence(idea)
    }))
    .sort((left, right) => {
      const scoreDelta = scoreIdeaForOrdering(right) - scoreIdeaForOrdering(left);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return `${left.ticker}:${left.sourceKind}`.localeCompare(`${right.ticker}:${right.sourceKind}`);
    });
}

function countBySource(ideas) {
  return ideas.reduce((accumulator, idea) => {
    accumulator[idea.sourceKind] = (accumulator[idea.sourceKind] || 0) + 1;
    return accumulator;
  }, {});
}

function renderIdeaLine(idea) {
  const size = isFiniteNumber(idea.maxSuggestedPositionPct) ? `${idea.maxSuggestedPositionPct}%` : "n/d";
  const blockers = idea.blockers.length ? ` | blockers: ${idea.blockers.slice(0, 3).join("; ")}` : "";
  return `- ${idea.ticker} [${idea.sourceKind}] ${idea.decision} | ${idea.allowedVehicle} | ${idea.direction} | size ${size} | confidence ${idea.confidence}${blockers}`;
}

function renderList(title, ideas, emptyMessage) {
  return [
    title,
    ...(ideas.length ? ideas.map(renderIdeaLine) : [`- ${emptyMessage}`]),
    ""
  ];
}

function renderSummary({ currentDate, portfolioReview, routedIdeas, sourceReads }) {
  const analysis = portfolioReview.analysis || {};
  const positions = analysis.estimatedPositions || [];
  const sourceCounts = countBySource(routedIdeas);
  const operable = routedIdeas.filter((idea) => idea.decision === "operate").slice(0, 3);
  const manualCandidates = routedIdeas.filter((idea) => idea.decision === "manual-candidate");
  const watch = routedIdeas.filter((idea) => idea.decision === "watch");
  const discarded = routedIdeas.filter((idea) => idea.decision === "discard");
  const waiting = routedIdeas.filter((idea) => idea.decision === "wait-for-data");
  const reduceRisk = routedIdeas.filter((idea) => idea.decision === "reduce-risk");
  const top = routedIdeas.slice(0, 10);
  const blockers = [...new Set(routedIdeas.flatMap((idea) => idea.blockers))];
  const loadedSources = sourceReads.filter((source) => source.loaded);
  const missingSources = sourceReads.filter((source) => !source.loaded && !source.error);
  const erroredSources = sourceReads.filter((source) => source.error);
  const lines = [];

  lines.push("# WALY Opportunity Router MVP");
  lines.push("");
  lines.push(`Fecha local: ${currentDate}`);
  lines.push("Modo: read-only; no opera, no usa IBKR, no usa Binance, no ejecuta ordenes.");
  lines.push("");
  lines.push("## 1. Estado de cartera resumido");
  if (positions.length === 0) {
    lines.push("- Cartera vacia.");
  } else {
    positions.forEach((position) => {
      lines.push(`- ${position.ticker}: ${position.status} | ${position.direction} | ${position.assetType} | exposicion ${position.grossValue || "n/d"}`);
    });
  }
  lines.push(`- Riesgo portfolio-review: ${(analysis.riskWarnings || []).length} warnings.`);
  lines.push("");
  lines.push("## 2. Ideas leidas por fuente");
  ["portfolio-review", "watchlist", "live-scan", "reversal-scan", "short-scan", "multibagger-lab"].forEach((sourceKind) => {
    lines.push(`- ${sourceKind}: ${sourceCounts[sourceKind] || 0}`);
  });
  if (loadedSources.length) {
    loadedSources.forEach((source) => lines.push(`- loaded: ${source.sourceKind} ${formatRelative(source.filePath)}`));
  }
  if (missingSources.length) {
    missingSources.forEach((source) => lines.push(`- missing: ${source.sourceKind} ${formatRelative(source.filePath)}`));
  }
  erroredSources.forEach((source) => lines.push(`- error: ${source.sourceKind} ${formatRelative(source.filePath)} | ${source.error}`));
  lines.push("");
  lines.push(...renderList("## 3. Top routed ideas", top, "Sin ideas ruteadas."));
  lines.push(...renderList("## 4. Operables 0-3", operable, "Ninguna idea operable hoy."));
  lines.push(...renderList("## 5. Manual candidates", manualCandidates, "Ninguna idea candidata a revision manual hoy."));
  lines.push(...renderList("## 6. Watch", watch, "Sin ideas en vigilancia."));
  lines.push(...renderList("## 7. Discarded", discarded, "Sin descartes."));
  if (waiting.length || reduceRisk.length) {
    lines.push("## Estados adicionales");
    waiting.forEach((idea) => lines.push(renderIdeaLine(idea)));
    reduceRisk.forEach((idea) => lines.push(renderIdeaLine(idea)));
    lines.push("");
  }
  lines.push("## 8. Bloqueos principales");
  if (blockers.length === 0) {
    lines.push("- Sin bloqueos principales.");
  } else {
    blockers.slice(0, 12).forEach((blocker) => lines.push(`- ${blocker}`));
  }
  lines.push("");
  lines.push("## 9. Que hacer hoy");
  if (operable.length === 0) {
    lines.push("- No operar: no hay idea que pase datos, catalyst, sizing y riesgo.");
  } else {
    lines.push(`- Revisar manualmente ${operable.map((idea) => idea.ticker).join(", ")} antes de cualquier ticket.`);
  }
  if (manualCandidates.length) {
    lines.push(`- Revisar como candidata manual ${manualCandidates.map((idea) => idea.ticker).join(", ")}; no es operate automatico.`);
  }
  if (reduceRisk.length) {
    lines.push(`- Revisar reduccion manual de riesgo en ${reduceRisk.map((idea) => idea.ticker).join(", ")}.`);
  }
  if (watch.length) {
    lines.push(`- Vigilar ${watch.slice(0, 6).map((idea) => idea.ticker).join(", ")} hasta completar datos.`);
  }
  lines.push("- Mantener cartera abierta por delante de ideas nuevas.");
  lines.push("");
  lines.push("## 10. Que NO hacer");
  lines.push("- No ejecutar ordenes desde este reporte.");
  lines.push("- No usar IBKR, Binance ni conectores de ejecucion.");
  lines.push("- No inventar market data, borrow, optionsAvailable, catalyst ni liquidez.");
  lines.push("- No promover multibagger-lab a compra directa.");
  lines.push("- No tocar positions.json ni outcomes.json.");

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  const operable = result.routedIdeas.filter((idea) => idea.decision === "operate");
  const manualCandidates = result.routedIdeas.filter((idea) => idea.decision === "manual-candidate");
  const watch = result.routedIdeas.filter((idea) => idea.decision === "watch");
  const blockers = [...new Set(result.routedIdeas.flatMap((idea) => idea.blockers))];

  return [
    "WALY Opportunity Router MVP generado.",
    `Output dir: ${formatRelative(result.paths.outputDir)}`,
    `Routed ideas: ${result.routedIdeas.length}`,
    `Operables: ${operable.length ? operable.map((idea) => idea.ticker).join(", ") : "ninguna"}`,
    `Manual candidates: ${manualCandidates.length ? manualCandidates.map((idea) => idea.ticker).join(", ") : "ninguna"}`,
    `Watch: ${watch.length ? watch.map((idea) => idea.ticker).join(", ") : "ninguna"}`,
    `Bloqueos: ${blockers.length ? blockers.slice(0, 5).join(" | ") : "ninguno"}`,
    `routedIdeas.json: ${formatRelative(result.paths.routedIdeasPath)}`,
    `summary.md: ${formatRelative(result.paths.summaryPath)}`
  ].join("\n");
}

function runOpportunityRouter() {
  const settings = readJson("settings.json");
  const positions = readJson("positions.json");
  const watchlist = readJson("watchlist.json");
  const outcomes = readJson("outcomes.json");
  const portfolioReview = runPortfolioReview();
  const portfolioRiskIndex = buildPortfolioRiskIndex(portfolioReview);
  const configuredSources = readConfiguredSourceFiles();
  const multibaggerSources = readMultibaggerOutputs();
  const sourceReads = [...configuredSources, ...multibaggerSources];
  const sourceIdeas = sourceReads.flatMap((source) => source.ideas);
  const watchlistIdeas = readWatchlistIdeas(watchlist);
  const positionIdeas = readPositionIdeas(positions);
  const allIdeas = [...positionIdeas, ...watchlistIdeas, ...sourceIdeas];
  const context = {
    outcomesIndex: buildOutcomesIndex(outcomes),
    portfolioReview,
    portfolioRiskIndex,
    positions
  };
  const currentDate = getCurrentDateInTimezone(settings.timezone);
  const routedIdeas = finalizeRoutedIdeas(allIdeas.map((idea) => routeIdea(idea, context)));
  const summaryMarkdown = renderSummary({
    currentDate,
    portfolioReview,
    routedIdeas,
    sourceReads
  });
  const outputDir = ensureOutputDir();
  const routedIdeasPath = writeJsonFile(outputDir, "routedIdeas.json", {
    generatedAt: new Date().toISOString(),
    mode: "read-only",
    notes: [
      "No ejecuta ordenes.",
      "No usa red.",
      "No usa IBKR ni Binance.",
      "Multibagger-lab se usa solo como evidencia historica."
    ],
    sourceCounts: countBySource(routedIdeas),
    routedIdeas
  });
  const summaryPath = writeTextFile(outputDir, "summary.md", summaryMarkdown);
  const result = {
    paths: {
      outputDir,
      routedIdeasPath,
      summaryPath
    },
    routedIdeas,
    sourceReads,
    summaryMarkdown
  };

  return {
    ...result,
    consoleReport: renderConsoleReport(result)
  };
}

module.exports = {
  runOpportunityRouter
};
