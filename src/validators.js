"use strict";

const {
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
} = require("./constants");

function createValidationResult() {
  return {
    errors: [],
    warnings: []
  };
}

function mergeValidationResults(...results) {
  return results.reduce(
    (accumulator, current) => {
      if (!current) {
        return accumulator;
      }

      accumulator.errors.push(...(current.errors || []));
      accumulator.warnings.push(...(current.warnings || []));
      return accumulator;
    },
    createValidationResult()
  );
}

function createIssue(code, message, path, details) {
  return {
    code,
    ...(details || {}),
    details: details || {},
    message,
    path: path || null
  };
}

function pushError(result, code, message, path, details) {
  result.errors.push(createIssue(code, message, path, details));
}

function pushWarning(result, code, message, path, details) {
  result.warnings.push(createIssue(code, message, path, details));
}

function formatIssue(issue) {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function assertValid(result) {
  if (result.errors.length > 0) {
    throw new Error(result.errors.map(formatIssue).join("\n"));
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTicker(ticker) {
  if (!isNonEmptyString(ticker)) {
    return "";
  }

  return ticker.trim().toUpperCase();
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidDateOnlyString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidTimestampString(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}

function compareDateOnlyStrings(left, right) {
  return left.localeCompare(right);
}

function parseDateOnlyToUtc(value) {
  if (!isValidDateOnlyString(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function validateRequiredString(result, value, label, fieldName) {
  if (!isNonEmptyString(value)) {
    pushError(result, "requiredField", `${fieldName} es obligatorio.`, `${label}.${fieldName}`);
  }
}

function validateOptionalString(result, value, label, fieldName) {
  if (value !== undefined && !isNonEmptyString(value)) {
    pushError(
      result,
      "invalidString",
      `${fieldName} debe ser un string no vacio si existe.`,
      `${label}.${fieldName}`
    );
  }
}

function validateOptionalNumber(result, value, label, fieldName) {
  if (value !== undefined && !isFiniteNumber(value)) {
    pushError(
      result,
      "invalidNumber",
      `${fieldName} debe ser un numero valido si existe.`,
      `${label}.${fieldName}`
    );
  }
}

function validateOptionalBoolean(result, value, label, fieldName) {
  if (value !== undefined && typeof value !== "boolean") {
    pushError(
      result,
      "invalidBoolean",
      `${fieldName} debe ser boolean si existe.`,
      `${label}.${fieldName}`
    );
  }
}

function validateOptionalInteger(result, value, label, fieldName, options = {}) {
  const { min = 0 } = options;

  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < min) {
    pushError(
      result,
      "invalidInteger",
      `${fieldName} debe ser un entero mayor o igual a ${min}.`,
      `${label}.${fieldName}`
    );
  }
}

function validateRequiredArray(result, value, label, fieldName) {
  if (!Array.isArray(value)) {
    pushError(result, "requiredArray", `${fieldName} debe ser un array.`, `${label}.${fieldName}`);
  }
}

function validateOptionalObject(result, value, label, fieldName) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    pushError(
      result,
      "invalidObject",
      `${fieldName} debe ser un objeto simple si existe.`,
      `${label}.${fieldName}`
    );
  }
}

function validateDateField(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!isNonEmptyString(value) || !isValidDateOnlyString(value)) {
    pushError(
      result,
      "invalidDate",
      `${fieldName} debe usar formato YYYY-MM-DD valido.`,
      `${label}.${fieldName}`
    );
  }
}

function validateTimestampField(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!isValidTimestampString(value)) {
    pushError(
      result,
      "invalidTimestamp",
      `${fieldName} debe ser un timestamp ISO valido.`,
      `${label}.${fieldName}`
    );
  }
}

function validateOptionalPriority(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < 1) {
    pushError(
      result,
      "invalidPriority",
      `${fieldName} debe ser un entero mayor o igual a 1.`,
      `${label}.${fieldName}`
    );
  }
}

function validateOptionalScore(result, value, label, fieldName, options = {}) {
  const { max = 5, min = 0 } = options;

  if (value === undefined) {
    return;
  }

  if (!isFiniteNumber(value) || value < min || value > max) {
    pushError(
      result,
      "invalidScore",
      `${fieldName} debe ser un numero entre ${min} y ${max}.`,
      `${label}.${fieldName}`
    );
  }
}

function validateOptionalStringArray(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    pushError(
      result,
      "invalidCollection",
      `${fieldName} debe ser un array de strings si existe.`,
      `${label}.${fieldName}`
    );
    return;
  }

  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      pushError(
        result,
        "invalidString",
        `${fieldName}[${index}] debe ser un string no vacio.`,
        `${label}.${fieldName}[${index}]`
      );
    }
  });
}

function validateOptionalEnum(result, value, allowedValues, label, fieldName, code) {
  if (value === undefined) {
    return;
  }

  validateEnum(result, value, allowedValues, label, fieldName, code);
}

function validateOptionalPercentage(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!isFiniteNumber(value) || value <= 0 || value > 100) {
    pushError(
      result,
      "invalidPercentage",
      `${fieldName} debe ser un numero mayor a 0 y menor o igual a 100.`,
      `${label}.${fieldName}`
    );
  }
}

function normalizeTextEnum(value) {
  return isNonEmptyString(value) ? value.trim().toLowerCase() : "";
}

function isEtfAsset(item) {
  return normalizeTextEnum(item && item.assetType) === "etf";
}

function hasValidUnderlyingConfirmation(underlyingConfirmation) {
  return Boolean(
    underlyingConfirmation &&
      typeof underlyingConfirmation === "object" &&
      !Array.isArray(underlyingConfirmation) &&
      isNonEmptyString(underlyingConfirmation.benchmark) &&
      typeof underlyingConfirmation.trendConfirmed === "boolean" &&
      isNonEmptyString(underlyingConfirmation.invalidatesIf)
  );
}

