"use strict";

const {
  BASE_CATALYST_STRENGTH,
  CATALYST_FUTURE_WINDOW_DAYS,
  CATALYST_LABELS,
  CATALYST_NEAR_DAYS,
  CATALYST_RECENT_DAYS,
  SOCIAL_SIGNAL_TYPE_WEIGHTS,
  SOCIAL_VERIFICATION_WEIGHTS,
  SOURCE_PRIORITY
} = require("./constants");
const {
  hasValidUnderlyingConfirmation,
  isEtfAsset,
  isFiniteNumber,
  isNonEmptyString,
  normalizeTextEnum,
  isValidDateOnlyString,
  normalizeTicker,
  parseDateOnlyToUtc
} = require("./validators");

function clampScore(value, min = 0, max = 5) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  return Math.max(min, Math.min(max, value));
}

function normalizeSourceText(value) {
  return isNonEmptyString(value) ? value.trim().toLowerCase() : "";
}

function daysBetween(referenceDate, targetDate) {
  const reference = parseDateOnlyToUtc(referenceDate);
  const target = parseDateOnlyToUtc(targetDate);

  if (!reference || !target) {
    return null;
  }

  return Math.round((target.getTime() - reference.getTime()) / (24 * 60 * 60 * 1000));
}

function getCatalystTiming(daysToCatalyst) {
  if (daysToCatalyst === null) {
    return "sin fecha";
  }

  if (daysToCatalyst < -CATALYST_RECENT_DAYS) {
    return "vencido";
  }

  if (daysToCatalyst < 0) {
    return "reciente";
  }

  if (daysToCatalyst === 0) {
    return "hoy";
  }

  if (daysToCatalyst <= CATALYST_NEAR_DAYS) {
    return "activo";
  }

  if (daysToCatalyst <= CATALYST_FUTURE_WINDOW_DAYS) {
    return "en ventana";
  }

  return "lejano";
}

function formatCatalystTiming(daysToCatalyst) {
  if (daysToCatalyst === null) {
    return "sin fecha confirmada";
  }

  if (daysToCatalyst === 0) {
    return "hoy";
  }

  if (daysToCatalyst > 0) {
    return `en ${daysToCatalyst} dias`;
  }

  return `hace ${Math.abs(daysToCatalyst)} dias`;
}

function getPriorityValue(item, sourceKind) {
  if (Number.isInteger(item.priority) && item.priority >= 1) {
    return item.priority;
  }

  return sourceKind === "position" ? 1 : 99;
}

function compareNullableDays(left, right) {
  if ((left === null) !== (right === null)) {
    return left === null ? 1 : -1;
  }

  return (left || 0) - (right || 0);
}

function compareIngestedRecords(left, right) {
  const dayComparison = compareNullableDays(left.daysToCatalyst, right.daysToCatalyst);

  if (dayComparison !== 0) {
    return dayComparison;
  }

  if (left.ticker !== right.ticker) {
    return left.ticker.localeCompare(right.ticker);
  }

  return left.ingestionKind.localeCompare(right.ingestionKind);
}

function compareSocialSignals(left, right) {
  if (left.relevanceScore !== right.relevanceScore) {
    return right.relevanceScore - left.relevanceScore;
  }

  if (left.timestampMs !== right.timestampMs) {
    return right.timestampMs - left.timestampMs;
  }

  return left.ticker.localeCompare(right.ticker);
}

function createCoverageFlag(code, message, sourceKind, ticker, details = {}) {
  return {
    ...details,
    code,
    message,
    severity: "warning",
    source: sourceKind,
    ticker,
    type: code
  };
}

function buildIngestedCatalystText(item) {
  if (isNonEmptyString(item.notes)) {
    return item.notes;
  }

  return CATALYST_LABELS[item.catalystType] || "catalyst ingerido";
}

