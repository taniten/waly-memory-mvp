"use strict";

const VALID_STATUSES = [
  "mantener",
  "observar",
  "descartar",
  "nueva oportunidad"
];

const VALID_CATALYST_TYPES = [
  "earnings",
  "insider",
  "fda",
  "unusual-volume-gap"
];

const VALID_SETUP_RANKS = [
  "A+",
  "A",
  "B",
  "descartar"
];

const VALID_PLAYBOOK_TYPES = [
  "outlier",
  "event-swing"
];

const VALID_SOURCE_PLATFORMS = [
  "X",
  "Reddit",
  "forum",
  "Substack",
  "other"
];

const VALID_SOCIAL_SIGNAL_TYPES = [
  "mention",
  "thesis",
  "catalyst",
  "unusual-attention"
];

const VALID_VERIFICATION_STATUSES = [
  "verified",
  "partial",
  "unverified"
];

const VALID_OUTCOME_LABELS = [
  "funciono",
  "fallo",
  "mixto",
  "abierto"
];

const VALID_OUTCOME_SOURCE_KINDS = [
  "position",
  "watchlist",
  "opportunity"
];

const VALID_HOLDING_RULES = [
  "intraday-only",
  "1-3d tactical",
  "swing-short",
  "hedge-temporal"
];

const VALID_INSTRUMENT_STRUCTURES = [
  "etf",
  "etn",
  "etc",
  "unknown"
];

const VALID_ETF_CATEGORIES = [
  "plain",
  "sector",
  "thematic",
  "bond",
  "commodity",
  "volatility",
  "single-stock",
  "single-stock-leveraged",
  "leveraged",
  "inverse",
  "leveraged-inverse",
  "other"
];

const STATUS_STRENGTH = Object.freeze({
  descartar: 0,
  "nueva oportunidad": 1,
  observar: 2,
  mantener: 3
});

const SOURCE_PRIORITY = Object.freeze({
  position: 1,
  watchlist: 2,
  opportunity: 3
});

const CATALYST_NEAR_DAYS = 14;
const CATALYST_RECENT_DAYS = 3;
const CATALYST_FUTURE_WINDOW_DAYS = 45;

const CATALYST_LABELS = Object.freeze({
  earnings: "earnings catalyst",
  insider: "insider / Form 4 catalyst",
  fda: "FDA / biotech catalyst",
  "unusual-volume-gap": "unusual volume / gap catalyst"
});

const CATALYST_TYPE_SCORES = Object.freeze({
  earnings: 5,
  insider: 4,
  fda: 6,
  "unusual-volume-gap": 3
});

const BASE_CATALYST_STRENGTH = Object.freeze({
  earnings: 4,
  insider: 3,
  fda: 5,
  "unusual-volume-gap": 3
});

const SOCIAL_SIGNAL_TYPE_WEIGHTS = Object.freeze({
  catalyst: 1.6,
  mention: 0.8,
  thesis: 1.3,
  "unusual-attention": 1.1
});

const SOCIAL_VERIFICATION_WEIGHTS = Object.freeze({
  partial: 0.65,
  unverified: 0.3,
  verified: 1
});

module.exports = {
  BASE_CATALYST_STRENGTH,
  CATALYST_FUTURE_WINDOW_DAYS,
  CATALYST_LABELS,
  CATALYST_NEAR_DAYS,
  CATALYST_RECENT_DAYS,
  CATALYST_TYPE_SCORES,
  SOCIAL_SIGNAL_TYPE_WEIGHTS,
  SOCIAL_VERIFICATION_WEIGHTS,
  SOURCE_PRIORITY,
  STATUS_STRENGTH,
  VALID_CATALYST_TYPES,
  VALID_ETF_CATEGORIES,
  VALID_HOLDING_RULES,
  VALID_INSTRUMENT_STRUCTURES,
  VALID_OUTCOME_LABELS,
  VALID_OUTCOME_SOURCE_KINDS,
  VALID_PLAYBOOK_TYPES,
  VALID_SETUP_RANKS,
  VALID_SOCIAL_SIGNAL_TYPES,
  VALID_SOURCE_PLATFORMS,
  VALID_STATUSES,
  VALID_VERIFICATION_STATUSES
};