function validateUnderlyingConfirmation(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  validateOptionalObject(result, value, label, fieldName);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  validateRequiredString(result, value.benchmark, `${label}.${fieldName}`, "benchmark");

  if (typeof value.trendConfirmed !== "boolean") {
    pushError(
      result,
      "invalidBoolean",
      "trendConfirmed debe ser boolean dentro de underlyingConfirmation.",
      `${label}.${fieldName}.trendConfirmed`
    );
  }

  validateOptionalString(result, value.macroCatalyst, `${label}.${fieldName}`, "macroCatalyst");
  validateRequiredString(result, value.invalidatesIf, `${label}.${fieldName}`, "invalidatesIf");
}

function isLeveragedInverseEtf(item) {
  if (!isEtfAsset(item)) {
    return false;
  }

  const category = normalizeTextEnum(item && item.etfCategory);
  const leverageFactor = item && item.leverageFactor;
  const inverse = item && item.inverse === true;

  return (
    category === "leveraged" ||
    category === "inverse" ||
    category === "leveraged-inverse" ||
    inverse ||
    (isFiniteNumber(leverageFactor) && leverageFactor > 1)
  );
}

function needsManualEtfReview(item) {
  if (!isEtfAsset(item)) {
    return false;
  }

  const category = normalizeTextEnum(item && item.etfCategory);
  const structure = normalizeTextEnum(item && item.instrumentStructure);

  return (
    category === "volatility" ||
    category === "single-stock-leveraged" ||
    structure === "etn" ||
    structure === "unknown"
  );
}

function validateEtfFields(result, item, label, options = {}) {
  const { includeOperationalWarnings = true, source, ticker } = options;

  validateOptionalEnum(result, item && item.holdingRule, VALID_HOLDING_RULES, label, "holdingRule", "invalidHoldingRule");
  validateOptionalPercentage(result, item && item.maxPositionPct, label, "maxPositionPct");
  validateOptionalEnum(
    result,
    item && item.instrumentStructure,
    VALID_INSTRUMENT_STRUCTURES,
    label,
    "instrumentStructure",
    "invalidInstrumentStructure"
  );
  validateUnderlyingConfirmation(result, item && item.underlyingConfirmation, label, "underlyingConfirmation");
  validateOptionalInteger(result, item && item.maxHoldingDays, label, "maxHoldingDays", { min: 1 });
  validateOptionalString(result, item && item.riskNote, label, "riskNote");
  validateOptionalEnum(result, item && item.etfCategory, VALID_ETF_CATEGORIES, label, "etfCategory", "invalidEtfCategory");
  validateOptionalNumber(result, item && item.leverageFactor, label, "leverageFactor");
  validateOptionalBoolean(result, item && item.inverse, label, "inverse");
  validateOptionalBoolean(result, item && item.manualOverride, label, "manualOverride");

  if (item && item.leverageFactor !== undefined && (!isFiniteNumber(item.leverageFactor) || item.leverageFactor <= 0)) {
    pushError(
      result,
      "invalidNumber",
      "leverageFactor debe ser un numero mayor a 0 si existe.",
      `${label}.leverageFactor`
    );
  }

  if (!isEtfAsset(item)) {
    return;
  }

  if (
    includeOperationalWarnings &&
    item.status !== "descartar" &&
    !hasValidUnderlyingConfirmation(item.underlyingConfirmation)
  ) {
    pushWarning(
      result,
      "missingUnderlyingConfirmation",
      `${ticker || label} requiere underlyingConfirmation para tratarse como candidato tactico.`,
      `${label}.underlyingConfirmation`,
      { source, ticker }
    );
  }

  if (!isLeveragedInverseEtf(item)) {
    if (includeOperationalWarnings && needsManualEtfReview(item) && item.manualOverride !== true) {
      pushWarning(
        result,
        "manualEtfReviewRequired",
        `${ticker || label} debe quedar en vigilancia manual por su estructura ETF/ETN salvo override explicito.`,
        `${label}.instrumentStructure`,
        { source, ticker }
      );
    }
    return;
  }

  validateRequiredString(result, item && item.holdingRule, label, "holdingRule");

  if (!Number.isInteger(item && item.maxHoldingDays) || item.maxHoldingDays < 1) {
    pushError(
      result,
      "requiredField",
      "maxHoldingDays es obligatorio para ETFs apalancados o inversos.",
      `${label}.maxHoldingDays`
    );
  }

  validateRequiredString(result, item && item.riskNote, label, "riskNote");

  if (includeOperationalWarnings && isFiniteNumber(item.maxPositionPct) && item.maxPositionPct > 10) {
    pushWarning(
      result,
      "etfMaxPositionRecommendation",
      `${ticker || label} supera la recomendacion de maxPositionPct <= 10 para ETFs apalancados o inversos.`,
      `${label}.maxPositionPct`,
      { source, ticker }
    );
  }

  if (
    includeOperationalWarnings &&
    isFiniteNumber(item.maxPositionPct) &&
    item.maxPositionPct > 5 &&
    ((isFiniteNumber(item.leverageFactor) && item.leverageFactor >= 3) || item.inverse === true)
  ) {
    pushWarning(
      result,
      "etfConcentrationWarning",
      `${ticker || label} supera 5% de posicion en un ETF con leverageFactor >= 3 o inverse=true.`,
      `${label}.maxPositionPct`,
      { source, ticker }
    );
  }

  if (
    includeOperationalWarnings &&
    (!isNonEmptyString(item.instrumentStructure) || item.instrumentStructure !== "etf")
  ) {
    pushWarning(
      result,
      "strongManualReview",
      `${ticker || label} es apalancado/inverso pero no tiene instrumentStructure="etf" confirmado. Requiere revision manual fuerte.`,
      `${label}.instrumentStructure`,
      { source, ticker }
    );
  }

  if (includeOperationalWarnings && needsManualEtfReview(item) && item.manualOverride !== true) {
    pushWarning(
      result,
      "manualEtfReviewRequired",
      `${ticker || label} debe quedar en vigilancia manual por su estructura ETF/ETN salvo override explicito.`,
      `${label}.instrumentStructure`,
      { source, ticker }
    );
  }
}