function toIngestedRecord(item, ingestionKind, feedUpdatedAt, currentDate) {
  const daysToCatalyst = isValidDateOnlyString(item.catalystDate)
    ? daysBetween(currentDate, item.catalystDate)
    : null;

  return {
    catalyst: buildIngestedCatalystText(item),
    catalystDate: item.catalystDate,
    catalystLabel: CATALYST_LABELS[item.catalystType] || "catalyst",
    catalystText: buildIngestedCatalystText(item),
    catalystTiming: getCatalystTiming(daysToCatalyst),
    catalystTimingLabel: formatCatalystTiming(daysToCatalyst),
    catalystType: item.catalystType,
    daysToCatalyst,
    feedUpdatedAt: feedUpdatedAt || null,
    ingestionKind,
    metadata: item.metadata || {},
    notes: item.notes || "",
    source: item.source,
    ticker: normalizeTicker(item.ticker),
    updatedToday: isNonEmptyString(feedUpdatedAt) && feedUpdatedAt.slice(0, 10) === currentDate
  };
}

function collectIngestedCatalysts(state) {
  const feeds = [
    {
      items: (state.ingestion.earnings && state.ingestion.earnings.catalysts) || [],
      kind: "earnings",
      updatedAt: state.ingestion.earnings && state.ingestion.earnings.updatedAt
    },
    {
      items: (state.ingestion.insiders && state.ingestion.insiders.catalysts) || [],
      kind: "insiders",
      updatedAt: state.ingestion.insiders && state.ingestion.insiders.updatedAt
    },
    {
      items: (state.ingestion.fda && state.ingestion.fda.catalysts) || [],
      kind: "fda",
      updatedAt: state.ingestion.fda && state.ingestion.fda.updatedAt
    }
  ];

  return feeds
    .flatMap((feed) =>
      feed.items.map((item) => toIngestedRecord(item, feed.kind, feed.updatedAt, state.currentDate))
    )
    .sort(compareIngestedRecords);
}

function buildIngestionIndex(ingestedCatalysts) {
  const index = new Map();

  ingestedCatalysts.forEach((record) => {
    const records = index.get(record.ticker) || [];
    records.push(record);
    records.sort(compareIngestedRecords);
    index.set(record.ticker, records);
  });

  return index;
}

function toSocialSignalRecord(signal, currentDate) {
  const timestampMs = Date.parse(signal.timestamp);
  const ageDays = Number.isNaN(timestampMs)
    ? null
    : Math.round((Date.parse(`${currentDate}T00:00:00.000Z`) - timestampMs) / (24 * 60 * 60 * 1000));
  const verificationWeight = SOCIAL_VERIFICATION_WEIGHTS[signal.verificationStatus] || 0;
  const typeWeight = SOCIAL_SIGNAL_TYPE_WEIGHTS[signal.signalType] || 0;
  const independence = clampScore(signal.independenceScore) || 0;
  const relevanceScore = Number((verificationWeight * typeWeight * independence).toFixed(2));

  return {
    ageDays,
    claim: signal.claim,
    crowdingRisk: clampScore(signal.crowdingRisk) || 0,
    independenceScore: independence,
    notes: signal.notes || "",
    relevanceScore,
    sourceHandle: signal.sourceHandle || "",
    sourcePlatform: signal.sourcePlatform,
    signalType: signal.signalType,
    ticker: normalizeTicker(signal.ticker),
    timestamp: signal.timestamp,
    timestampMs,
    verificationStatus: signal.verificationStatus
  };
}

function collectSocialSignals(state) {
  return ((state.socialSignals && state.socialSignals.signals) || [])
    .map((signal) => toSocialSignalRecord(signal, state.currentDate))
    .filter((signal) => signal.ticker)
    .sort(compareSocialSignals);
}

function buildSocialSignalIndex(signals) {
  const index = new Map();

  signals.forEach((signal) => {
    const bucket = index.get(signal.ticker) || [];
    bucket.push(signal);
    bucket.sort(compareSocialSignals);
    index.set(signal.ticker, bucket);
  });

  return index;
}

function pickManualCatalystDate(item) {
  if (isNonEmptyString(item.catalystDate) && isValidDateOnlyString(item.catalystDate)) {
    return item.catalystDate;
  }

  if (isNonEmptyString(item.catalystWindow) && isValidDateOnlyString(item.catalystWindow)) {
    return item.catalystWindow;
  }

  return null;
}

function pickBestIngestedMatch(item, ingestedRecords) {
  if (!ingestedRecords || ingestedRecords.length === 0) {
    return null;
  }

  if (isNonEmptyString(item.catalystType)) {
    const sameType = ingestedRecords.find((record) => record.catalystType === item.catalystType);

    if (sameType) {
      return sameType;
    }
  }

  const manualDate = pickManualCatalystDate(item);

  if (manualDate) {
    const sameDate = ingestedRecords.find((record) => record.catalystDate === manualDate);

    if (sameDate) {
      return sameDate;
    }
  }

  return ingestedRecords[0];
}

