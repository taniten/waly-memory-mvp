"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, readJson } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");

const RISK_RULE_PATHS = {
  maxBiotechPct: ["risk.maxBiotechPct", "portfolioRisk.maxBiotechPct", "riskRules.maxBiotechPct", "maxBiotechPct"],
  maxDailyLossPct: ["risk.maxDailyLossPct", "portfolioRisk.maxDailyLossPct", "riskRules.maxDailyLossPct", "maxDailyLossPct"],
  maxPositionPct: ["risk.maxPositionPct", "portfolioRisk.maxPositionPct", "riskRules.maxPositionPct", "maxPositionPct"],
  maxSectorPct: ["risk.maxSectorPct", "portfolioRisk.maxSectorPct", "riskRules.maxSectorPct", "maxSectorPct"],
  maxShortPct: ["risk.maxShortPct", "portfolioRisk.maxShortPct", "riskRules.maxShortPct", "maxShortPct"],
  maxSpeculativePct: [
    "risk.maxSpeculativePct",
    "portfolioRisk.maxSpeculativePct",
    "riskRules.maxSpeculativePct",
    "maxSpeculativePct"
  ],
  maxWeeklyLossPct: ["risk.maxWeeklyLossPct", "portfolioRisk.maxWeeklyLossPct", "riskRules.maxWeeklyLossPct", "maxWeeklyLossPct"]
};

const CASH_PATHS = [
  "cash",
  "cashUsd",
  "cashUSD",
  "cashEstimate",
  "cashEstimateUsd",
  "portfolio.cash",
  "portfolio.cashUsd",
  "portfolio.cashUSD",
  "portfolio.cashEstimate",
  "portfolio.cashAndYield",
  "portfolio.cashYield",
  "portfolio.yieldCash"
];

const TOTAL_CAPITAL_PATHS = [
  "totalCapital",
  "totalCapitalEstimate",
  "capitalTotal",
  "portfolio.totalCapital",
  "portfolio.totalCapitalEstimate",
  "portfolio.accountEquity",
  "portfolio.netLiquidation",
  "account.totalCapital",
  "account.netLiquidation"
];

const YIELD_PATHS = [
  "yieldPct",
  "cashYieldPct",
  "portfolio.yieldPct",
  "portfolio.cashYieldPct",
  "cashYield.apyPct",
  "yield.apyPct"
];

const IDEA_SIZE_PATHS = [
  "proposedPositionPct",
  "suggestedPositionPct",
  "targetPositionPct",
  "positionPct",
  "allocationPct",
  "riskBudgetPct"
];

const SCAN_PATTERNS = [
  {
    label: "live-scan",
    pathHints: ["live-universe-scan", "live-scan"],
    preferredFiles: ["filteredCandidates.json", "rawCandidates.json"]
  },
  {
    label: "reversal-scan",
    pathHints: ["reversal-radar", "reversal-scan"],
    preferredFiles: ["filteredCandidates.json", "rawCandidates.json"]
  },
  {
    label: "short-scan",
    pathHints: ["short-scan", "shorts-scan"],
    preferredFiles: ["filteredCandidates.json", "rawCandidates.json"]
  }
];

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function coerceNumber(value) {
  if (isFiniteNumber(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[$,%]/g, "").replace(/,/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
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
      return {
        path: dottedPath,
        value
      };
    }
  }

  return {
    path: null,
    value: null
  };
}