function validateCatalystType(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!isNonEmptyString(value) || !VALID_CATALYST_TYPES.includes(value)) {
    pushError(
      result,
      "invalidCatalystType",
      `${fieldName} debe ser uno de ${VALID_CATALYST_TYPES.join(", ")}.`,
      `${label}.${fieldName}`
    );
  }
}

function validateSetupRank(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!isNonEmptyString(value) || !VALID_SETUP_RANKS.includes(value)) {
    pushError(
      result,
      "invalidSetupRank",
      `${fieldName} debe ser uno de ${VALID_SETUP_RANKS.join(", ")}.`,
      `${label}.${fieldName}`
    );
  }
}

function validatePlaybookType(result, value, label, fieldName) {
  if (value === undefined) {
    return;
  }

  if (!isNonEmptyString(value) || !VALID_PLAYBOOK_TYPES.includes(value)) {
    pushError(
      result,
      "invalidPlaybookType",
      `${fieldName} debe ser uno de ${VALID_PLAYBOOK_TYPES.join(", ")}.`,
      `${label}.${fieldName}`
    );
  }
}

function validateEnum(result, value, allowedValues, label, fieldName, code) {
  if (!isNonEmptyString(value) || !allowedValues.includes(value)) {
    pushError(
      result,
      code || "invalidEnum",
      `${fieldName} debe ser uno de ${allowedValues.join(", ")}.`,
      `${label}.${fieldName}`
    );
  }
}

function validateStatus(result, status, label, options = {}) {
  const { allowOpportunityStatus } = options;

  if (!VALID_STATUSES.includes(status)) {
    pushError(
      result,
      "invalidStatus",
      `status invalido "${status}". Debe ser uno de ${VALID_STATUSES.join(", ")}.`,
      `${label}.status`
    );
    return;
  }

  if (!allowOpportunityStatus && status === "nueva oportunidad") {
    pushError(
      result,
      "invalidStatus",
      'una posicion o watchlist no puede usar status "nueva oportunidad".',
      `${label}.status`
    );
  }
}

function validateOutlierFields(result, item, label) {
  validateOptionalScore(result, item && item.catalystStrength, label, "catalystStrength", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.liquidityQuality, label, "liquidityQuality", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.momentumQuality, label, "momentumQuality", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.breakoutReadiness, label, "breakoutReadiness", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.reratingPotential, label, "reratingPotential", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.insiderSupport, label, "insiderSupport", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.socialDiscoveryScore, label, "socialDiscoveryScore", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.crowdingRisk, label, "crowdingRisk", { min: 0, max: 5 });
  validateOptionalScore(result, item && item.downsideClarity, label, "downsideClarity", { min: 0, max: 5 });
  validateOptionalString(result, item && item.setupType, label, "setupType");
  validateSetupRank(result, item && item.setupRank, label, "setupRank");
  validateOptionalStringArray(result, item && item.socialSignals, label, "socialSignals");
}

function warnIfMissingOutlierField(result, item, label, ticker, fieldName, source) {
  if (isEtfAsset(item) && fieldName === "reratingPotential") {
    return;
  }

  if (item && item.status !== "descartar" && item[fieldName] === undefined) {
    pushWarning(
      result,
      "missingOutlierField",
      `${ticker || label} no tiene ${fieldName} cargado para el scoring outlier.`,
      `${label}.${fieldName}`,
      { source, ticker }
    );
  }
}