function getMissingManualFields(item, ingestedRecord) {
  const missingFields = [];

  if (!ingestedRecord) {
    return missingFields;
  }

  if (!isNonEmptyString(item.catalystType)) {
    missingFields.push("catalystType");
  }

  if (!pickManualCatalystDate(item)) {
    missingFields.push("catalystDate");
  }

  if (!isNonEmptyString(item.source)) {
    missingFields.push("source");
  }

  return missingFields;
}

function getCatalystMismatches(item, ingestedRecord) {
  const mismatches = [];
  const manualDate = pickManualCatalystDate(item);

  if (!ingestedRecord) {
    return mismatches;
  }

  if (isNonEmptyString(item.catalystType) && item.catalystType !== ingestedRecord.catalystType) {
    mismatches.push({
      field: "catalystType",
      ingestedValue: ingestedRecord.catalystType,
      manualValue: item.catalystType
    });
  }

  if (manualDate && ingestedRecord.catalystDate && manualDate !== ingestedRecord.catalystDate) {
    mismatches.push({
      field: "catalystDate",
      ingestedValue: ingestedRecord.catalystDate,
      manualValue: manualDate
    });
  }

  if (
    isNonEmptyString(item.source) &&
    isNonEmptyString(ingestedRecord.source) &&
    normalizeSourceText(item.source) !== normalizeSourceText(ingestedRecord.source)
  ) {
    mismatches.push({
      field: "source",
      ingestedValue: ingestedRecord.source,
      manualValue: item.source
    });
  }

  return mismatches;
}

function deriveCatalystWindowScore(daysToCatalyst) {
  if (daysToCatalyst === null) {
    return 1;
  }

  if (daysToCatalyst <= 0) {
    return 4;
  }

  if (daysToCatalyst <= 7) {
    return 5;
  }

  if (daysToCatalyst <= 14) {
    return 4;
  }

  if (daysToCatalyst <= 30) {
    return 3;
  }

  if (daysToCatalyst <= 45) {
    return 2;
  }

  return 1;
}

function deriveSetupType(item) {
  if (item.etfProfile && item.etfProfile.isEtfAsset) {
    return item.etfProfile.isLeveragedInverse ? "etf-tactical" : "etf-directional";
  }

  if (isNonEmptyString(item.setupType)) {
    return item.setupType;
  }

  if (item.catalystType === "fda") {
    return "binary-rerating";
  }

  if (item.catalystType === "unusual-volume-gap") {
    return "breakout-follow-through";
  }

  if (item.catalystType === "insider") {
    return "insider-rerating";
  }

  if (item.catalystType === "earnings") {
    return "earnings-rerating";
  }

  return "event-driven";
}

function buildUnderlyingConfirmation(underlyingConfirmation) {
  if (!underlyingConfirmation || typeof underlyingConfirmation !== "object" || Array.isArray(underlyingConfirmation)) {
    return {
      benchmark: "",
      invalidatesIf: "",
      isValid: false,
      macroCatalyst: "",
      present: false,
      trendConfirmed: null
    };
  }

  return {
    benchmark: underlyingConfirmation.benchmark || "",
    invalidatesIf: underlyingConfirmation.invalidatesIf || "",
    isValid: hasValidUnderlyingConfirmation(underlyingConfirmation),
    macroCatalyst: underlyingConfirmation.macroCatalyst || "",
    present: true,
    trendConfirmed:
      typeof underlyingConfirmation.trendConfirmed === "boolean"
        ? underlyingConfirmation.trendConfirmed
        : null
  };
}