function normalizeText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function formatMoney(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `$${round(value, 2).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

function formatPercent(value) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return `${round(value, 2).toFixed(2)}%`;
}

function formatRule(value) {
  return isFiniteNumber(value) ? formatPercent(value) : "n/d";
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

function readRiskRules(settings) {
  return Object.fromEntries(
    Object.entries(RISK_RULE_PATHS).map(([ruleName, paths]) => {
      const result = readFirstNumber(settings, paths);
      return [
        ruleName,
        {
          path: result.path,
          value: result.value
        }
      ];
    })
  );
}

function estimateCapital(settings, estimatedPositions) {
  const cash = readFirstNumber(settings, CASH_PATHS);
  const explicitTotal = readFirstNumber(settings, TOTAL_CAPITAL_PATHS);
  const yieldPct = readFirstNumber(settings, YIELD_PATHS);
  const netPositionValue = estimatedPositions.reduce(
    (sum, position) => sum + (isFiniteNumber(position.marketValue) ? position.marketValue : 0),
    0
  );
  const grossPositionValue = estimatedPositions.reduce(
    (sum, position) => sum + (isFiniteNumber(position.grossValue) ? position.grossValue : 0),
    0
  );

  if (isFiniteNumber(explicitTotal.value)) {
    return {
      basis: "settings total capital",
      cash,
      grossPositionValue,
      netPositionValue,
      reliable: true,
      totalCapital: explicitTotal.value,
      totalPath: explicitTotal.path,
      yieldPct
    };
  }

  if (isFiniteNumber(cash.value)) {
    return {
      basis: "cash plus net positions",
      cash,
      grossPositionValue,
      netPositionValue,
      reliable: true,
      totalCapital: cash.value + netPositionValue,
      totalPath: cash.path,
      yieldPct
    };
  }

  if (grossPositionValue > 0) {
    return {
      basis: "known gross positions only",
      cash,
      grossPositionValue,
      netPositionValue,
      reliable: false,
      totalCapital: grossPositionValue,
      totalPath: null,
      yieldPct
    };
  }

  return {
    basis: "no capital data",
    cash,
    grossPositionValue,
    netPositionValue,
    reliable: false,
    totalCapital: null,
    totalPath: null,
    yieldPct
  };
}

function inferDirection(item) {
  const quantity = coerceNumber(item && item.quantity);
  const text = [
    item && item.side,
    item && item.direction,
    item && item.positionSide,
    item && item.positionType,
    item && item.holdingRule,
    item && item.strategy,
    item && item.setupType,
    item && item.playbookType,
    item && item.assetType,
    item && item.etfCategory
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (isFiniteNumber(quantity) && quantity < 0) {
    return "short";
  }

  if (/\bshort\b/.test(text) || text.includes("inverse")) {
    return "short";
  }

  return "long";
}

function getAssetType(item) {
  return normalizeLower(item && item.assetType) || "unknown";
}

function getSector(item) {
  return normalizeLower(
    (item && (item.sector || item.industry || item.theme || item.category)) || ""
  ) || "unknown";
}

function hasCatalyst(item) {
  return Boolean(
    normalizeText(item && item.catalystType) ||
      normalizeText(item && item.catalyst) ||
      normalizeText(item && item.catalystDate) ||
      normalizeText(item && item.catalystWindow)
  );
}

function isCrypto(item) {
  const text = [
    item && item.assetType,
    item && item.market,
    item && item.exchange,
    item && item.category,
    item && item.instrument
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return text.includes("crypto") || text.includes("token") || text.includes("coin");
}

function isBiotechCatalyst(item) {
  const text = [
    item && item.assetType,
    item && item.sector,
    item && item.industry,
    item && item.theme,
    item && item.companyName,
    item && item.catalystType,
    item && item.catalyst,
    item && item.setupType
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("biotech") ||
    text.includes("biopharma") ||
    text.includes("pharma") ||
    text.includes("therapeutic") ||
    text.includes("clinical") ||
    text.includes("drug") ||
    text.includes("fda")
  );
}

function isSpeculative(item) {
  const text = [
    item && item.status,
    item && item.assetType,
    item && item.setupRank,
    item && item.classification,
    item && item.playbookType,
    item && item.setupType,
    item && item.catalystType
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("outlier") ||
    text.includes("spec") ||
    text.includes("reversal") ||
    text.includes("nueva oportunidad") ||
    text.includes("unusual-volume-gap") ||
    text.includes("fda") ||
    text.includes("a+")
  );
}

function estimatePosition(position) {
  const quantity = coerceNumber(position && position.quantity);
  const lastPrice = coerceNumber(position && position.lastPrice);
  const avgPrice = coerceNumber(position && position.avgPrice);
  const price = isFiniteNumber(lastPrice) ? lastPrice : avgPrice;
  const marketValue = isFiniteNumber(quantity) && isFiniteNumber(price) ? quantity * price : null;
  const grossValue = isFiniteNumber(marketValue) ? Math.abs(marketValue) : null;
  const ticker = normalizeTicker(position && position.ticker);
  const direction = inferDirection(position || {});

  return {
    assetType: getAssetType(position),
    catalystType: normalizeLower(position && position.catalystType),
    direction,
    grossValue,
    isBiotechCatalyst: isBiotechCatalyst(position),
    isCatalystDriven: hasCatalyst(position),
    isCrypto: isCrypto(position),
    isSpeculative: isSpeculative(position),
    marketValue,
    price,
    priceSource: isFiniteNumber(lastPrice) ? "lastPrice" : isFiniteNumber(avgPrice) ? "avgPrice fallback" : "missing",
    quantity,
    raw: position,
    sector: getSector(position),
    status: normalizeText(position && position.status, "n/d"),
    ticker
  };
}

function addExposure(map, key, value) {
  const normalizedKey = key || "unknown";
  const current = map.get(normalizedKey) || 0;
  map.set(normalizedKey, current + (isFiniteNumber(value) ? value : 0));
}

function mapToSortedRows(map, totalCapital) {
  return [...map.entries()]
    .map(([label, value]) => ({
      label,
      pct: isFiniteNumber(totalCapital) && totalCapital > 0 ? (value / totalCapital) * 100 : null,
      value
    }))
    .sort((left, right) => {
      if (right.value !== left.value) {
        return right.value - left.value;
      }

      return compareText(left.label, right.label);
    });
}

function summarizeExposures(estimatedPositions, capital) {
  const byTicker = new Map();
  const byAssetType = new Map();
  const bySector = new Map();
  let biotechCatalystExposure = 0;
  let catalystExposure = 0;
  let cryptoExposure = 0;
  let shortExposure = 0;
  let speculativeExposure = 0;

  estimatedPositions.forEach((position) => {
    const grossValue = isFiniteNumber(position.grossValue) ? position.grossValue : 0;
    addExposure(byTicker, position.ticker || "UNKNOWN", grossValue);
    addExposure(byAssetType, position.assetType, grossValue);
    addExposure(bySector, position.sector, grossValue);

    if (position.isBiotechCatalyst) {
      biotechCatalystExposure += grossValue;
    }

    if (position.isCatalystDriven) {
      catalystExposure += grossValue;
    }

    if (position.isCrypto) {
      cryptoExposure += grossValue;
    }

    if (position.direction === "short") {
      shortExposure += grossValue;
    }

    if (position.isSpeculative) {
      speculativeExposure += grossValue;
    }
  });

  return {
    biotechCatalystExposure,
    biotechCatalystPct: pctOf(biotechCatalystExposure, capital.totalCapital),
    byAssetType: mapToSortedRows(byAssetType, capital.totalCapital),
    bySector: mapToSortedRows(bySector, capital.totalCapital),
    byTicker: mapToSortedRows(byTicker, capital.totalCapital),
    catalystExposure,
    catalystPct: pctOf(catalystExposure, capital.totalCapital),
    cryptoExposure,
    cryptoPct: pctOf(cryptoExposure, capital.totalCapital),
    shortExposure,
    shortPct: pctOf(shortExposure, capital.totalCapital),
    speculativeExposure,
    speculativePct: pctOf(speculativeExposure, capital.totalCapital)
  };
}

function pctOf(value, total) {
  if (!isFiniteNumber(value) || !isFiniteNumber(total) || total <= 0) {
    return null;
  }

  return (value / total) * 100;
}

function getRiskWarnings(exposures, riskRules, capital) {
  const warnings = [];

  if (!capital.reliable) {
    warnings.push("Capital/cash incompleto: los porcentajes usan solo exposicion conocida.");
  }

  Object.entries(riskRules).forEach(([ruleName, rule]) => {
    if (!isFiniteNumber(rule.value)) {
      warnings.push(`${ruleName} no esta definido en settings.`);
    }
  });

  exposures.byTicker.forEach((row) => {
    const limit = riskRules.maxPositionPct.value;
    if (isFiniteNumber(row.pct) && isFiniteNumber(limit) && row.pct > limit) {
      warnings.push(`${row.label} supera maxPositionPct (${formatPercent(row.pct)} > ${formatPercent(limit)}).`);
    }
  });

  exposures.bySector.forEach((row) => {
    const limit = riskRules.maxSectorPct.value;
    if (row.label !== "unknown" && isFiniteNumber(row.pct) && isFiniteNumber(limit) && row.pct > limit) {
      warnings.push(`Sector ${row.label} supera maxSectorPct (${formatPercent(row.pct)} > ${formatPercent(limit)}).`);
    }
  });

  if (
    isFiniteNumber(exposures.biotechCatalystPct) &&
    isFiniteNumber(riskRules.maxBiotechPct.value) &&
    exposures.biotechCatalystPct > riskRules.maxBiotechPct.value
  ) {
    warnings.push(
      `Biotech/FDA supera maxBiotechPct (${formatPercent(exposures.biotechCatalystPct)} > ${formatPercent(riskRules.maxBiotechPct.value)}).`
    );
  }

  if (
    isFiniteNumber(exposures.speculativePct) &&
    isFiniteNumber(riskRules.maxSpeculativePct.value) &&
    exposures.speculativePct > riskRules.maxSpeculativePct.value
  ) {
    warnings.push(
      `Especulativo supera maxSpeculativePct (${formatPercent(exposures.speculativePct)} > ${formatPercent(riskRules.maxSpeculativePct.value)}).`
    );
  }

  if (
    isFiniteNumber(exposures.shortPct) &&
    isFiniteNumber(riskRules.maxShortPct.value) &&
    exposures.shortPct > riskRules.maxShortPct.value
  ) {
    warnings.push(`Short supera maxShortPct (${formatPercent(exposures.shortPct)} > ${formatPercent(riskRules.maxShortPct.value)}).`);
  }

  warnings.push("maxDailyLossPct y maxWeeklyLossPct no se pueden validar sin P&L diario/semanal local.");

  return [...new Set(warnings)];
}

function getFileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (error) {
    return 0;
  }
}

function walkFiles(directory, depth = 0) {
  if (depth > 4 || !fs.existsSync(directory)) {
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

function matchScanPattern(filePath) {
  const normalizedPath = filePath.split(path.sep).join("/").toLowerCase();

  return SCAN_PATTERNS.find((pattern) =>
    pattern.pathHints.some((hint) => normalizedPath.includes(hint))
  ) || null;
}

function findScanFiles() {
  if (!fs.existsSync(BACKTESTS_DIR)) {
    return [];
  }

  const files = walkFiles(BACKTESTS_DIR)
    .filter((filePath) => {
      const fileName = path.basename(filePath);
      const pattern = matchScanPattern(filePath);
      return Boolean(pattern && pattern.preferredFiles.includes(fileName));
    })
    .map((filePath) => ({
      filePath,
      mtime: getFileMtime(filePath),
      pattern: matchScanPattern(filePath)
    }))
    .sort((left, right) => {
      if (left.pattern.label !== right.pattern.label) {
        return compareText(left.pattern.label, right.pattern.label);
      }

      const leftPriority = left.pattern.preferredFiles.indexOf(path.basename(left.filePath));
      const rightPriority = right.pattern.preferredFiles.indexOf(path.basename(right.filePath));

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return right.mtime - left.mtime;
    });

  const selected = new Map();
  files.forEach((file) => {
    if (!selected.has(file.pattern.label)) {
      selected.set(file.pattern.label, file);
    }
  });

  return [...selected.values()];
}

function readJsonFileSafe(filePath) {
  try {
    return {
      data: JSON.parse(fs.readFileSync(filePath, "utf8")),
      error: null
    };
  } catch (error) {
    return {
      data: null,
      error: error.message
    };
  }
}

function normalizeCatalystTypeFromCandidate(candidate) {
  const direct = normalizeLower(candidate && candidate.catalystType);
  if (direct) {
    return direct;
  }

  const catalyst = Array.isArray(candidate && candidate.catalysts) ? candidate.catalysts[0] : null;
  const currentCatalyst = Array.isArray(candidate && candidate.currentCatalysts) ? candidate.currentCatalysts[0] : null;

  return normalizeLower(
    (catalyst && catalyst.catalystType) ||
      (currentCatalyst && currentCatalyst.catalystType) ||
      ""
  );
}

function normalizeIdeaFromScan(candidate, sourceName, filePath) {
  const market = candidate.marketData || {};
  const local = candidate.localContext || {};
  const ticker = normalizeTicker(candidate.ticker || local.ticker);

  if (!ticker) {
    return null;
  }

  const catalystType = normalizeCatalystTypeFromCandidate(candidate);
  const status =
    normalizeText(candidate.classification) === "discard" ||
    normalizeText(candidate.classification) === "descartada"
      ? "descartar"
      : "nueva oportunidad";
  const merged = {
    ...local,
    ...candidate,
    assetType: candidate.assetType || local.assetType || "equity",
    catalystType,
    lastPrice: coerceNumber(market.price) || coerceNumber(candidate.lastPrice),
    status,
    ticker
  };

  return {
    assetType: getAssetType(merged),
    catalystType,
    classification: normalizeText(candidate.classification, "n/d"),
    direction: sourceName === "short-scan" ? "short" : inferDirection(merged),
    filePath,
    isBiotechCatalyst: isBiotechCatalyst(merged),
    isCatalystDriven: hasCatalyst(merged) || catalystType !== "",
    isCrypto: isCrypto(merged),
    isSpeculative: true,
    lastPrice: merged.lastPrice,
    proposedPct: readFirstNumber(merged, IDEA_SIZE_PATHS).value,
    raw: merged,
    reason: normalizeText(
      candidate.possibleReboundReason ||
        candidate.thesis ||
        candidate.rationale ||
        (Array.isArray(candidate.discoveryReasons) ? candidate.discoveryReasons[0] : "") ||
        (Array.isArray(candidate.rejectReasons) ? candidate.rejectReasons[0] : "") ||
        (Array.isArray(candidate.hardRejectReasons) ? candidate.hardRejectReasons[0] : ""),
      "sin razon documentada"
    ),
    score: coerceNumber(candidate.walyScore) || coerceNumber(candidate.score),
    sector: getSector(merged),
    sourceKind: sourceName,
    status,
    ticker
  };
}

function readScanIdeas() {
  const files = findScanFiles();
  const loaded = [];
  const ideas = [];
  const errors = [];

  files.forEach((file) => {
    const result = readJsonFileSafe(file.filePath);
    loaded.push({
      filePath: file.filePath,
      sourceKind: file.pattern.label
    });

    if (result.error) {
      errors.push(`${formatRelative(file.filePath)}: ${result.error}`);
      return;
    }

    const candidates = Array.isArray(result.data)
      ? result.data
      : Array.isArray(result.data && result.data.candidates)
        ? result.data.candidates
        : [];

    candidates.forEach((candidate) => {
      const idea = normalizeIdeaFromScan(candidate, file.pattern.label, file.filePath);
      if (idea) {
        ideas.push(idea);
      }
    });
  });

  return {
    errors,
    ideas,
    loaded
  };
}

function normalizeIdeaFromWatchlist(item) {
  const ticker = normalizeTicker(item && item.ticker);
  if (!ticker) {
    return null;
  }

  return {
    assetType: getAssetType(item),
    catalystType: normalizeLower(item && item.catalystType),
    classification: normalizeText(item && item.setupRank, "n/d"),
    direction: inferDirection(item || {}),
    filePath: null,
    isBiotechCatalyst: isBiotechCatalyst(item),
    isCatalystDriven: hasCatalyst(item),
    isCrypto: isCrypto(item),
    isSpeculative: isSpeculative(item),
    lastPrice: coerceNumber(item && item.lastPrice),
    proposedPct: readFirstNumber(item || {}, IDEA_SIZE_PATHS).value,
    raw: item,
    reason: normalizeText((item && (item.rationale || item.thesis || item.catalyst)) || "", "sin razon documentada"),
    score: coerceNumber(item && item.rankingScore),
    sector: getSector(item),
    sourceKind: "watchlist",
    status: normalizeText(item && item.status, "observar"),
    ticker
  };
}

function buildIdeas(watchlist, scanIdeas) {
  const watchlistIdeas = (watchlist.watchlist || [])
    .map(normalizeIdeaFromWatchlist)
    .filter(Boolean);

  return [...watchlistIdeas, ...scanIdeas].sort((left, right) => {
    const leftPriority = coerceNumber(left.raw && left.raw.priority) || 999;
    const rightPriority = coerceNumber(right.raw && right.raw.priority) || 999;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return compareText(left.ticker, right.ticker);
  });
}

function summarizeOutcomes(outcomes) {
  const byTicker = new Map();
  const byPlaybook = new Map();

  (outcomes.outcomes || []).forEach((outcome) => {
    const ticker = normalizeTicker(outcome.ticker);
    const playbook = normalizeText(outcome.playbookType, "sin-playbook");

    if (ticker) {
      const current = byTicker.get(ticker) || [];
      current.push(outcome);
      byTicker.set(ticker, current);
    }

    const currentPlaybook = byPlaybook.get(playbook) || {
      failures: 0,
      mixed: 0,
      resolved: 0,
      wins: 0
    };

    if (outcome.outcomeLabel === "funciono") {
      currentPlaybook.wins += 1;
      currentPlaybook.resolved += 1;
    } else if (outcome.outcomeLabel === "fallo") {
      currentPlaybook.failures += 1;
      currentPlaybook.resolved += 1;
    } else if (outcome.outcomeLabel === "mixto") {
      currentPlaybook.mixed += 1;
      currentPlaybook.resolved += 1;
    }

    byPlaybook.set(playbook, currentPlaybook);
  });

  return {
    byPlaybook,
    byTicker
  };
}

function getExistingTickerPct(ticker, exposures) {
  const row = exposures.byTicker.find((item) => item.label === ticker);
  return row && isFiniteNumber(row.pct) ? row.pct : 0;
}

function evaluateLimit({ currentPct, label, limit, proposedPct }) {
  if (!isFiniteNumber(limit)) {
    return {
      ok: false,
      reason: `${label} no definido`
    };
  }

  if (!isFiniteNumber(proposedPct)) {
    return {
      ok: false,
      reason: "sin sizing propuesto"
    };
  }

  const nextPct = currentPct + proposedPct;
  if (nextPct > limit) {
    return {
      ok: false,
      reason: `${label} excedido (${formatPercent(nextPct)} > ${formatPercent(limit)})`
    };
  }

  return {
    ok: true,
    reason: `${label} ok (${formatPercent(nextPct)} <= ${formatPercent(limit)})`
  };
}

function classifyIdeaAction(idea, checks, options) {
  if (idea.status === "descartar" || ["discard", "descartada"].includes(normalizeLower(idea.classification))) {
    return "no operar";
  }

  if (options.alreadyInPortfolio && !checks.allPass) {
    return "vigilar";
  }

  if (options.alreadyInPortfolio && checks.allPass) {
    return "aumentar solo si cumple reglas";
  }

  if (!checks.allPass) {
    return "vigilar";
  }

  return "preparar orden manual";
}

function analyzeIdeaRisk(idea, context) {
  const { capital, estimatedPositions, exposures, riskRules } = context;
  const alreadyInPortfolio = estimatedPositions.some((position) => position.ticker === idea.ticker);
  const blockers = [];
  const passes = [];
  const proposedPct = idea.proposedPct;
  const existingTickerPct = getExistingTickerPct(idea.ticker, exposures);

  if (!capital.reliable) {
    blockers.push("capital/cash no fiable en settings");
  }

  const positionCheck = evaluateLimit({
    currentPct: existingTickerPct,
    label: "maxPositionPct",
    limit: riskRules.maxPositionPct.value,
    proposedPct
  });
  (positionCheck.ok ? passes : blockers).push(positionCheck.reason);

  if (idea.sector !== "unknown") {
    const currentSector = exposures.bySector.find((row) => row.label === idea.sector);
    const sectorCheck = evaluateLimit({
      currentPct: currentSector && isFiniteNumber(currentSector.pct) ? currentSector.pct : 0,
      label: "maxSectorPct",
      limit: riskRules.maxSectorPct.value,
      proposedPct
    });
    (sectorCheck.ok ? passes : blockers).push(sectorCheck.reason);
  } else if (!isFiniteNumber(riskRules.maxSectorPct.value)) {
    blockers.push("maxSectorPct no definido");
  }

  if (idea.isBiotechCatalyst) {
    const biotechCheck = evaluateLimit({
      currentPct: exposures.biotechCatalystPct || 0,
      label: "maxBiotechPct",
      limit: riskRules.maxBiotechPct.value,
      proposedPct
    });
    (biotechCheck.ok ? passes : blockers).push(biotechCheck.reason);
  }

  if (idea.isSpeculative) {
    const speculativeCheck = evaluateLimit({
      currentPct: exposures.speculativePct || 0,
      label: "maxSpeculativePct",
      limit: riskRules.maxSpeculativePct.value,
      proposedPct
    });
    (speculativeCheck.ok ? passes : blockers).push(speculativeCheck.reason);
  }

  if (idea.direction === "short") {
    const shortCheck = evaluateLimit({
      currentPct: exposures.shortPct || 0,
      label: "maxShortPct",
      limit: riskRules.maxShortPct.value,
      proposedPct
    });
    (shortCheck.ok ? passes : blockers).push(shortCheck.reason);
  }

  if (!idea.isCatalystDriven && idea.sourceKind !== "reversal-scan" && idea.sourceKind !== "short-scan") {
    blockers.push("sin catalyst documentado");
  }

  const allPass = blockers.length === 0 && passes.length > 0;
  const action = classifyIdeaAction(idea, { allPass }, { alreadyInPortfolio });

  return {
    action,
    alreadyInPortfolio,
    blockers: [...new Set(blockers)],
    passes: [...new Set(passes)],
    proposedPct,
    riskLabel: isFiniteNumber(proposedPct) ? `+${formatPercent(proposedPct)}` : "n/d"
  };
}

function renderRows(rows, emptyMessage) {
  if (rows.length === 0) {
    return [`- ${emptyMessage}`];
  }

  return rows.map((row) => `- ${row.label}: ${formatMoney(row.value)} | ${formatPercent(row.pct)}`);
}

function renderPortfolioReview(analysis) {
  const {
    capital,
    currentDate,
    estimatedPositions,
    exposures,
    ideas,
    projectName,
    riskRules,
    riskWarnings,
    scanOutputs
  } = analysis;
  const lines = [];

  lines.push(`# WALY Portfolio Engine`);
  lines.push("");
  lines.push(`Fecha local: ${currentDate}`);
  lines.push(`Proyecto: ${projectName}`);
  lines.push("Modo: read-only; no opera, no toca positions/outcomes, no usa IBKR ni Binance.");
  lines.push("");
  lines.push("1. Estado de cartera");
  lines.push(`- Capital total estimado: ${formatMoney(capital.totalCapital)} | base: ${capital.basis}`);
  lines.push(`- Cash/yield estimado: cash ${formatMoney(capital.cash.value)}${capital.cash.path ? ` (${capital.cash.path})` : " (no cargado en settings)"} | yield ${formatRule(capital.yieldPct.value)}`);
  lines.push(`- Valor neto posiciones: ${formatMoney(capital.netPositionValue)} | exposicion bruta: ${formatMoney(capital.grossPositionValue)}`);

  if (estimatedPositions.length === 0) {
    lines.push("- Posiciones abiertas: cartera vacia.");
  } else {
    estimatedPositions.forEach((position) => {
      lines.push(
        `- ${position.ticker}: ${position.status} | ${position.direction} | ${position.assetType} | qty ${isFiniteNumber(position.quantity) ? position.quantity : "n/d"} | px ${formatMoney(position.price)} (${position.priceSource}) | exposicion ${formatMoney(position.grossValue)}`
      );
    });
  }

  lines.push("");
  lines.push("2. Riesgo actual");
  lines.push("- Reglas:");
  Object.entries(riskRules).forEach(([ruleName, rule]) => {
    lines.push(`  - ${ruleName}: ${formatRule(rule.value)}${rule.path ? ` (${rule.path})` : " (no definido)"}`);
  });
  lines.push("- Exposicion por ticker:");
  lines.push(...renderRows(exposures.byTicker, "Sin exposicion por ticker."));
  lines.push("- Exposicion por assetType:");
  lines.push(...renderRows(exposures.byAssetType, "Sin exposicion por assetType."));
  lines.push("- Exposiciones especiales:");
  lines.push(`- Biotech/FDA: ${formatMoney(exposures.biotechCatalystExposure)} | ${formatPercent(exposures.biotechCatalystPct)}`);
  lines.push(`- Catalyst-driven total: ${formatMoney(exposures.catalystExposure)} | ${formatPercent(exposures.catalystPct)}`);
  lines.push(`- Short: ${formatMoney(exposures.shortExposure)} | ${formatPercent(exposures.shortPct)}`);
  lines.push(`- Crypto: ${formatMoney(exposures.cryptoExposure)} | ${formatPercent(exposures.cryptoPct)}`);
  lines.push(`- Especulativo: ${formatMoney(exposures.speculativeExposure)} | ${formatPercent(exposures.speculativePct)}`);
  lines.push("- Warnings:");
  riskWarnings.forEach((warning) => lines.push(`- ${warning}`));
  if (scanOutputs.loaded.length > 0) {
    lines.push("- Scan outputs leidos:");
    scanOutputs.loaded.forEach((item) => lines.push(`- ${item.sourceKind}: ${formatRelative(item.filePath)}`));
  } else {
    lines.push("- Scan outputs leidos: ninguno local para live-scan/reversal-scan/short-scan.");
  }
  scanOutputs.errors.forEach((error) => lines.push(`- Scan output error: ${error}`));

  lines.push("");
  lines.push("3. Ideas disponibles");
  if (ideas.length === 0) {
    lines.push("- No hay ideas disponibles fuera de cartera.");
  } else {
    ideas.forEach((idea) => {
      const blockers = idea.risk.blockers.length > 0 ? idea.risk.blockers.slice(0, 4).join("; ") : "sin bloqueos";
      const existing = idea.risk.alreadyInPortfolio ? " | ya en cartera" : "";
      lines.push(
        `- ${idea.ticker} [${idea.sourceKind}]${existing}: ${idea.status}/${idea.classification} | accion ${idea.risk.action} | riesgo marginal ${idea.risk.riskLabel} | ${blockers} | ${idea.reason}`
      );
    });
  }

  const actionableOrders = ideas.filter((idea) => idea.risk.action === "preparar orden manual");
  const watchIdeas = ideas.filter((idea) => idea.risk.action === "vigilar");
  const reducePositions = riskWarnings.filter((warning) => warning.includes("supera max"));
  const openTickers = estimatedPositions.map((position) => position.ticker).filter(Boolean);

  lines.push("");
  lines.push("4. Que hacer hoy");
  if (reducePositions.length > 0) {
    lines.push("- Reducir solo de forma manual donde haya exceso confirmado por reglas.");
  } else {
    lines.push("- No operar: no hay exceso validado ni orden sugerida por reglas completas.");
  }
  lines.push(
    openTickers.length > 0
      ? `- Vigilar posiciones abiertas primero: ${openTickers.join(", ")}.`
      : "- Cartera sin posiciones abiertas; mantener disciplina de cash primero."
  );
  if (watchIdeas.length > 0) {
    lines.push(`- Vigilar ${watchIdeas.map((idea) => idea.ticker).join(", ")} hasta tener sizing, cash/capital y reglas completas.`);
  }
  lines.push("- Mantener cash/yield como default mientras falten limites o datos verificables.");

  lines.push("");
  lines.push("5. Que NO hacer");
  lines.push("- No ejecutar ordenes ni automatizar trading.");
  lines.push("- No usar IBKR, Binance ni conectores de ejecucion.");
  lines.push("- No aumentar una idea sin proposedPositionPct/riskBudgetPct y sin pasar todos los limites.");
  lines.push("- No dejar que social discovery domine la decision sin data/catalyst/liquidez.");
  lines.push("- No tocar positions.json ni outcomes.json desde este comando.");

  lines.push("");
  lines.push("6. Ordenes sugeridas");
  if (actionableOrders.length === 0) {
    lines.push("- Ninguna. No hay propuesta manual que pase reglas completas.");
  } else {
    actionableOrders.forEach((idea) => {
      lines.push(
        `- PROPUESTA MANUAL, NO EJECUCION: ${idea.ticker} | ${idea.risk.riskLabel} | revisar ticket manual antes de cualquier orden.`
      );
    });
  }

  return `${lines.join("\n")}\n`;
}