function validatePositions(data, options = {}) {
  const { currentDate, includeOperationalWarnings = true } = options;
  const result = createValidationResult();

  if (!data || !Array.isArray(data.positions)) {
    pushError(result, "invalidCollection", "positions.json debe contener un array positions.", "positions");
    return result;
  }

  const seenTickers = new Map();

  data.positions.forEach((position, index) => {
    const label = `positions[${index}]`;
    const ticker = normalizeTicker(position && position.ticker);

    validateRequiredString(result, position && position.ticker, label, "ticker");
    validateStatus(result, position && position.status, label);
    validateRequiredString(result, position && position.thesis, label, "thesis");
    validateRequiredString(result, position && position.conviction, label, "conviction");
    validateRequiredString(result, position && position.notes, label, "notes");
    validateDateField(result, position && position.lastReviewedAt, label, "lastReviewedAt");
    validateDateField(result, position && position.nextReviewAt, label, "nextReviewAt");
    validateDateField(result, position && position.catalystDate, label, "catalystDate");

    if (!isFiniteNumber(position && position.quantity)) {
      pushError(result, "invalidNumber", "quantity debe ser un numero valido.", `${label}.quantity`);
    }

    if (!isFiniteNumber(position && position.avgPrice)) {
      pushError(result, "invalidNumber", "avgPrice debe ser un numero valido.", `${label}.avgPrice`);
    }

    validateOptionalString(result, position && position.assetType, label, "assetType");
    validateOptionalString(result, position && position.market, label, "market");
    validateOptionalString(result, position && position.exchange, label, "exchange");
    validateOptionalString(result, position && position.invalidation, label, "invalidation");
    validateOptionalString(result, position && position.catalyst, label, "catalyst");
    validateOptionalString(result, position && position.source, label, "source");
    validateOptionalNumber(result, position && position.lastPrice, label, "lastPrice");
    validateOptionalPriority(result, position && position.priority, label, "priority");
    validateCatalystType(result, position && position.catalystType, label, "catalystType");
    validatePlaybookType(result, position && position.playbookType, label, "playbookType");
    validateOutlierFields(result, position, label);
    validateEtfFields(result, position, label, {
      includeOperationalWarnings,
      source: "position",
      ticker
    });

    if (ticker) {
      if (seenTickers.has(ticker)) {
        pushWarning(
          result,
          "duplicatedTicker",
          `${ticker} aparece duplicado dentro de posiciones.`,
          label,
          { ticker }
        );
      }

      seenTickers.set(ticker, position);
    }

    if (
      includeOperationalWarnings &&
      (position.status === "mantener" || position.status === "observar") &&
      !isNonEmptyString(position.invalidation)
    ) {
      pushWarning(
        result,
        "missingInvalidation",
        `${ticker || label} requiere invalidation cuando el status es ${position.status}.`,
        `${label}.invalidation`,
        { source: "position", status: position.status, ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      position.status !== "descartar" &&
      !isNonEmptyString(position.catalystType)
    ) {
      pushWarning(
        result,
        "missingCatalystType",
        `${ticker || label} no tiene catalystType cargado.`,
        `${label}.catalystType`,
        { source: "position", ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      position.status !== "descartar" &&
      !isNonEmptyString(position.catalystDate)
    ) {
      pushWarning(
        result,
        "missingCatalystDate",
        `${ticker || label} no tiene catalystDate cargado.`,
        `${label}.catalystDate`,
        { source: "position", ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      position.status !== "descartar" &&
      !isFiniteNumber(position.lastPrice)
    ) {
      pushWarning(
        result,
        "missingLastPrice",
        `${ticker || label} no tiene lastPrice actualizado.`,
        `${label}.lastPrice`,
        { source: "position", ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      position.status !== "descartar" &&
      !isNonEmptyString(position.source)
    ) {
      pushWarning(
        result,
        "missingSource",
        `${ticker || label} no tiene source cargado para su catalyst.`,
        `${label}.source`,
        { source: "position", ticker }
      );
    }

    if (includeOperationalWarnings) {
      warnIfMissingOutlierField(result, position, label, ticker, "catalystStrength", "position");
      warnIfMissingOutlierField(result, position, label, ticker, "liquidityQuality", "position");
      warnIfMissingOutlierField(result, position, label, ticker, "reratingPotential", "position");
      warnIfMissingOutlierField(result, position, label, ticker, "downsideClarity", "position");
    }

    if (
      includeOperationalWarnings &&
      isNonEmptyString(position.nextReviewAt) &&
      isValidDateOnlyString(position.nextReviewAt) &&
      currentDate &&
      compareDateOnlyStrings(position.nextReviewAt, currentDate) < 0
    ) {
      pushWarning(
        result,
        "overdueReview",
        `${ticker} tiene nextReviewAt vencido (${position.nextReviewAt}).`,
        `${label}.nextReviewAt`,
        { source: "position", ticker }
      );
    }
  });

  return result;
}

function validateWatchlist(data, options = {}) {
  const { currentDate, includeOperationalWarnings = true } = options;
  const result = createValidationResult();

  if (!data || !Array.isArray(data.watchlist)) {
    pushError(result, "invalidCollection", "watchlist.json debe contener un array watchlist.", "watchlist");
    return result;
  }

  const seenTickers = new Map();

  data.watchlist.forEach((item, index) => {
    const label = `watchlist[${index}]`;
    const ticker = normalizeTicker(item && item.ticker);

    validateRequiredString(result, item && item.ticker, label, "ticker");
    validateStatus(result, item && item.status, label);
    validateRequiredString(result, item && item.thesis, label, "thesis");
    validateRequiredString(result, item && item.rationale, label, "rationale");
    validateRequiredString(result, item && item.catalyst, label, "catalyst");
    validateDateField(result, item && item.lastReviewedAt, label, "lastReviewedAt");
    validateDateField(result, item && item.nextReviewAt, label, "nextReviewAt");
    validateDateField(result, item && item.catalystDate, label, "catalystDate");

    if (!Number.isInteger(item && item.priority) || item.priority < 1) {
      pushError(
        result,
        "invalidPriority",
        "priority debe ser un entero mayor o igual a 1.",
        `${label}.priority`
      );
    }

    validateOptionalString(result, item && item.assetType, label, "assetType");
    validateOptionalString(result, item && item.market, label, "market");
    validateOptionalString(result, item && item.exchange, label, "exchange");
    validateOptionalString(result, item && item.catalystWindow, label, "catalystWindow");
    validateOptionalString(result, item && item.invalidation, label, "invalidation");
    validateOptionalString(result, item && item.source, label, "source");
    validateOptionalString(result, item && item.notes, label, "notes");
    validateOptionalNumber(result, item && item.lastPrice, label, "lastPrice");
    validateCatalystType(result, item && item.catalystType, label, "catalystType");
    validatePlaybookType(result, item && item.playbookType, label, "playbookType");
    validateOutlierFields(result, item, label);
    validateEtfFields(result, item, label, {
      includeOperationalWarnings,
      source: "watchlist",
      ticker
    });

    if (ticker) {
      if (seenTickers.has(ticker)) {
        pushWarning(
          result,
          "duplicatedTicker",
          `${ticker} aparece duplicado dentro de watchlist.`,
          label,
          { ticker }
        );
      }

      seenTickers.set(ticker, item);
    }

    if (
      includeOperationalWarnings &&
      (item.status === "mantener" || item.status === "observar") &&
      !isNonEmptyString(item.invalidation)
    ) {
      pushWarning(
        result,
        "missingInvalidation",
        `${ticker || label} requiere invalidation cuando el status es ${item.status}.`,
        `${label}.invalidation`,
        { source: "watchlist", status: item.status, ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      item.status !== "descartar" &&
      !isNonEmptyString(item.catalystType)
    ) {
      pushWarning(
        result,
        "missingCatalystType",
        `${ticker || label} no tiene catalystType cargado.`,
        `${label}.catalystType`,
        { source: "watchlist", ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      item.status !== "descartar" &&
      !isNonEmptyString(item.catalystDate) &&
      !isNonEmptyString(item.catalystWindow)
    ) {
      pushWarning(
        result,
        "missingCatalystDate",
        `${ticker || label} no tiene catalystDate cargado.`,
        `${label}.catalystDate`,
        { source: "watchlist", ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      item.status !== "descartar" &&
      !isFiniteNumber(item.lastPrice)
    ) {
      pushWarning(
        result,
        "missingLastPrice",
        `${ticker || label} no tiene lastPrice actualizado.`,
        `${label}.lastPrice`,
        { source: "watchlist", ticker }
      );
    }

    if (
      includeOperationalWarnings &&
      item.status !== "descartar" &&
      !isNonEmptyString(item.source)
    ) {
      pushWarning(
        result,
        "missingSource",
        `${ticker || label} no tiene source cargado para su catalyst.`,
        `${label}.source`,
        { source: "watchlist", ticker }
      );
    }

    if (includeOperationalWarnings) {
      warnIfMissingOutlierField(result, item, label, ticker, "catalystStrength", "watchlist");
      warnIfMissingOutlierField(result, item, label, ticker, "liquidityQuality", "watchlist");
      warnIfMissingOutlierField(result, item, label, ticker, "reratingPotential", "watchlist");
      warnIfMissingOutlierField(result, item, label, ticker, "downsideClarity", "watchlist");
    }

    if (
      includeOperationalWarnings &&
      isNonEmptyString(item.nextReviewAt) &&
      isValidDateOnlyString(item.nextReviewAt) &&
      currentDate &&
      compareDateOnlyStrings(item.nextReviewAt, currentDate) < 0
    ) {
      pushWarning(
        result,
        "overdueReview",
        `${ticker} tiene nextReviewAt vencido (${item.nextReviewAt}).`,
        `${label}.nextReviewAt`,
        { source: "watchlist", ticker }
      );
    }
  });

  return result;
}

function validateSnapshot(snapshot, currentDate) {
  const result = createValidationResult();

  if (!snapshot || typeof snapshot !== "object") {
    pushError(result, "invalidSnapshot", "stateSnapshot debe ser un objeto.", "stateSnapshot");
    return result;
  }

  result.errors.push(
    ...validatePositions(
      {
        positions: Array.isArray(snapshot.positions) ? snapshot.positions : []
      },
      {
        currentDate,
        includeOperationalWarnings: false
      }
    ).errors
  );

  result.errors.push(
    ...validateWatchlist(
      {
        watchlist: Array.isArray(snapshot.watchlist) ? snapshot.watchlist : []
      },
      {
        currentDate,
        includeOperationalWarnings: false
      }
    ).errors
  );

  if (!Array.isArray(snapshot.positions)) {
    pushError(result, "invalidSnapshot", "stateSnapshot.positions debe ser un array.", "stateSnapshot.positions");
  }

  if (!Array.isArray(snapshot.watchlist)) {
    pushError(result, "invalidSnapshot", "stateSnapshot.watchlist debe ser un array.", "stateSnapshot.watchlist");
  }

  return result;
}

function validateOpportunity(opportunity, label) {
  const result = createValidationResult();

  validateRequiredString(result, opportunity && opportunity.ticker, label, "ticker");
  validateStatus(result, opportunity && opportunity.status, label, {
    allowOpportunityStatus: true
  });
  validateRequiredString(result, opportunity && opportunity.thesis, label, "thesis");
  validateRequiredString(result, opportunity && opportunity.whyNow, label, "whyNow");
  validateOptionalString(result, opportunity && opportunity.duplicateJustification, label, "duplicateJustification");

  if (opportunity && opportunity.status !== "nueva oportunidad") {
    pushError(
      result,
      "invalidStatus",
      'status debe ser "nueva oportunidad".',
      `${label}.status`
    );
  }

  return result;
}

function validateLog(data, maxNewOpportunities, options = {}) {
  const { currentDate } = options;
  const result = createValidationResult();

  if (!data || !Array.isArray(data.entries)) {
    pushError(result, "invalidCollection", "daily_log.json debe contener un array entries.", "entries");
    return result;
  }

  data.entries.forEach((entry, index) => {
    const label = `entries[${index}]`;

    validateDateField(result, entry && entry.date, label, "date");
    validateRequiredString(result, entry && entry.marketContext, label, "marketContext");
    validateRequiredArray(result, entry && entry.portfolioChanges, label, "portfolioChanges");
    validateRequiredArray(result, entry && entry.watchlistChanges, label, "watchlistChanges");
    validateRequiredString(result, entry && entry.decision, label, "decision");
    validateRequiredString(result, entry && entry.justification, label, "justification");

    if (!Array.isArray(entry && entry.newOpportunities)) {
      pushError(
        result,
        "invalidCollection",
        "newOpportunities debe ser un array.",
        `${label}.newOpportunities`
      );
    } else {
      if (entry.newOpportunities.length > maxNewOpportunities) {
        pushError(
          result,
          "maxNewOpportunities",
          `maximo ${maxNewOpportunities} oportunidades nuevas por revision.`,
          `${label}.newOpportunities`
        );
      }

      entry.newOpportunities.forEach((opportunity, opportunityIndex) => {
        const opportunityLabel = `${label}.newOpportunities[${opportunityIndex}]`;
        const opportunityResult = validateOpportunity(opportunity, opportunityLabel);
        result.errors.push(...opportunityResult.errors);
        result.warnings.push(...opportunityResult.warnings);
      });
    }

    if (entry && entry.stateSnapshot !== undefined) {
      const snapshotResult = validateSnapshot(entry.stateSnapshot, currentDate);
      result.errors.push(...snapshotResult.errors);
      result.warnings.push(...snapshotResult.warnings);
    }
  });

  return result;
}

function validateIncomingLogEntry(entry, options = {}) {
  const { currentDate, existingPositions = [], existingWatchlist = [], maxNewOpportunities = 3 } = options;
  const result = mergeValidationResults(
    validateLog(
      {
        entries: [entry]
      },
      maxNewOpportunities,
      { currentDate }
    )
  );

  const knownTickers = new Set(
    [...existingPositions, ...existingWatchlist].map((item) => normalizeTicker(item.ticker)).filter(Boolean)
  );
  const opportunityTickers = new Set();

  (entry.newOpportunities || []).forEach((opportunity, index) => {
    const label = `newOpportunities[${index}]`;
    const ticker = normalizeTicker(opportunity && opportunity.ticker);

    if (!ticker) {
      return;
    }

    if (opportunityTickers.has(ticker)) {
      pushError(
        result,
        "duplicatedTicker",
        `${ticker} aparece repetido dentro de newOpportunities.`,
        `${label}.ticker`,
        { ticker }
      );
    }

    opportunityTickers.add(ticker);

    if (knownTickers.has(ticker) && !isNonEmptyString(opportunity.duplicateJustification)) {
      pushError(
        result,
        "opportunityDuplicated",
        `${ticker} ya existe en posiciones o watchlist. Debes agregar duplicateJustification.`,
        `${label}.duplicateJustification`,
        { ticker }
      );
    }
  });

  return result;
}

function validateIncomingOutcomeEntry(outcome, options = {}) {
  const { currentDate, existingOutcomes = [] } = options;
  const result = mergeValidationResults(
    validateOutcomes(
      {
        outcomes: [outcome]
      },
      { currentDate, fileName: "incomingOutcome" }
    )
  );

  const ticker = normalizeTicker(outcome && outcome.ticker);
  const playbookType = isNonEmptyString(outcome && outcome.playbookType) ? outcome.playbookType : "";
  const loggedAt = isNonEmptyString(outcome && outcome.loggedAt) ? outcome.loggedAt : "";

  if (!ticker || !playbookType || !loggedAt) {
    return result;
  }

  const isDuplicated = existingOutcomes.some(
    (item) =>
      normalizeTicker(item && item.ticker) === ticker &&
      (item && item.playbookType) === playbookType &&
      (item && item.loggedAt) === loggedAt
  );

  if (isDuplicated) {
    pushError(
      result,
      "duplicatedOutcome",
      `${ticker} ya tiene un outcome para ${playbookType} con loggedAt ${loggedAt}.`,
      "incomingOutcome",
      { ticker }
    );
  }

  return result;
}

function validateSettings(settings) {
  const result = createValidationResult();

  if (!settings || typeof settings !== "object") {
    pushError(result, "invalidSettings", "settings.json debe ser un objeto.", "settings");
    return result;
  }

  validateRequiredString(result, settings.projectName, "settings", "projectName");
  validateRequiredString(result, settings.timezone, "settings", "timezone");
  validateRequiredString(result, settings.currency, "settings", "currency");
  validateRequiredString(result, settings.reportPrefix, "settings", "reportPrefix");

  if (!Number.isInteger(settings.maxNewOpportunities) || settings.maxNewOpportunities < 1) {
    pushError(
      result,
      "invalidSetting",
      "maxNewOpportunities debe ser un entero mayor o igual a 1.",
      "settings.maxNewOpportunities"
    );
  }

  return result;
}

function isAcknowledgedPositionWatchlistSplit(position, watchItem) {
  return Boolean(
    position &&
      watchItem &&
      position.status === "observar" &&
      watchItem.status === "descartar" &&
      watchItem.inPortfolio === true &&
      watchItem.sourceOfTruth === "positions" &&
      watchItem.noNewEntryFromWatchlist === true
  );
}

function validateStateConsistency(state) {
  const result = createValidationResult();
  const positions = (state.positions && state.positions.positions) || [];
  const watchlist = (state.watchlist && state.watchlist.watchlist) || [];
  const outcomes = (state.outcomes && state.outcomes.outcomes) || [];
  const positionsByTicker = new Map();
  const resolvedOutcomeTickers = new Map();

  positions.forEach((position, index) => {
    const ticker = normalizeTicker(position.ticker);

    if (ticker) {
      positionsByTicker.set(ticker, {
        index,
        position
      });
    }
  });

  outcomes.forEach((outcome) => {
    const ticker = normalizeTicker(outcome && outcome.ticker);

    if (!ticker || outcome.outcomeLabel === "abierto") {
      return;
    }

    const existing = resolvedOutcomeTickers.get(ticker) || [];
    existing.push(outcome);
    resolvedOutcomeTickers.set(ticker, existing);
  });

  watchlist.forEach((item, index) => {
    const ticker = normalizeTicker(item.ticker);

    if (!ticker) {
      return;
    }

    if (positionsByTicker.has(ticker)) {
      const existing = positionsByTicker.get(ticker);
      const acknowledgedSplit = isAcknowledgedPositionWatchlistSplit(existing.position, item);

      if (acknowledgedSplit) {
        pushWarning(
          result,
          "acknowledged_position_watchlist_split",
          `${ticker} tiene split reconocido: posicion real en observar y watchlist descartada sin nueva entrada.`,
          `watchlist[${index}]`,
          { source: "watchlist", ticker }
        );
        return;
      }

      pushWarning(
        result,
        "duplicatedTicker",
        `${ticker} aparece tanto en posiciones como en watchlist.`,
        `watchlist[${index}]`,
        { source: "watchlist", ticker }
      );

      if (existing.position.status !== item.status) {
        pushWarning(
          result,
          "conflictingStatus",
          `${ticker} tiene status conflictivo entre posiciones (${existing.position.status}) y watchlist (${item.status}).`,
          `watchlist[${index}].status`,
          { source: "watchlist", ticker }
        );
      }
    }
  });

  positionsByTicker.forEach((entry, ticker) => {
    if (!resolvedOutcomeTickers.has(ticker)) {
      return;
    }

    const latestResolved = [...resolvedOutcomeTickers.get(ticker)].sort((left, right) =>
      (right.resolvedAt || right.loggedAt || "").localeCompare(left.resolvedAt || left.loggedAt || "")
    )[0];

    pushWarning(
      result,
      "positionOutcomeOverlap",
      `${ticker} aparece como posicion abierta y tambien tiene un outcome resuelto (${latestResolved.resolvedAt || latestResolved.loggedAt || "fecha n/d"}). Debe quedar explicitado si es una campana distinta.`,
      `positions[${entry.index}]`,
      { source: "position", ticker }
    );
  });

  return result;
}

function validateCatalystFeed(data, options = {}) {
  const { expectedType, fileName = "catalysts.json" } = options;
  const result = createValidationResult();

  if (!data || !Array.isArray(data.catalysts)) {
    pushError(
      result,
      "invalidCollection",
      `${fileName} debe contener un array catalysts.`,
      `${fileName}.catalysts`
    );
    return result;
  }

  validateOptionalString(result, data.updatedAt, fileName, "updatedAt");

  const seenTickers = new Set();

  data.catalysts.forEach((item, index) => {
    const label = `${fileName}.catalysts[${index}]`;
    const ticker = normalizeTicker(item && item.ticker);

    validateRequiredString(result, item && item.ticker, label, "ticker");
    validateRequiredString(result, item && item.source, label, "source");
    validateDateField(result, item && item.catalystDate, label, "catalystDate");
    validateCatalystType(result, item && item.catalystType, label, "catalystType");
    validateOptionalString(result, item && item.notes, label, "notes");
    validateOptionalObject(result, item && item.metadata, label, "metadata");

    if (expectedType && item && item.catalystType !== expectedType) {
      pushError(
        result,
        "invalidCatalystType",
        `catalystType debe ser ${expectedType} dentro de ${fileName}.`,
        `${label}.catalystType`
      );
    }

    if (ticker) {
      if (seenTickers.has(ticker)) {
        pushWarning(
          result,
          "duplicatedTicker",
          `${ticker} aparece duplicado dentro de ${fileName}.`,
          label,
          { source: fileName, ticker }
        );
      }

      seenTickers.add(ticker);
    }
  });

  return result;
}

function validateSocialSignalFeed(data, options = {}) {
  const { fileName = "social_signals.json" } = options;
  const result = createValidationResult();

  if (!data || !Array.isArray(data.signals)) {
    pushError(
      result,
      "invalidCollection",
      `${fileName} debe contener un array signals.`,
      `${fileName}.signals`
    );
    return result;
  }

  validateOptionalString(result, data.updatedAt, fileName, "updatedAt");

  data.signals.forEach((signal, index) => {
    const label = `${fileName}.signals[${index}]`;

    validateRequiredString(result, signal && signal.ticker, label, "ticker");
    validateEnum(
      result,
      signal && signal.sourcePlatform,
      VALID_SOURCE_PLATFORMS,
      label,
      "sourcePlatform",
      "invalidSourcePlatform"
    );
    validateOptionalString(result, signal && signal.sourceHandle, label, "sourceHandle");
    validateEnum(
      result,
      signal && signal.signalType,
      VALID_SOCIAL_SIGNAL_TYPES,
      label,
      "signalType",
      "invalidSignalType"
    );
    validateRequiredString(result, signal && signal.timestamp, label, "timestamp");
    validateTimestampField(result, signal && signal.timestamp, label, "timestamp");
    validateRequiredString(result, signal && signal.claim, label, "claim");
    validateEnum(
      result,
      signal && signal.verificationStatus,
      VALID_VERIFICATION_STATUSES,
      label,
      "verificationStatus",
      "invalidVerificationStatus"
    );
    validateOptionalScore(result, signal && signal.independenceScore, label, "independenceScore", {
      min: 0,
      max: 5
    });
    validateOptionalScore(result, signal && signal.crowdingRisk, label, "crowdingRisk", {
      min: 0,
      max: 5
    });
    validateOptionalString(result, signal && signal.notes, label, "notes");
  });

  return result;
}

function validateOutcomes(data, options = {}) {
  const { currentDate, fileName = "outcomes.json" } = options;
  const result = createValidationResult();

  if (!data || !Array.isArray(data.outcomes)) {
    pushError(
      result,
      "invalidCollection",
      `${fileName} debe contener un array outcomes.`,
      `${fileName}.outcomes`
    );
    return result;
  }

  validateOptionalString(result, data.updatedAt, fileName, "updatedAt");

  data.outcomes.forEach((outcome, index) => {
    const label = `${fileName}.outcomes[${index}]`;
    const ticker = normalizeTicker(outcome && outcome.ticker);

    validateRequiredString(result, outcome && outcome.ticker, label, "ticker");
    validateEnum(
      result,
      outcome && outcome.sourceKind,
      VALID_OUTCOME_SOURCE_KINDS,
      label,
      "sourceKind",
      "invalidOutcomeSourceKind"
    );
    validateDateField(result, outcome && outcome.loggedAt, label, "loggedAt");
    validateDateField(result, outcome && outcome.resolvedAt, label, "resolvedAt");
    validateRequiredString(result, outcome && outcome.horizon, label, "horizon");
    validateOptionalString(result, outcome && outcome.setupType, label, "setupType");
    validateSetupRank(result, outcome && outcome.setupRankAtEntry, label, "setupRankAtEntry");
    validatePlaybookType(result, outcome && outcome.playbookType, label, "playbookType");
    validateOptionalString(result, outcome && outcome.assetType, label, "assetType");
    validateCatalystType(result, outcome && outcome.catalystType, label, "catalystType");
    validateOptionalString(result, outcome && outcome.expectedMove, label, "expectedMove");
    validateOptionalNumber(result, outcome && outcome.resultPct, label, "resultPct");
    validateOptionalNumber(result, outcome && outcome.entryPrice, label, "entryPrice");
    validateOptionalNumber(result, outcome && outcome.exitPrice, label, "exitPrice");
    validateOptionalNumber(result, outcome && outcome.peakPriceWithinWindow, label, "peakPriceWithinWindow");
    validateOptionalNumber(result, outcome && outcome.peakPriceWithin30d, label, "peakPriceWithin30d");
    validateOptionalNumber(result, outcome && outcome.maxPostEntryReturnPct, label, "maxPostEntryReturnPct");
    validateOptionalInteger(result, outcome && outcome.daysToPeak, label, "daysToPeak", { min: 0 });
    validateOptionalNumber(result, outcome && outcome.maxDrawdownPctBeforePeak, label, "maxDrawdownPctBeforePeak");
    validateOptionalNumber(result, outcome && outcome.return5d, label, "return5d");
    validateOptionalNumber(result, outcome && outcome.return10d, label, "return10d");
    validateOptionalNumber(result, outcome && outcome.return20d, label, "return20d");
    validateOptionalNumber(result, outcome && outcome.return30d, label, "return30d");
    validateOptionalBoolean(result, outcome && outcome.hit7pct, label, "hit7pct");
    validateOptionalBoolean(result, outcome && outcome.hit10pct, label, "hit10pct");
    validateOptionalBoolean(result, outcome && outcome.hit15pct, label, "hit15pct");
    validateOptionalBoolean(result, outcome && outcome.failedFast, label, "failedFast");
    validateOptionalBoolean(result, outcome && outcome.falsePositive, label, "falsePositive");
    validateEnum(
      result,
      outcome && outcome.outcomeLabel,
      VALID_OUTCOME_LABELS,
      label,
      "outcomeLabel",
      "invalidOutcomeLabel"
    );
    validateRequiredString(result, outcome && outcome.why, label, "why");
    validateOptionalString(result, outcome && outcome.lessons, label, "lessons");
    validateOptionalObject(result, outcome && outcome.metadata, label, "metadata");

    if (
      outcome &&
      outcome.outcomeLabel &&
      outcome.outcomeLabel !== "abierto" &&
      !isNonEmptyString(outcome.resolvedAt)
    ) {
      pushError(
        result,
        "missingResolvedAt",
        `${ticker || label} debe tener resolvedAt cuando outcomeLabel no es abierto.`,
        `${label}.resolvedAt`,
        { ticker }
      );
    }

    if (
      outcome &&
      outcome.outcomeLabel === "abierto" &&
      isNonEmptyString(outcome.resolvedAt)
    ) {
      pushWarning(
        result,
        "unexpectedResolvedAt",
        `${ticker || label} tiene resolvedAt cargado aunque el outcome sigue abierto.`,
        `${label}.resolvedAt`,
        { ticker }
      );
    }

    if (
      outcome &&
      outcome.outcomeLabel !== "abierto" &&
      outcome.resultPct === undefined
    ) {
      pushWarning(
        result,
        "missingResultPct",
        `${ticker || label} no tiene resultPct cargado para un outcome resuelto.`,
        `${label}.resultPct`,
        { ticker }
      );
    }

    if (
      outcome &&
      outcome.outcomeLabel !== "abierto" &&
      !isNonEmptyString(outcome.playbookType)
    ) {
      pushWarning(
        result,
        "missingPlaybookType",
        `${ticker || label} no tiene playbookType cargado para medir el loop por estrategia.`,
        `${label}.playbookType`,
        { ticker }
      );
    }

    if (
      outcome &&
      isNonEmptyString(outcome.loggedAt) &&
      isNonEmptyString(outcome.resolvedAt) &&
      isValidDateOnlyString(outcome.loggedAt) &&
      isValidDateOnlyString(outcome.resolvedAt) &&
      compareDateOnlyStrings(outcome.resolvedAt, outcome.loggedAt) < 0
    ) {
      pushError(
        result,
        "invalidOutcomeWindow",
        `${ticker || label} no puede resolver antes de loggedAt.`,
        `${label}.resolvedAt`,
        { ticker }
      );
    }

    if (
      currentDate &&
      outcome &&
      isNonEmptyString(outcome.loggedAt) &&
      isValidDateOnlyString(outcome.loggedAt) &&
      compareDateOnlyStrings(outcome.loggedAt, currentDate) > 0
    ) {
      pushWarning(
        result,
        "futureLoggedAt",
        `${ticker || label} tiene loggedAt en el futuro (${outcome.loggedAt}).`,
        `${label}.loggedAt`,
        { ticker }
      );
    }
  });

  return result;
}

module.exports = {
  assertValid,
  compareDateOnlyStrings,
  createValidationResult,
  formatIssue,
  hasValidUnderlyingConfirmation,
  isFiniteNumber,
  isEtfAsset,
  isNonEmptyString,
  isValidDateOnlyString,
  isValidTimestampString,
  mergeValidationResults,
  normalizeTextEnum,
  normalizeTicker,
  parseDateOnlyToUtc,
  validateCatalystFeed,
  validateIncomingOutcomeEntry,
  validateIncomingLogEntry,
  validateLog,
  validatePositions,
  validateOutcomes,
  validateSettings,
  validateSocialSignalFeed,
  validateStateConsistency,
  validateWatchlist
};
