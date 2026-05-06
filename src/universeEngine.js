"use strict";

const { fetchSavedFinvizScreens } = require("./connectors/finviz");
const { fetchSavedOpenInsiderScreens } = require("./connectors/openinsider");
const { fetchRecentFdaCatalysts } = require("./connectors/openfda");
const { fetchEarningsCatalysts, fetchMarketSnapshotCandidates } = require("./connectors/polygon");
const { fetchRecentInsiderCatalysts } = require("./connectors/sec");
const { loadState } = require("./state");
const { readJson, writeJson } = require("./storage");
const { isFiniteNumber, isNonEmptyString, normalizeTicker, validateWatchlist } = require("./validators");

function shiftDate(dateOnly, dayOffset) {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function dedupeStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function toProviderStatus(name, status, message, extra = {}) {
  return {
    message: message || "",
    provider: name,
    status,
    ...extra
  };
}

function getConnectorConfig(settings) {
  const connectors = settings.connectors || {};
  const syncUniverse = connectors.syncUniverse || {};

  return {
    finviz: {
      apiToken: process.env.FINVIZ_API_TOKEN || ((connectors.finviz || {}).apiToken || ""),
      enabled: (connectors.finviz || {}).enabled !== false,
      savedScreens: (connectors.finviz || {}).savedScreens || [],
      timeoutMs: (connectors.finviz || {}).timeoutMs || 20000
    },
    openinsider: {
      enabled: (connectors.openinsider || {}).enabled !== false,
      savedScreens: (connectors.openinsider || {}).savedScreens || [],
      timeoutMs: (connectors.openinsider || {}).timeoutMs || 20000,
      userAgent: (connectors.openinsider || {}).userAgent || "Mozilla/5.0"
    },
    openfda: {
      apiKey: process.env.OPENFDA_API_KEY || ((connectors.openfda || {}).apiKey || ""),
      baseUrl: (connectors.openfda || {}).baseUrl || "https://api.fda.gov",
      companyMap: (connectors.openfda || {}).companyMap || {},
      enabled: (connectors.openfda || {}).enabled !== false,
      limitPerCompany: (connectors.openfda || {}).limitPerCompany || 5,
      maxCompaniesPerSync: (connectors.openfda || {}).maxCompaniesPerSync || 15,
      timeoutMs: (connectors.openfda || {}).timeoutMs || 20000
    },
    polygon: {
      apiKey: process.env.POLYGON_API_KEY || ((connectors.polygon || {}).apiKey || ""),
      baseUrl: (connectors.polygon || {}).baseUrl || "https://api.polygon.io",
      enabled: (connectors.polygon || {}).enabled !== false,
      marketSnapshotLimit: (connectors.polygon || {}).marketSnapshotLimit || 50,
      seedMode: (connectors.polygon || {}).seedMode || "full-market",
      timeoutMs: (connectors.polygon || {}).timeoutMs || 20000
    },
    sec: {
      baseUrl: (connectors.sec || {}).baseUrl || "https://data.sec.gov",
      enabled: (connectors.sec || {}).enabled !== false,
      formTypes: (connectors.sec || {}).formTypes || ["4", "4/A"],
      maxTickersPerSync: (connectors.sec || {}).maxTickersPerSync || 25,
      requestDelayMs: (connectors.sec || {}).requestDelayMs || 150,
      tickerMapUrl: (connectors.sec || {}).tickerMapUrl || "https://www.sec.gov/files/company_tickers_exchange.json",
      timeoutMs: (connectors.sec || {}).timeoutMs || 20000,
      userAgent:
        process.env.SEC_USER_AGENT ||
        ((connectors.sec || {}).userAgent || "WALY Outlier Hunt/1.3 research@local.dev")
    },
    syncUniverse: {
      candidateLimit: syncUniverse.candidateLimit || 30,
      earningsHorizonDays: syncUniverse.earningsHorizonDays || 30,
      fdaLookbackDays: syncUniverse.fdaLookbackDays || 45,
      insiderLookbackDays: syncUniverse.insiderLookbackDays || 21,
      minAbsoluteDayChangePct: syncUniverse.minAbsoluteDayChangePct || 4,
      minDollarVolume: syncUniverse.minDollarVolume || 10000000,
      minPrice: syncUniverse.minPrice || 2,
      minRelativeVolume: syncUniverse.minRelativeVolume || 1.25,
      nextReviewOffsetDays: syncUniverse.nextReviewOffsetDays || 2
    }
  };
}

function collectSeedTickers(state) {
  const tickers = [
    ...(state.positions.positions || []).map((item) => item.ticker),
    ...(state.watchlist.watchlist || []).map((item) => item.ticker),
    ...((state.socialSignals.signals || []).map((item) => item.ticker))
  ];

  return [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
}

function getLocalTrackedMap(state) {
  const map = new Map();

  [...(state.positions.positions || []), ...(state.watchlist.watchlist || [])].forEach((item) => {
    const ticker = normalizeTicker(item.ticker);

    if (!ticker) {
      return;
    }

    map.set(ticker, item);
  });

  return map;
}

function getLocalSocialSummary(state) {
  const summary = new Map();

  (state.socialSignals.signals || []).forEach((signal) => {
    const ticker = normalizeTicker(signal.ticker);

    if (!ticker) {
      return;
    }

    const current = summary.get(ticker) || {
      crowdingRisk: 0,
      mentionCount: 0,
      platforms: [],
      score: 0
    };

    current.crowdingRisk = Math.max(current.crowdingRisk, signal.crowdingRisk || 0);
    current.mentionCount += 1;
    current.platforms.push(signal.sourcePlatform);
    current.score = Math.min(5, current.score + (signal.verificationStatus === "verified" ? 1.5 : 0.75));
    summary.set(ticker, current);
  });

  return summary;
}

function ensureCandidate(map, ticker) {
  const normalizedTicker = normalizeTicker(ticker);

  if (!normalizedTicker) {
    return null;
  }

  if (!map.has(normalizedTicker)) {
    map.set(normalizedTicker, {
      breakoutReadiness: 1,
      candidateLabel: "discovery",
      catalyst: "",
      catalystDate: null,
      catalystStrength: 1,
      catalystType: null,
      companyName: "",
      crowdingRisk: 1,
      discoveryReasons: [],
      discoveryScore: 0,
      downsideClarity: 2,
      exchange: "",
      insiderSupport: 1,
      lastPrice: null,
      liquidityQuality: 1,
      market: "US",
      momentumQuality: 1,
      notes: "",
      priority: 99,
      rationale: "Discovery candidate generado por WALY sync-universe.",
      reratingPotential: 2,
      setupType: "universe-discovery",
      socialDiscoveryScore: 0,
      source: "",
      sourceTags: [],
      status: "observar",
      thesis: "Candidato inicial para validar con catalyst, liquidez y estructura.",
      ticker: normalizedTicker
    });
  }

  return map.get(normalizedTicker);
}

function applyLocalTrackedData(candidate, tracked) {
  if (!tracked) {
    return;
  }

  candidate.priority = Math.min(candidate.priority, tracked.priority || 99);
  candidate.status = tracked.status || candidate.status;
  candidate.thesis = tracked.thesis || candidate.thesis;
  candidate.rationale = tracked.rationale || tracked.notes || candidate.rationale;
  candidate.catalyst = tracked.catalyst || candidate.catalyst;
  candidate.catalystType = tracked.catalystType || candidate.catalystType;
  candidate.catalystDate = tracked.catalystDate || tracked.catalystWindow || candidate.catalystDate;
  candidate.lastPrice = isFiniteNumber(tracked.lastPrice) ? tracked.lastPrice : candidate.lastPrice;
  candidate.notes = tracked.notes || candidate.notes;
  candidate.source = tracked.source || candidate.source;
  candidate.catalystStrength = Math.max(candidate.catalystStrength, tracked.catalystStrength || 0);
  candidate.liquidityQuality = Math.max(candidate.liquidityQuality, tracked.liquidityQuality || 0);
  candidate.momentumQuality = Math.max(candidate.momentumQuality, tracked.momentumQuality || 0);
  candidate.breakoutReadiness = Math.max(candidate.breakoutReadiness, tracked.breakoutReadiness || 0);
  candidate.reratingPotential = Math.max(candidate.reratingPotential, tracked.reratingPotential || 0);
  candidate.insiderSupport = Math.max(candidate.insiderSupport, tracked.insiderSupport || 0);
  candidate.socialDiscoveryScore = Math.max(candidate.socialDiscoveryScore, tracked.socialDiscoveryScore || 0);
  candidate.crowdingRisk = Math.max(candidate.crowdingRisk, tracked.crowdingRisk || 0);
  candidate.downsideClarity = Math.max(candidate.downsideClarity, tracked.downsideClarity || 0);
  candidate.setupType = tracked.setupType || candidate.setupType;
  candidate.sourceTags.push("local-tracking");
  candidate.discoveryReasons.push("Ya existe en posiciones/watchlist de WALY.");
}

function applyMarketCandidate(candidate, marketCandidate, sourceTag) {
  candidate.companyName = candidate.companyName || marketCandidate.companyName || "";
  candidate.lastPrice = marketCandidate.lastPrice || candidate.lastPrice;
  candidate.liquidityQuality = Math.max(candidate.liquidityQuality, marketCandidate.liquidityQuality || 0);
  candidate.momentumQuality = Math.max(candidate.momentumQuality, marketCandidate.momentumQuality || 0);
  candidate.breakoutReadiness = Math.max(candidate.breakoutReadiness, marketCandidate.breakoutReadiness || 0);
  candidate.sourceTags.push(sourceTag);

  if (marketCandidate.relativeVolume >= 1.25) {
    candidate.discoveryReasons.push(`Volumen relativo ${marketCandidate.relativeVolume}x.`);
  }

  if (Math.abs(marketCandidate.dayChangePct) >= 4) {
    candidate.discoveryReasons.push(`Movimiento diario ${marketCandidate.dayChangePct}%.`);
  }

  if (Math.abs(marketCandidate.gapPct || 0) >= 3) {
    candidate.discoveryReasons.push(`Gap ${marketCandidate.gapPct}%.`);
  }
}

function applyDiscoveryCandidate(candidate, discoveryCandidate, sourceTag) {
  candidate.companyName = candidate.companyName || discoveryCandidate.companyName || "";
  candidate.lastPrice = discoveryCandidate.lastPrice || candidate.lastPrice;
  candidate.liquidityQuality = Math.max(candidate.liquidityQuality, discoveryCandidate.liquidityQuality || 0);
  candidate.momentumQuality = Math.max(candidate.momentumQuality, discoveryCandidate.momentumQuality || 0);
  candidate.breakoutReadiness = Math.max(candidate.breakoutReadiness, discoveryCandidate.breakoutReadiness || 0);
  candidate.reratingPotential = Math.max(candidate.reratingPotential, discoveryCandidate.reratingPotential || 0);
  candidate.socialDiscoveryScore = Math.max(
    candidate.socialDiscoveryScore,
    discoveryCandidate.socialDiscoveryScore || 0
  );
  candidate.crowdingRisk = Math.max(candidate.crowdingRisk, discoveryCandidate.crowdingRisk || 0);
  candidate.insiderSupport = Math.max(candidate.insiderSupport, discoveryCandidate.insiderSupport || 0);
  candidate.sourceTags.push(sourceTag, ...(discoveryCandidate.sourceTags || []));

  if (!candidate.catalystType && discoveryCandidate.catalystType) {
    candidate.catalystType = discoveryCandidate.catalystType;
  }

  if (!candidate.catalystDate && discoveryCandidate.catalystDate) {
    candidate.catalystDate = discoveryCandidate.catalystDate;
  }

  if (!candidate.catalyst && discoveryCandidate.notes) {
    candidate.catalyst = discoveryCandidate.notes;
  }

  candidate.catalystStrength = Math.max(candidate.catalystStrength, discoveryCandidate.catalystStrength || 0);
  candidate.discoveryReasons.push(...(discoveryCandidate.discoveryReasons || []));
}

function applySocialSummary(candidate, socialSummary) {
  if (!socialSummary) {
    return;
  }

  candidate.socialDiscoveryScore = Math.max(candidate.socialDiscoveryScore, socialSummary.score || 0);
  candidate.crowdingRisk = Math.max(candidate.crowdingRisk, socialSummary.crowdingRisk || 0);
  candidate.sourceTags.push("local-social");

  if (socialSummary.mentionCount > 0) {
    candidate.discoveryReasons.push(
      `${socialSummary.mentionCount} social signals locales en ${dedupeStrings(socialSummary.platforms).join(", ")}.`
    );
  }
}

function applyCatalyst(candidate, catalyst) {
  const strengthByType = {
    earnings: 4,
    fda: 5,
    insider: 3
  };

  candidate.catalyst = candidate.catalyst || catalyst.notes || `${catalyst.catalystType} catalyst`;
  candidate.catalystType = candidate.catalystType || catalyst.catalystType;
  candidate.catalystDate = candidate.catalystDate || catalyst.catalystDate;
  candidate.catalystStrength = Math.max(candidate.catalystStrength, strengthByType[catalyst.catalystType] || 2);
  candidate.sourceTags.push(catalyst.catalystType);
  candidate.discoveryReasons.push(`${catalyst.catalystType} verificable en ${catalyst.catalystDate || "fecha n/d"}.`);

  if (catalyst.catalystType === "insider") {
    candidate.insiderSupport = Math.max(candidate.insiderSupport, 3);
  }

  if (catalyst.catalystType === "fda") {
    candidate.reratingPotential = Math.max(candidate.reratingPotential, 4);
  }

  if (catalyst.catalystType === "earnings") {
    candidate.reratingPotential = Math.max(candidate.reratingPotential, 3);
  }
}

function applyCompanyMetadata(candidate, company) {
  if (!company) {
    return;
  }

  candidate.companyName = candidate.companyName || company.companyName || "";
  candidate.exchange = candidate.exchange || company.exchange || "";
}

function finalizeCandidate(candidate, currentDate, nextReviewOffsetDays) {
  candidate.sourceTags = dedupeStrings(candidate.sourceTags);
  candidate.discoveryReasons = dedupeStrings(candidate.discoveryReasons);
  candidate.source = candidate.source || candidate.sourceTags.join(", ");
  candidate.nextReviewAt = shiftDate(currentDate, nextReviewOffsetDays);
  candidate.invalidation =
    candidate.invalidation ||
    "Invalidar si se rompe la liquidez, desaparece el catalyst verificable o el precio invalida la estructura.";

  if (!candidate.catalystType) {
    candidate.catalystStrength = Math.min(candidate.catalystStrength, 2);
  }

  if (!candidate.lastPrice || candidate.liquidityQuality <= 1) {
    candidate.downsideClarity = Math.min(candidate.downsideClarity, 2);
  }

  candidate.discoveryScore = Number(
    (
      candidate.catalystStrength * 3 +
      candidate.liquidityQuality * 3 +
      candidate.momentumQuality * 2 +
      candidate.breakoutReadiness * 2 +
      candidate.reratingPotential * 3 +
      candidate.insiderSupport * 1 +
      candidate.socialDiscoveryScore * 1.25 +
      candidate.downsideClarity * 2 -
      candidate.crowdingRisk * 2
    ).toFixed(2)
  );

  return candidate;
}

function toCatalystFeed(existingFeed, incomingCatalysts) {
  const seen = new Set();
  const catalysts = [...(existingFeed.catalysts || []), ...incomingCatalysts]
    .filter((item) => item && item.ticker)
    .sort((left, right) => {
      if ((left.catalystDate || "") !== (right.catalystDate || "")) {
        return (right.catalystDate || "").localeCompare(left.catalystDate || "");
      }

      return normalizeTicker(left.ticker).localeCompare(normalizeTicker(right.ticker));
    })
    .filter((item) => {
      const key = `${normalizeTicker(item.ticker)}|${item.catalystType}|${item.catalystDate || ""}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

  return {
    catalysts,
    updatedAt: new Date().toISOString()
  };
}

function validateGeneratedCandidates(currentDate, candidates) {
  const sanitized = candidates.map((candidate, index) => {
    const cleaned = {
      ...candidate,
      catalyst: candidate.catalyst || `Discovery candidate ${index + 1}`
    };

    Object.keys(cleaned).forEach((key) => {
      if (cleaned[key] === "" || cleaned[key] === null) {
        delete cleaned[key];
      }
    });

    return cleaned;
  });

  const validation = validateWatchlist(
    {
      watchlist: sanitized
    },
    {
      currentDate,
      includeOperationalWarnings: false
    }
  );

  if (validation.errors.length > 0) {
    throw new Error(validation.errors.map((item) => item.message).join("\n"));
  }
}

async function safeCall(providerName, action) {
  try {
    const result = await action();
    return {
      result,
      status: toProviderStatus(providerName, result.status || "ok", result.message || "", {
        count:
          Array.isArray(result.candidates) ? result.candidates.length
          : Array.isArray(result.catalysts) ? result.catalysts.length
          : undefined
      })
    };
  } catch (error) {
    return {
      result: null,
      status: toProviderStatus(providerName, "error", error.message)
    };
  }
}

async function syncUniverse() {
  const state = loadState();
  const config = getConnectorConfig(state.settings);
  const currentDate = state.currentDate;
  const seedTickers = collectSeedTickers(state);
  const localTrackedMap = getLocalTrackedMap(state);
  const localSocialSummary = getLocalSocialSummary(state);
  const providerStatus = {};
  const candidateMap = new Map();

  localTrackedMap.forEach((tracked, ticker) => {
    const candidate = ensureCandidate(candidateMap, ticker);
    applyLocalTrackedData(candidate, tracked);
  });

  const polygonSnapshotCall = await safeCall("polygonSnapshot", () =>
    fetchMarketSnapshotCandidates(config.polygon, config.syncUniverse, seedTickers)
  );
  providerStatus.polygonSnapshot = polygonSnapshotCall.status;

  const finvizCall = await safeCall("finviz", () => fetchSavedFinvizScreens(config.finviz));
  providerStatus.finviz = finvizCall.status;
  const openInsiderCall = await safeCall("openinsider", () => fetchSavedOpenInsiderScreens(config.openinsider));
  providerStatus.openinsider = openInsiderCall.status;

  (polygonSnapshotCall.result && polygonSnapshotCall.result.candidates || []).forEach((item) => {
    const candidate = ensureCandidate(candidateMap, item.ticker);
    applyMarketCandidate(candidate, item, "polygon");
  });

  (finvizCall.result && finvizCall.result.candidates || []).forEach((item) => {
    const candidate = ensureCandidate(candidateMap, item.ticker);
    applyDiscoveryCandidate(candidate, item, "finviz");
  });

  (openInsiderCall.result && openInsiderCall.result.candidates || []).forEach((item) => {
    const candidate = ensureCandidate(candidateMap, item.ticker);
    applyDiscoveryCandidate(candidate, item, "openinsider");
  });

  const candidateTickers = [...new Set([...candidateMap.keys(), ...seedTickers])];
  const insiderLookbackDate = shiftDate(currentDate, -config.syncUniverse.insiderLookbackDays);
  const secCall = await safeCall("sec", () =>
    fetchRecentInsiderCatalysts(config.sec, candidateTickers, {
      lookbackDate: insiderLookbackDate
    })
  );
  providerStatus.sec = secCall.status;

  const tickerMap = (secCall.result && secCall.result.tickerMap) || new Map();
  candidateMap.forEach((candidate) => {
    applyCompanyMetadata(candidate, tickerMap.get(candidate.ticker));
  });

  const fdaCompanies = candidateTickers.map((ticker) => ({
    companyName: (tickerMap.get(ticker) && tickerMap.get(ticker).companyName) || "",
    sponsorName: config.openfda.companyMap[ticker] || "",
    ticker
  }));
  const fdaLookbackDate = shiftDate(currentDate, -config.syncUniverse.fdaLookbackDays);
  const openFdaCall = await safeCall("openfda", () =>
    fetchRecentFdaCatalysts(config.openfda, fdaCompanies, {
      lookbackDate: fdaLookbackDate
    })
  );
  providerStatus.openfda = openFdaCall.status;

  const earningsCall = await safeCall("polygonEarnings", () =>
    fetchEarningsCatalysts(config.polygon, {
      limit: 300
    })
  );
  providerStatus.polygonEarnings = earningsCall.status;

  const earningsHorizonDate = shiftDate(currentDate, config.syncUniverse.earningsHorizonDays);
  const knownCandidateTickers = new Set(candidateMap.keys());
  const filteredEarnings = ((earningsCall.result && earningsCall.result.catalysts) || []).filter((item) => {
    const ticker = normalizeTicker(item.ticker);

    return (
      item.catalystDate &&
      item.catalystDate >= currentDate &&
      item.catalystDate <= earningsHorizonDate &&
      (knownCandidateTickers.has(ticker) || seedTickers.includes(ticker))
    );
  });

  candidateMap.forEach((candidate) => {
    applySocialSummary(candidate, localSocialSummary.get(candidate.ticker));
  });

  ((secCall.result && secCall.result.catalysts) || []).forEach((catalyst) => {
    const candidate = ensureCandidate(candidateMap, catalyst.ticker);
    applyCatalyst(candidate, catalyst);
  });

  (openFdaCall.result && openFdaCall.result.catalysts || []).forEach((catalyst) => {
    const candidate = ensureCandidate(candidateMap, catalyst.ticker);
    applyCatalyst(candidate, catalyst);
  });

  filteredEarnings.forEach((catalyst) => {
    const candidate = ensureCandidate(candidateMap, catalyst.ticker);
    applyCatalyst(candidate, catalyst);
  });

  const candidates = [...candidateMap.values()]
    .map((candidate) => finalizeCandidate(candidate, currentDate, config.syncUniverse.nextReviewOffsetDays))
    .filter((candidate) => candidate.status !== "descartar" || candidate.discoveryScore >= 12)
    .sort((left, right) => {
      if (left.discoveryScore !== right.discoveryScore) {
        return right.discoveryScore - left.discoveryScore;
      }

      return left.ticker.localeCompare(right.ticker);
    })
    .slice(0, config.syncUniverse.candidateLimit)
    .map((candidate, index) => ({
      ...candidate,
      priority: index + 1
    }));

  validateGeneratedCandidates(currentDate, candidates);

  const universePayload = {
    asOfDate: currentDate,
    candidates,
    filters: {
      candidateLimit: config.syncUniverse.candidateLimit,
      earningsHorizonDays: config.syncUniverse.earningsHorizonDays,
      fdaLookbackDays: config.syncUniverse.fdaLookbackDays,
      insiderLookbackDays: config.syncUniverse.insiderLookbackDays,
      minAbsoluteDayChangePct: config.syncUniverse.minAbsoluteDayChangePct,
      minDollarVolume: config.syncUniverse.minDollarVolume,
      minPrice: config.syncUniverse.minPrice,
      minRelativeVolume: config.syncUniverse.minRelativeVolume
    },
    sourceSummary: providerStatus,
    updatedAt: new Date().toISOString()
  };

  writeJson("universe_candidates.json", universePayload);

  const existingEarnings = readJson("earnings.json");
  const existingInsiders = readJson("insiders.json");
  const existingFda = readJson("fda.json");

  if (filteredEarnings.length > 0) {
    writeJson("earnings.json", toCatalystFeed(existingEarnings, filteredEarnings));
  }

  if (secCall.result && secCall.result.catalysts && secCall.result.catalysts.length > 0) {
    writeJson("insiders.json", toCatalystFeed(existingInsiders, secCall.result.catalysts));
  }

  if (openFdaCall.result && openFdaCall.result.catalysts && openFdaCall.result.catalysts.length > 0) {
    writeJson("fda.json", toCatalystFeed(existingFda, openFdaCall.result.catalysts));
  }

  return {
    candidates,
    providerStatus,
    universePath: "data/universe_candidates.json"
  };
}

module.exports = {
  syncUniverse
};