function buildEtfProfile(item) {
  const category = normalizeTextEnum(item && item.etfCategory) || "plain";
  const structure = normalizeTextEnum(item && item.instrumentStructure) || "unknown";
  const leverageFactor = isFiniteNumber(item && item.leverageFactor) ? item.leverageFactor : null;
  const inferredInverse =
    item && item.inverse === true ? true : category === "inverse" || category === "leveraged-inverse";
  const isLeveragedInverse =
    isEtfAsset(item) &&
    (
      category === "leveraged" ||
      category === "inverse" ||
      category === "leveraged-inverse" ||
      inferredInverse ||
      (isFiniteNumber(leverageFactor) && leverageFactor > 1)
    );
  const underlyingConfirmation = buildUnderlyingConfirmation(item && item.underlyingConfirmation);
  const manualOverride = item && item.manualOverride === true;
  const requiresManualReview =
    isEtfAsset(item) &&
    !manualOverride &&
    (
      category === "volatility" ||
      category === "single-stock-leveraged" ||
      structure === "etn" ||
      structure === "unknown"
    );

  return {
    category,
    hasUnderlyingConfirmation: underlyingConfirmation.isValid && underlyingConfirmation.trendConfirmed === true,
    holdingRule: item && item.holdingRule ? item.holdingRule : null,
    instrumentStructure: structure,
    inverse: inferredInverse,
    isEtfAsset: isEtfAsset(item),
    isLeveragedInverse,
    leverageFactor,
    manualOverride,
    maxHoldingDays: Number.isInteger(item && item.maxHoldingDays) ? item.maxHoldingDays : null,
    maxPositionPct: isFiniteNumber(item && item.maxPositionPct) ? item.maxPositionPct : null,
    requiresManualReview,
    riskNote: item && item.riskNote ? item.riskNote : "",
    underlyingConfirmation
  };
}

function aggregateSocialSignals(signals, manualSocialDiscoveryScore, manualCrowdingRisk) {
  const recentSignals = signals.filter((signal) => signal.ageDays === null || signal.ageDays <= 21);
  const verifiedSignals = recentSignals.filter((signal) => signal.verificationStatus === "verified");
  const unverifiedSignals = recentSignals.filter((signal) => signal.verificationStatus === "unverified");
  const derivedDiscovery = clampScore(
    Math.min(
      5,
      recentSignals.reduce((accumulator, signal) => accumulator + signal.relevanceScore, 0) / 2
    )
  );
  const socialDiscoveryScore = clampScore(
    Math.max(clampScore(manualSocialDiscoveryScore) || 0, derivedDiscovery || 0)
  ) || 0;
  const derivedCrowding = clampScore(
    recentSignals.reduce((maxRisk, signal) => Math.max(maxRisk, clampScore(signal.crowdingRisk) || 0), 0)
  ) || 0;
  const crowdingRisk = clampScore(Math.max(clampScore(manualCrowdingRisk) || 0, derivedCrowding)) || 0;

  return {
    crowdingRisk,
    derivedCrowding,
    derivedDiscovery,
    hasVerifiedSignal: verifiedSignals.length > 0,
    isHypey: socialDiscoveryScore >= 3.5 && verifiedSignals.length === 0,
    recentSignals,
    socialDiscoveryScore,
    unverifiedSignalCount: unverifiedSignals.length,
    verifiedSignalCount: verifiedSignals.length
  };
}

function deriveOutlierFactors(item, ingestedMatch, socialAggregate, daysToCatalyst) {
  const etfProfile = item.etfProfile || buildEtfProfile(item);
  const catalystStrength =
    clampScore(item.catalystStrength) ||
    clampScore((BASE_CATALYST_STRENGTH[item.catalystType] || 1) + (ingestedMatch ? 0.5 : 0));
  const liquidityQuality = clampScore(item.liquidityQuality) || 2;
  const momentumQuality = clampScore(item.momentumQuality) || 1;
  const breakoutReadiness = clampScore(item.breakoutReadiness) || 1;
  const baseReratingPotential = clampScore(item.reratingPotential) || 1;
  const reratingPotential = etfProfile.isEtfAsset
    ? Math.min(baseReratingPotential, etfProfile.isLeveragedInverse ? 1 : 2)
    : baseReratingPotential;
  const insiderSupport =
    clampScore(item.insiderSupport) ||
    clampScore(item.catalystType === "insider" || (ingestedMatch && ingestedMatch.catalystType === "insider") ? 3 : 1);
  const downsideClarity = clampScore(item.downsideClarity) || 1;

  return {
    breakoutReadiness,
    catalystStrength,
    catalystWindow: deriveCatalystWindowScore(daysToCatalyst),
    crowdingRisk: socialAggregate.crowdingRisk,
    downsideClarity,
    insiderSupport,
    liquidityQuality,
    momentumQuality,
    reratingPotential,
    socialDiscoveryScore: socialAggregate.socialDiscoveryScore
  };
}