function runPortfolioReview() {
  const settings = readJson("settings.json");
  const positions = readJson("positions.json");
  const watchlist = readJson("watchlist.json");
  const outcomes = readJson("outcomes.json");
  const estimatedPositions = (positions.positions || []).map(estimatePosition);
  const capital = estimateCapital(settings, estimatedPositions);
  const exposures = summarizeExposures(estimatedPositions, capital);
  const riskRules = readRiskRules(settings);
  const riskWarnings = getRiskWarnings(exposures, riskRules, capital);
  const scanOutputs = readScanIdeas();
  const outcomesSummary = summarizeOutcomes(outcomes);
  const ideas = buildIdeas(watchlist, scanOutputs.ideas).map((idea) => ({
    ...idea,
    outcomes: outcomesSummary.byTicker.get(idea.ticker) || [],
    risk: analyzeIdeaRisk(idea, {
      capital,
      estimatedPositions,
      exposures,
      riskRules
    })
  }));
  const analysis = {
    capital,
    currentDate: getCurrentDateInTimezone(settings.timezone),
    estimatedPositions,
    exposures,
    ideas,
    outcomesSummary,
    projectName: settings.projectName || "WALY",
    riskRules,
    riskWarnings,
    scanOutputs
  };

  return {
    analysis,
    consoleReport: renderPortfolioReview(analysis)
  };
}

module.exports = {
  runPortfolioReview
};
