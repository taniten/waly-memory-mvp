"use strict";

const { VALID_SETUP_RANKS } = require("./constants");

function compareRankedItems(left, right) {
  if (left.rankingScore !== right.rankingScore) {
    return right.rankingScore - left.rankingScore;
  }

  if (left.priority !== right.priority) {
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

function buildScoreBreakdown(item) {
  const factors = item.outlierFactors;
  const etfProfile = item.etfProfile || {};
  const reratingWeight = etfProfile.isEtfAsset ? 1 : 3;
  const underlyingConfirmationBonus =
    etfProfile.isEtfAsset && etfProfile.hasUnderlyingConfirmation ? 6 : 0;
  const hardDataScore =
    factors.catalystStrength * 3 +
    factors.catalystWindow * 2 +
    factors.liquidityQuality * 3 +
    factors.momentumQuality * 2 +
    factors.breakoutReadiness * 2 +
    factors.reratingPotential * reratingWeight +
    factors.insiderSupport * 1 +
    factors.downsideClarity * 3 +
    underlyingConfirmationBonus;
  const discoveryBonus = Math.min(factors.socialDiscoveryScore, 3) * 1.5;
  const crowdingPenalty = factors.crowdingRisk * 3;
  const extensionRisk = factors.momentumQuality >= 4 && factors.breakoutReadiness <= 2;
  const penalties = {
    etfManualReview: etfProfile.requiresManualReview ? 18 : 0,
    etfMissingUnderlyingConfirmation:
      etfProfile.isEtfAsset && !etfProfile.hasUnderlyingConfirmation ? 14 : 0,
    extension: extensionRisk ? 6 : 0,
    hypeWithoutData: item.social.isHypey && !item.hasVerifiedCatalyst ? 8 : 0,
    noVerifiedCatalyst: item.hasVerifiedCatalyst ? 0 : 10,
    weakDownside: factors.downsideClarity < 3 ? 6 : 0,
    weakLiquidity: factors.liquidityQuality < 3 ? 8 : 0,
    weakRerating: factors.reratingPotential < 3 ? 5 : 0
  };
  const totalPenalty = crowdingPenalty + Object.values(penalties).reduce((sum, value) => sum + value, 0);
  const rawScore = hardDataScore + discoveryBonus - totalPenalty;

  return {
    crowdingPenalty,
    discoveryBonus,
    extensionRisk,
    hardDataScore,
    penalties,
    rawScore
  };
}

function meetsAPlusCriteria(item, breakdown) {
  const factors = item.outlierFactors;

  return (
    item.hasVerifiedCatalyst &&
    factors.catalystStrength >= 4 &&
    factors.catalystWindow >= 3 &&
    factors.liquidityQuality >= 4 &&
    factors.momentumQuality >= 3 &&
    factors.breakoutReadiness >= 4 &&
    factors.reratingPotential >= 4 &&
    factors.downsideClarity >= 4 &&
    factors.crowdingRisk <= 3 &&
    !breakdown.extensionRisk
  );
}

function meetsACriteria(item, breakdown) {
  const factors = item.outlierFactors;

  return (
    item.hasVerifiedCatalyst &&
    factors.catalystStrength >= 3 &&
    factors.liquidityQuality >= 3 &&
    factors.reratingPotential >= 3 &&
    factors.downsideClarity >= 3 &&
    factors.crowdingRisk <= 4 &&
    !breakdown.extensionRisk
  );
}

function meetsBCriteria(item) {
  const factors = item.outlierFactors;

  return (
    item.hasVerifiedCatalyst &&
    factors.catalystStrength >= 2 &&
    factors.liquidityQuality >= 2 &&
    factors.downsideClarity >= 2
  );
}

function deriveSetupRank(item, breakdown) {
  if (item.etfProfile && item.etfProfile.requiresManualReview) {
    return VALID_SETUP_RANKS[3];
  }

  if (item.etfProfile && item.etfProfile.isEtfAsset && !item.etfProfile.hasUnderlyingConfirmation) {
    return VALID_SETUP_RANKS[3];
  }

  if (item.etfProfile && item.etfProfile.isLeveragedInverse) {
    if (meetsBCriteria(item) && breakdown.rawScore >= 38) {
      return VALID_SETUP_RANKS[2];
    }

    return VALID_SETUP_RANKS[3];
  }

  if (meetsAPlusCriteria(item, breakdown) && breakdown.rawScore >= 62) {
    return VALID_SETUP_RANKS[0];
  }

  if (meetsACriteria(item, breakdown) && breakdown.rawScore >= 48) {
    return VALID_SETUP_RANKS[1];
  }

  if (meetsBCriteria(item) && breakdown.rawScore >= 38) {
    return VALID_SETUP_RANKS[2];
  }

  return VALID_SETUP_RANKS[3];
}

function deriveOutlierVerdict(item, setupRank) {
  if (item.etfProfile && item.etfProfile.requiresManualReview) {
    return "Instrumento ETF/ETN de vigilancia manual. No promover sin override explicito.";
  }

  if (item.etfProfile && item.etfProfile.isEtfAsset && !item.etfProfile.hasUnderlyingConfirmation) {
    return "ETF sin underlyingConfirmation suficiente. No califica como candidato tactico todavia.";
  }

  if (item.etfProfile && item.etfProfile.isLeveragedInverse) {
    return "ETF apalancado o inverso: solo tactico, nunca tesis outlier ni A+ WALY.";
  }

  if (setupRank === "A+") {
    return "Asimetria real con datos que respaldan un posible outlier.";
  }

  if (setupRank === "A") {
    return "Setup fuerte, pero todavia no es una bala de plata x2+.";
  }

  if (setupRank === "B") {
    return "Hay algo para seguir, pero todavia no es una apuesta outlier.";
  }

  return "Narrativa insuficiente o estructura demasiado floja para jugarla.";
}

function isOutlierCandidate(item) {
  if (
    item.etfProfile &&
    (item.etfProfile.isLeveragedInverse || item.etfProfile.requiresManualReview)
  ) {
    return false;
  }

  return (
    (item.setupRank === "A+" || item.setupRank === "A") &&
    item.outlierFactors.reratingPotential >= 4 &&
    item.outlierFactors.downsideClarity >= 4 &&
    item.outlierFactors.catalystStrength >= 4 &&
    item.outlierFactors.crowdingRisk <= 3.5
  );
}

function rankUniverse(eventState, maxOpportunities) {
  const rankedUniverse = eventState.universe
    .map((item) => {
      const scoreBreakdown = buildScoreBreakdown(item);
      const setupRank = deriveSetupRank(item, scoreBreakdown);
      const rankingScore = Number(scoreBreakdown.rawScore.toFixed(2));

      return {
        ...item,
        isOutlierCandidate: false,
        outlierVerdict: deriveOutlierVerdict(item, setupRank),
        rankingScore,
        scoreBreakdown,
        setupRank
      };
    })
    .map((item) => ({
      ...item,
      isOutlierCandidate: isOutlierCandidate(item)
    }))
    .sort(compareRankedItems);

  const rankedWatchlist = rankedUniverse.filter((item) => item.sourceKind === "watchlist");
  const finalOpportunities = rankedWatchlist
    .filter((item) => item.status !== "descartar")
    .filter((item) => item.isOutlierCandidate)
    .slice(0, maxOpportunities);

  return {
    finalOpportunities,
    rankedUniverse,
    rankedWatchlist
  };
}

module.exports = {
  rankUniverse
};