function toEventRecord(item, sourceKind, currentDate) {
  const ticker = normalizeTicker(item.ticker);
  const catalystDate = item.catalystDate || item.catalystWindow || null;
  const hasValidCatalystDate = isNonEmptyString(catalystDate) && isValidDateOnlyString(catalystDate);
  const daysToCatalyst = hasValidCatalystDate ? daysBetween(currentDate, catalystDate) : null;
  const priority = getPriorityValue(item, sourceKind);
  const etfProfile = buildEtfProfile(item);

  return {
    avgPrice: isFiniteNumber(item.avgPrice) ? item.avgPrice : null,
    assetType: item.assetType || null,
    catalyst: item.catalyst || item.rationale || "",
    catalystDate: hasValidCatalystDate ? catalystDate : null,
    catalystLabel: CATALYST_LABELS[item.catalystType] || "catalyst",
    catalystText: item.catalyst || item.rationale || "",
    catalystTiming: getCatalystTiming(daysToCatalyst),
    catalystTimingLabel: formatCatalystTiming(daysToCatalyst),
    catalystType: item.catalystType || null,
    daysToCatalyst,
    exchange: item.exchange || null,
    invalidation: item.invalidation || "",
    lastPrice: isFiniteNumber(item.lastPrice) ? item.lastPrice : null,
    market: item.market || null,
    notes: item.notes || "",
    priority,
    quantity: isFiniteNumber(item.quantity) ? item.quantity : null,
    rationale: item.rationale || "",
    source: item.source || "",
    sourceKind,
    sourcePriority: SOURCE_PRIORITY[sourceKind] || 99,
    status: item.status,
    etfProfile,
    thesis: item.thesis,
    ticker
  };
}

function createEnrichedEventRecord(item, sourceKind, currentDate, ingestedRecordsByTicker, socialSignalsByTicker) {
  const ticker = normalizeTicker(item.ticker);
  const ingestedRecords = ingestedRecordsByTicker.get(ticker) || [];
  const ingestedMatch = pickBestIngestedMatch(item, ingestedRecords);
  const missingManualFields = getMissingManualFields(item, ingestedMatch);
  const mismatches = getCatalystMismatches(item, ingestedMatch);
  const mergedItem = {
    ...item,
    catalyst: item.catalyst || (ingestedMatch && ingestedMatch.catalystText) || item.rationale || "",
    catalystDate: item.catalystDate || (ingestedMatch && ingestedMatch.catalystDate) || item.catalystWindow,
    catalystType: item.catalystType || (ingestedMatch && ingestedMatch.catalystType) || null,
    notes: item.notes || (ingestedMatch && ingestedMatch.notes) || "",
    source: item.source || (ingestedMatch && ingestedMatch.source) || ""
  };
  const record = toEventRecord(mergedItem, sourceKind, currentDate);
  const tickerSignals = (socialSignalsByTicker.get(ticker) || []).slice(0, 6);
  const social = aggregateSocialSignals(
    tickerSignals,
    mergedItem.socialDiscoveryScore,
    mergedItem.crowdingRisk
  );
  const outlierFactors = deriveOutlierFactors(
    {
      ...mergedItem,
      etfProfile: record.etfProfile
    },
    ingestedMatch,
    social,
    record.daysToCatalyst
  );
  const hasVerifiedCatalyst =
    Boolean(record.catalystType && record.catalystDate && record.source) && mismatches.length === 0;
  const manualSocialSignals = Array.isArray(mergedItem.socialSignals) ? mergedItem.socialSignals : [];

  return {
    ...record,
    hasVerifiedCatalyst,
    ingestion: {
      confirmed: Boolean(ingestedMatch) && mismatches.length === 0,
      ingestedMatch,
      missingManualFields,
      mismatches,
      origin:
        ingestedMatch && missingManualFields.length > 0
          ? "manual+ingesta"
          : ingestedMatch
            ? "manual-confirmado"
            : "manual",
      records: ingestedRecords
    },
    outlierFactors,
    setupType: deriveSetupType({
      ...mergedItem,
      etfProfile: record.etfProfile
    }),
    social: {
      ...social,
      manualSocialSignals,
      relevantSignals: tickerSignals
    }
  };
}

function createCoverageFlags(record) {
  const flags = [];

  if (record.status === "descartar") {
    return flags;
  }

  if (!isNonEmptyString(record.catalystType)) {
    flags.push(
      createCoverageFlag(
        "missingCatalystType",
        `${record.ticker} no tiene catalystType definido para la capa outlier.`,
        record.sourceKind,
        record.ticker
      )
    );
  }

  if (!isNonEmptyString(record.catalystDate)) {
    flags.push(
      createCoverageFlag(
        "missingCatalystDate",
        `${record.ticker} no tiene catalystDate definido.`,
        record.sourceKind,
        record.ticker
      )
    );
  }

  if (!isNonEmptyString(record.source)) {
    flags.push(
      createCoverageFlag(
        "missingSource",
        `${record.ticker} no tiene source verificable para su catalyst.`,
        record.sourceKind,
        record.ticker
      )
    );
  }

  if (!isFiniteNumber(record.lastPrice)) {
    flags.push(
      createCoverageFlag(
        "missingLastPrice",
        `${record.ticker} no tiene lastPrice cargado.`,
        record.sourceKind,
        record.ticker
      )
    );
  }

  if (record.outlierFactors.liquidityQuality <= 2) {
    flags.push(
      createCoverageFlag(
        "weakLiquidity",
        `${record.ticker} tiene liquidityQuality insuficiente para un outlier serio.`,
        record.sourceKind,
        record.ticker
      )
    );
  }

  if (record.etfProfile && record.etfProfile.isEtfAsset) {
    if (!record.etfProfile.hasUnderlyingConfirmation) {
      flags.push(
        createCoverageFlag(
          "missingUnderlyingConfirmation",
          `${record.ticker} requiere underlyingConfirmation para tratarse como ETF tactico.`,
          record.sourceKind,
          record.ticker
        )
      );
    }

    if (record.etfProfile.isLeveragedInverse && record.etfProfile.instrumentStructure !== "etf") {
      flags.push(
        createCoverageFlag(
          "strongManualReview",
          `${record.ticker} es ETF apalancado/inverso sin instrumentStructure="etf" confirmado. Requiere revision manual fuerte.`,
          record.sourceKind,
          record.ticker
        )
      );
    }

    if (record.etfProfile.requiresManualReview) {
      flags.push(
        createCoverageFlag(
          "manualEtfReviewRequired",
          `${record.ticker} queda en vigilancia manual por su estructura ETF/ETN salvo override explicito.`,
          record.sourceKind,
          record.ticker
        )
      );
    }
  }

  return flags;
}

function compareEventRecords(left, right) {
  if (left.sourcePriority !== right.sourcePriority) {
    return left.sourcePriority - right.sourcePriority;
  }

  if (left.sourceKind === "watchlist" && left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  if ((left.daysToCatalyst === null) !== (right.daysToCatalyst === null)) {
    return left.daysToCatalyst === null ? 1 : -1;
  }

  if (left.daysToCatalyst !== right.daysToCatalyst) {
    return (left.daysToCatalyst || 0) - (right.daysToCatalyst || 0);
  }

  return left.ticker.localeCompare(right.ticker);
}

function analyzeEventState(state) {
  const currentDate = state.currentDate;
  const ingestedCatalysts = collectIngestedCatalysts(state);
  const ingestedRecordsByTicker = buildIngestionIndex(ingestedCatalysts);
  const allSocialSignals = collectSocialSignals(state);
  const socialSignalsByTicker = buildSocialSignalIndex(allSocialSignals);
  const universe = [
    ...(state.positions.positions || []).map((item) =>
      createEnrichedEventRecord(item, "position", currentDate, ingestedRecordsByTicker, socialSignalsByTicker)
    ),
    ...(state.watchlist.watchlist || []).map((item) =>
      createEnrichedEventRecord(item, "watchlist", currentDate, ingestedRecordsByTicker, socialSignalsByTicker)
    )
  ].sort(compareEventRecords);

  const activeCatalysts = universe
    .filter((item) => item.status !== "descartar")
    .filter(
      (item) =>
        item.daysToCatalyst !== null &&
        item.daysToCatalyst >= -CATALYST_RECENT_DAYS &&
        item.daysToCatalyst <= CATALYST_NEAR_DAYS
    )
    .sort(compareEventRecords);

  const flags = universe.flatMap((item) => createCoverageFlags(item));
  const trackedItems = universe.filter((item) => item.status !== "descartar");
  const itemsWithCatalystDate = trackedItems.filter((item) => isNonEmptyString(item.catalystDate));
  const mismatches = [];
  const missingTrackedCatalysts = [];
  const confirmedCatalysts = [];

  universe.forEach((item) => {
    const ingestedMatch = item.ingestion.ingestedMatch;

    if (!ingestedMatch) {
      return;
    }

    if (item.ingestion.missingManualFields.length > 0) {
      const missingItem = {
        missingFields: item.ingestion.missingManualFields,
        sourceKind: item.sourceKind,
        ticker: item.ticker,
        usingIngested: ingestedMatch
      };
      missingTrackedCatalysts.push(missingItem);
      flags.push(
        createCoverageFlag(
          "missingTrackedCatalystFields",
          `${item.ticker} tiene catalyst ingerido pero faltan campos manuales: ${item.ingestion.missingManualFields.join(", ")}.`,
          item.sourceKind,
          item.ticker,
          { missingFields: item.ingestion.missingManualFields }
        )
      );
    }

    if (item.ingestion.mismatches.length > 0) {
      item.ingestion.mismatches.forEach((mismatch) => {
        const mismatchItem = {
          field: mismatch.field,
          ingestedValue: mismatch.ingestedValue,
          manualValue: mismatch.manualValue,
          sourceKind: item.sourceKind,
          ticker: item.ticker
        };
        mismatches.push(mismatchItem);
        flags.push(
          createCoverageFlag(
            `ingestionMismatch${mismatch.field[0].toUpperCase()}${mismatch.field.slice(1)}`,
            `${item.ticker} tiene mismatch de ${mismatch.field} entre manual e ingesta (${mismatch.manualValue} vs ${mismatch.ingestedValue}).`,
            item.sourceKind,
            item.ticker,
            mismatchItem
          )
        );
      });
      return;
    }

    confirmedCatalysts.push({
      catalystDate: ingestedMatch.catalystDate,
      catalystType: ingestedMatch.catalystType,
      source: ingestedMatch.source,
      sourceKind: item.sourceKind,
      ticker: item.ticker
    });
  });

  const relevantSignals = universe
    .flatMap((item) =>
      item.social.relevantSignals.map((signal) => ({
        ...signal,
        sourceKind: item.sourceKind,
        ticker: item.ticker
      }))
    )
    .sort(compareSocialSignals)
    .slice(0, 8);

  const crowdingWarnings = universe
    .filter((item) => item.status !== "descartar")
    .filter((item) => item.outlierFactors.crowdingRisk >= 4)
    .map((item) => ({
      code: "crowdingWarning",
      message: `${item.ticker} muestra crowdingRisk alto (${item.outlierFactors.crowdingRisk}).`,
      severity: "warning",
      source: item.sourceKind,
      ticker: item.ticker,
      type: "crowdingWarning"
    }));

  return {
    activeCatalysts,
    coverage: {
      confirmedCatalysts: confirmedCatalysts.length,
      ingestedCatalysts: ingestedCatalysts.length,
      trackedItems: trackedItems.length,
      withCatalystDate: itemsWithCatalystDate.length,
      withIngestionMatch: universe.filter((item) => Boolean(item.ingestion.ingestedMatch)).length,
      withLastPrice: trackedItems.filter((item) => isFiniteNumber(item.lastPrice)).length,
      withSocialSignals: universe.filter((item) => item.social.relevantSignals.length > 0).length,
      withSource: trackedItems.filter((item) => isNonEmptyString(item.source)).length
    },
    flags,
    ingestion: {
      confirmedCatalysts,
      ingestedCatalysts,
      ingestedToday: ingestedCatalysts.filter((item) => item.updatedToday),
      mismatches,
      missingTrackedCatalysts
    },
    social: {
      crowdingWarnings,
      relevantSignals
    },
    universe
  };
}

module.exports = {
  analyzeEventState
};
