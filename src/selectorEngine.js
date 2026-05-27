"use strict";

const fs = require("fs");
const path = require("path");
const { BACKTESTS_DIR, DATA_DIR } = require("./storage");
const { isFiniteNumber, normalizeTicker } = require("./validators");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(BACKTESTS_DIR, "selector-engine");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const POSITIONS_PATH = path.join(DATA_DIR, "positions.json");
const WATCHLIST_PATH = path.join(DATA_DIR, "watchlist.json");
const DAILY_COCKPIT_PATH = path.join(BACKTESTS_DIR, "daily-cockpit", "latest.json");
const SOCIAL_RADAR_PATH = path.join(BACKTESTS_DIR, "social-radar", "latest.json");
const SOCIAL_SOURCES_PATH = path.join(BACKTESTS_DIR, "social-source-tracker", "sources-scored.json");
const SOCIAL_INBOX_PATH = path.join(BACKTESTS_DIR, "social-inbox", "normalized-mentions.json");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");

const MIN_DOLLAR_VOLUME = 10000000;
const MIN_RELATIVE_VOLUME = 1.25;
const MAX_A_PLUS_DAY_CHANGE_PCT = 8;
const ALLOWED_ACTIONS = new Set([
  "no_operar",
  "mantener",
  "vigilar",
  "revisar_manual",
  "candidato_manual",
  "descartar"
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
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
  assertSelectorOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  assertSelectorOutput(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function assertSelectorOutput(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("selector-engine solo puede escribir dentro de backtests/selector-engine/.");
  }
}

function formatRelative(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function round(value, decimals = 2) {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  if (!isFiniteNumber(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
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

function firstText(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim().length > 0);
  return value ? value.trim() : "";
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function maxScore(...values) {
  const numbers = values.map(coerceNumber).filter(isFiniteNumber);
  return numbers.length ? Math.max(...numbers) : null;
}

function formatNumber(value, decimals = 1) {
  if (!isFiniteNumber(value)) {
    return "n/d";
  }

  return round(value, decimals).toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals
  });
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

function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(dateText, currentDateText) {
  const date = parseDateOnly(dateText);
  const currentDate = parseDateOnly(currentDateText);

  if (!date || !currentDate) {
    return null;
  }

  return Math.round((date.getTime() - currentDate.getTime()) / 86400000);
}

function normalizeMarketData(raw) {
  const source = raw || {};
  const price = coerceNumber(firstValue(source.price, source.lastPrice));

  return {
    averageVolume20: coerceNumber(source.averageVolume20),
    dayChangePct: coerceNumber(source.dayChangePct),
    dayHigh: coerceNumber(source.dayHigh),
    dayLow: coerceNumber(source.dayLow),
    dollarVolume: coerceNumber(source.dollarVolume),
    lastDataDate: source.lastDataDate || source.timestamp || null,
    price,
    previousClose: coerceNumber(source.previousClose),
    relativeVolume: coerceNumber(source.relativeVolume),
    source: source.source || source.sourceTag || null,
    volume: coerceNumber(source.volume)
  };
}

function readInputs() {
  const settings = readJson(SETTINGS_PATH);
  const positions = readJson(POSITIONS_PATH);
  const watchlist = readJson(WATCHLIST_PATH);
  const dailyCockpit = readJsonIfExists(DAILY_COCKPIT_PATH);
  const socialRadar = readJsonIfExists(SOCIAL_RADAR_PATH);
  const socialSources = readJsonIfExists(SOCIAL_SOURCES_PATH);
  const socialInbox = readJsonIfExists(SOCIAL_INBOX_PATH);

  return {
    dailyCockpit,
    positions,
    settings,
    socialInbox,
    socialRadar,
    socialSources,
    watchlist
  };
}

function indexByTicker(items) {
  const index = new Map();

  (items || []).forEach((item) => {
    const ticker = normalizeTicker(item && item.ticker);

    if (ticker && !index.has(ticker)) {
      index.set(ticker, item);
    }
  });

  return index;
}

function buildSocialIndex(socialRadar, socialInbox, socialSources) {
  const mentionsByTicker = new Map();
  const sourceById = new Map();

  ((socialSources && socialSources.scoredSources) || []).forEach((source) => {
    if (source && source.sourceId) {
      sourceById.set(source.sourceId, source);
    }
  });

  const radarMentions = (socialRadar && Array.isArray(socialRadar.mentions)) ? socialRadar.mentions : [];
  const inboxMentions = (socialInbox && Array.isArray(socialInbox.normalizedMentions)) ? socialInbox.normalizedMentions : [];

  [...radarMentions, ...inboxMentions].forEach((mention) => {
    const ticker = normalizeTicker(mention && mention.ticker);

    if (!ticker) {
      return;
    }

    const current = mentionsByTicker.get(ticker) || [];
    current.push({
      ...mention,
      source: sourceById.get(mention.sourceId) || null
    });
    mentionsByTicker.set(ticker, current);
  });

  return {
    mentionsByTicker,
    sourceById
  };
}

function buildPortfolioContext(settings, positions) {
  const totalCapital = coerceNumber(settings && settings.portfolio && settings.portfolio.totalCapitalEstimate);
  const cash = coerceNumber(settings && settings.portfolio && settings.portfolio.cashEstimate);
  const maxPositionPct = coerceNumber(settings && settings.risk && settings.risk.maxPositionPct);
  const maxBiotechPct = coerceNumber(settings && settings.risk && settings.risk.maxBiotechPct);
  const rows = ((positions && positions.positions) || []).map((position) => {
    const ticker = normalizeTicker(position.ticker);
    const quantity = coerceNumber(position.quantity);
    const market = normalizeMarketData(position.marketData || {});
    const price = coerceNumber(firstValue(position.lastPrice, market.price, position.avgPrice));
    const marketValue = isFiniteNumber(quantity) && isFiniteNumber(price) ? quantity * price : null;

    return {
      isBiotechCatalyst: isBiotechCatalyst(position),
      marketValue,
      pct: isFiniteNumber(totalCapital) && totalCapital > 0 && isFiniteNumber(marketValue)
        ? (Math.abs(marketValue) / totalCapital) * 100
        : null,
      raw: position,
      ticker
    };
  });
  const biotechPct = rows.reduce(
    (sum, row) => sum + (row.isBiotechCatalyst && isFiniteNumber(row.pct) ? row.pct : 0),
    0
  );

  return {
    biotechPct,
    cash,
    maxBiotechPct,
    maxPositionPct,
    rows,
    totalCapital
  };
}

function buildUniverse(inputs, socialIndex) {
  const positionIndex = indexByTicker((inputs.positions && inputs.positions.positions) || []);
  const watchlistIndex = indexByTicker((inputs.watchlist && inputs.watchlist.watchlist) || []);
  const dailyPortfolioIndex = indexByTicker((inputs.dailyCockpit && inputs.dailyCockpit.portfolio) || []);
  const dailyWatchlistIndex = indexByTicker((inputs.dailyCockpit && inputs.dailyCockpit.watchlist) || []);
  const tickers = new Set([
    ...positionIndex.keys(),
    ...watchlistIndex.keys(),
    ...dailyPortfolioIndex.keys(),
    ...dailyWatchlistIndex.keys(),
    ...socialIndex.mentionsByTicker.keys()
  ]);

  return [...tickers].sort().map((ticker) => {
    const position = positionIndex.get(ticker) || null;
    const watchlist = watchlistIndex.get(ticker) || null;
    const dailyPortfolio = dailyPortfolioIndex.get(ticker) || null;
    const dailyWatchlist = dailyWatchlistIndex.get(ticker) || null;
    const marketFromDaily = inputs.dailyCockpit && inputs.dailyCockpit.marketData
      ? inputs.dailyCockpit.marketData[ticker]
      : null;
    const marketData = normalizeMarketData(
      marketFromDaily ||
        (position && position.marketData) ||
        (watchlist && watchlist.marketData) ||
        dailyPortfolio ||
        dailyWatchlist ||
        {}
    );

    return {
      dailyPortfolio,
      dailyWatchlist,
      inPortfolio: Boolean(position),
      inWatchlist: Boolean(watchlist),
      marketData,
      position,
      socialMentions: socialIndex.mentionsByTicker.get(ticker) || [],
      ticker,
      watchlist
    };
  });
}

function getMergedField(candidate, fieldName) {
  return firstValue(
    candidate.position && candidate.position[fieldName],
    candidate.watchlist && candidate.watchlist[fieldName],
    candidate.dailyPortfolio && candidate.dailyPortfolio[fieldName],
    candidate.dailyWatchlist && candidate.dailyWatchlist[fieldName]
  );
}

function getMergedText(candidate, fieldName) {
  return firstText(
    candidate.position && candidate.position[fieldName],
    candidate.watchlist && candidate.watchlist[fieldName],
    candidate.dailyPortfolio && candidate.dailyPortfolio[fieldName],
    candidate.dailyWatchlist && candidate.dailyWatchlist[fieldName]
  );
}

function getCandidateText(candidate) {
  return [
    candidate.ticker,
    getMergedText(candidate, "status"),
    getMergedText(candidate, "setupRank"),
    getMergedText(candidate, "setupType"),
    getMergedText(candidate, "thesis"),
    getMergedText(candidate, "rationale"),
    getMergedText(candidate, "catalyst"),
    getMergedText(candidate, "notes"),
    getMergedText(candidate, "invalidation")
  ].join(" ");
}

function isBiotechCatalyst(item) {
  const text = [
    item && item.assetType,
    item && item.sector,
    item && item.industry,
    item && item.catalystType,
    item && item.catalyst,
    item && item.setupType,
    item && item.thesis
  ].filter(Boolean).join(" ").toLowerCase();

  return /biotech|biopharma|pharma|therapeutic|clinical|phase|pdufa|fda|drug|readout/.test(text);
}

function detectCatalystKind(candidate) {
  const text = getCandidateText(candidate).toLowerCase();
  const direct = String(getMergedField(candidate, "catalystType") || "").toLowerCase();

  if (direct === "fda" || /pdufa|fda|approval|phase|readout|clinical|trial/.test(text)) {
    return "fda/clinical";
  }

  if (direct === "earnings" || /earnings|q[1-4]|results/.test(text)) {
    return "earnings";
  }

  if (direct === "insider" || /insider|form 4|director buy|ceo buy/.test(text)) {
    return "insider";
  }

  if (/m&a|merger|acquisition|takeover|buyout/.test(text)) {
    return "m&a";
  }

  if (direct === "unusual-volume-gap" || /unusual volume|gap/.test(text)) {
    return "unusual-volume-gap";
  }

  return direct || "unknown";
}

function scoreCatalyst(candidate, currentDate) {
  const catalyst = getMergedText(candidate, "catalyst");
  const catalystDate = getMergedText(candidate, "catalystDate");
  const catalystWindow = getMergedText(candidate, "catalystWindow");
  const kind = detectCatalystKind(candidate);
  const days = daysUntil(catalystDate, currentDate);
  const parts = [];
  const missing = [];
  let score = 0;

  if (catalyst) {
    score += 4;
    parts.push("catalyst escrito +4");
  } else {
    missing.push("catalyst verificable");
  }

  if (catalystDate) {
    score += 6;
    parts.push("catalyst fechado +6");
  } else if (catalystWindow) {
    score += 3;
    parts.push("ventana sin fecha exacta +3");
    missing.push("fecha exacta de catalyst");
  } else {
    missing.push("fecha o ventana de catalyst");
  }

  if (isFiniteNumber(days)) {
    if (days >= 0 && days <= 45) {
      score += 6;
      parts.push("catalyst cercano +6");
    } else if (days > 45 && days <= 90) {
      score += 3;
      parts.push("catalyst en 46-90 dias +3");
    } else if (days < 0) {
      score -= 3;
      parts.push("catalyst vencido -3");
    }
  }

  if (kind === "fda/clinical") {
    score += 7;
    parts.push("FDA/PDUFA/phase/readout +7");
  } else if (kind === "earnings") {
    score += 5;
    parts.push("earnings +5");
  } else if (kind === "insider" || kind === "m&a") {
    score += 4;
    parts.push(`${kind} +4`);
  } else if (kind === "unusual-volume-gap") {
    score += 3;
    parts.push("unusual-volume-gap +3");
  } else {
    missing.push("tipo de catalyst claro");
  }

  const strength = maxScore(
    candidate.position && candidate.position.catalystStrength,
    candidate.watchlist && candidate.watchlist.catalystStrength
  );
  if (isFiniteNumber(strength)) {
    const bonus = clamp(strength, 0, 5) * 0.4;
    score += bonus;
    parts.push(`catalystStrength local +${round(bonus, 1)}`);
  }

  return {
    catalyst,
    catalystDate: catalystDate || null,
    catalystWindow: catalystWindow || null,
    daysUntilCatalyst: days,
    kind,
    missing,
    parts,
    score: clamp(round(score, 1), 0, 25)
  };
}

function scoreVolumeLiquidity(candidate) {
  const market = candidate.marketData || {};
  const relVol = market.relativeVolume;
  const dollarVolume = market.dollarVolume;
  const parts = [];
  const missing = [];
  const redFlags = [];
  let score = 0;

  if (isFiniteNumber(relVol)) {
    if (relVol >= MIN_RELATIVE_VOLUME) {
      score += 8;
      parts.push("RelVol fuerte +8");
    } else if (relVol >= 0.75) {
      score += 5;
      parts.push("RelVol aceptable +5");
    } else if (relVol >= 0.3) {
      score += 2;
      parts.push("RelVol bajo +2");
      redFlags.push("RelVol bajo");
    } else {
      redFlags.push("RelVol muy bajo");
    }
  } else {
    missing.push("RelVol");
  }

  if (isFiniteNumber(dollarVolume)) {
    if (dollarVolume >= MIN_DOLLAR_VOLUME) {
      score += 8;
      parts.push("dollar volume suficiente +8");
    } else if (dollarVolume >= 5000000) {
      score += 5;
      parts.push("dollar volume borderline +5");
      redFlags.push("liquidez borderline");
    } else if (dollarVolume >= 2000000) {
      score += 2;
      parts.push("dollar volume bajo +2");
      redFlags.push("liquidez baja");
    } else {
      redFlags.push("liquidez muy baja");
    }
  } else {
    missing.push("dollar volume");
  }

  const liquidityQuality = maxScore(
    candidate.position && candidate.position.liquidityQuality,
    candidate.watchlist && candidate.watchlist.liquidityQuality
  );
  if (isFiniteNumber(liquidityQuality)) {
    const bonus = clamp(liquidityQuality, 0, 5) * 0.8;
    score += bonus;
    parts.push(`liquidityQuality local +${round(bonus, 1)}`);
  }

  return {
    missing,
    parts,
    redFlags,
    score: clamp(round(score, 1), 0, 20)
  };
}

function scorePortfolioFit(candidate, portfolioContext) {
  const parts = [];
  const redFlags = [];
  const missing = [];
  const positionRow = portfolioContext.rows.find((row) => row.ticker === candidate.ticker);
  const positionPct = positionRow && isFiniteNumber(positionRow.pct) ? positionRow.pct : 0;
  const isBio = isBiotechCatalyst(candidate.position || candidate.watchlist || {});
  let score = 0;

  if (candidate.inPortfolio) {
    score += 5;
    parts.push("ya esta en cartera +5");
  } else if (candidate.inWatchlist) {
    score += 3;
    parts.push("esta en watchlist +3");
  }

  if (isFiniteNumber(portfolioContext.cash) && isFiniteNumber(portfolioContext.totalCapital)) {
    const cashPct = portfolioContext.totalCapital > 0 ? (portfolioContext.cash / portfolioContext.totalCapital) * 100 : null;
    if (isFiniteNumber(cashPct) && cashPct >= 20) {
      score += 3;
      parts.push("cash suficiente +3");
    } else if (isFiniteNumber(cashPct) && cashPct >= 5) {
      score += 1;
      parts.push("cash limitado +1");
    } else {
      redFlags.push("cash bajo o no disponible");
    }
  } else {
    missing.push("cash/capital confiable");
  }

  if (candidate.inPortfolio) {
    if (positionPct > 25) {
      redFlags.push("posicion actual grande");
    } else if (positionPct >= 10) {
      score += 2;
      parts.push("posicion actual moderada +2");
    } else {
      score += 4;
      parts.push("posicion actual chica +4");
    }
  } else {
    score += 3;
    parts.push("no aumenta posicion existente +3");
  }

  if (isBio) {
    if (
      isFiniteNumber(portfolioContext.biotechPct) &&
      isFiniteNumber(portfolioContext.maxBiotechPct) &&
      portfolioContext.biotechPct >= portfolioContext.maxBiotechPct * 0.8
    ) {
      redFlags.push("concentracion biotech/catalyst alta");
      score += candidate.inPortfolio ? 1 : 0;
    } else {
      score += 3;
      parts.push("biotech/catalyst dentro de limite +3");
    }
  } else {
    score += 3;
    parts.push("diversifica fuera de biotech catalyst +3");
  }

  return {
    missing,
    positionPct: round(positionPct, 2),
    redFlags,
    score: clamp(round(score, 1), 0, 15)
  };
}

function scoreSocial(candidate) {
  const mentions = candidate.socialMentions || [];
  const parts = [];
  const redFlags = [];
  let score = 0;

  mentions.forEach((mention) => {
    if (mention.suggestedAction === "review_with_waly") {
      score += 5;
      parts.push("social-radar review_with_waly +5");
    } else if (mention.suggestedAction === "add_to_watchlist") {
      score += 3;
      parts.push("social-radar add_to_watchlist +3");
    } else if (mention.suggestedAction === "research") {
      score += 1;
      parts.push("social-radar research +1");
    }

    if (isFiniteNumber(mention.sourceReliabilityScore) && mention.sourceReliabilityScore >= 55) {
      score += 2;
      parts.push("fuente confiable +2");
    }

    if (mention.sourceStatus === "active" || (mention.source && mention.source.finalStatus === "active")) {
      score += 1;
      parts.push("fuente active +1");
    }

    if (mention.audit && mention.audit.catalystVerifiable) {
      score += 1;
      parts.push("social con catalyst verificable +1");
    }

    if (Array.isArray(mention.riskFlags) && mention.riskFlags.length > 0) {
      redFlags.push(...mention.riskFlags.slice(0, 3));
    }
  });

  const localSocial = maxScore(
    candidate.position && candidate.position.socialDiscoveryScore,
    candidate.watchlist && candidate.watchlist.socialDiscoveryScore
  );
  if (mentions.length === 0 && isFiniteNumber(localSocial)) {
    const localBonus = Math.min(3, localSocial * 0.6);
    score += localBonus;
    parts.push(`socialDiscoveryScore local +${round(localBonus, 1)}`);
  }

  if (!score && mentions.length > 0) {
    redFlags.push("social sin calidad suficiente");
  }

  return {
    mentionsCount: mentions.length,
    parts,
    redFlags: [...new Set(redFlags)],
    score: clamp(round(score, 1), 0, 10)
  };
}

function scoreTiming(candidate, catalystScore) {
  const market = candidate.marketData || {};
  const parts = [];
  const missing = [];
  const redFlags = [];
  let score = 0;

  if (isFiniteNumber(market.price)) {
    score += 2;
    parts.push("precio disponible +2");
  } else {
    missing.push("precio live/local");
  }

  if (isFiniteNumber(market.relativeVolume) && market.relativeVolume >= MIN_RELATIVE_VOLUME) {
    score += 4;
    parts.push("RelVol confirma timing +4");
  } else if (isFiniteNumber(market.relativeVolume) && market.relativeVolume >= 0.5) {
    score += 2;
    parts.push("RelVol parcial +2");
  } else {
    redFlags.push("timing sin RelVol suficiente");
  }

  if (isFiniteNumber(market.dollarVolume) && market.dollarVolume >= MIN_DOLLAR_VOLUME) {
    score += 4;
    parts.push("dollar volume confirma timing +4");
  } else if (isFiniteNumber(market.dollarVolume) && market.dollarVolume >= 5000000) {
    score += 2;
    parts.push("dollar volume parcial +2");
  } else {
    redFlags.push("timing sin liquidez suficiente");
  }

  if (isFiniteNumber(market.dayChangePct)) {
    if (Math.abs(market.dayChangePct) <= 5) {
      score += 3;
      parts.push("no extendido/parabolico +3");
    } else if (market.dayChangePct > 12) {
      redFlags.push("posible estructura extendida/parabolica");
    }
  } else {
    missing.push("dayChangePct");
  }

  const triggerPassed = candidate.ticker === "VERA" &&
    candidate.dailyWatchlist &&
    catalystScore &&
    isFiniteNumber(candidate.marketData.price) &&
    candidate.marketData.price <= 34.5;
  if (triggerPassed) {
    score += 2;
    parts.push("precio dentro de trigger VERA +2");
  }

  return {
    missing,
    parts,
    redFlags,
    score: clamp(round(score, 1), 0, 15)
  };
}

function scoreRiskPenalty(candidate, componentScores, portfolioContext) {
  const text = getCandidateText(candidate).toLowerCase();
  const redFlags = [];
  const parts = [];
  let penalty = 0;
  const status = getMergedText(candidate, "status").toLowerCase();
  const setupRank = getMergedText(candidate, "setupRank").toLowerCase();
  const positionRow = portfolioContext.rows.find((row) => row.ticker === candidate.ticker);

  if (status === "descartar" || setupRank === "descartar") {
    penalty -= 8;
    redFlags.push("ticker descartado");
    parts.push("descartado -8");
  }

  if ((candidate.marketData.relativeVolume || 0) < 0.3) {
    penalty -= 3;
    redFlags.push("baja liquidez por RelVol");
    parts.push("RelVol muy bajo -3");
  }

  if ((candidate.marketData.dollarVolume || 0) < 5000000) {
    penalty -= 3;
    redFlags.push("dollar volume bajo");
    parts.push("dollar volume bajo -3");
  }

  if (
    positionRow &&
    isFiniteNumber(positionRow.pct) &&
    isFiniteNumber(portfolioContext.maxPositionPct) &&
    positionRow.pct >= portfolioContext.maxPositionPct * 0.8
  ) {
    penalty -= 4;
    redFlags.push("concentracion por ticker alta");
    parts.push("concentracion ticker -4");
  }

  if (
    isBiotechCatalyst(candidate.position || candidate.watchlist || {}) &&
    isFiniteNumber(portfolioContext.biotechPct) &&
    isFiniteNumber(portfolioContext.maxBiotechPct) &&
    portfolioContext.biotechPct >= portfolioContext.maxBiotechPct * 0.8
  ) {
    penalty -= 4;
    redFlags.push("concentracion biotech/catalyst alta");
    parts.push("concentracion biotech -4");
  }

  if (/pdufa|phase|readout|approval|fda/.test(text)) {
    penalty -= 3;
    redFlags.push("catalyst binario extremo");
    parts.push("catalyst binario -3");
  }

  if (/dilution|offering|convertible|crl|manufactur/.test(text)) {
    penalty -= 4;
    redFlags.push("dilucion/CRL/manufactura en tesis");
    parts.push("dilucion/CRL/manufactura -4");
  }

  if (componentScores.social.score > 0 && componentScores.catalyst.score < 8) {
    penalty -= 2;
    redFlags.push("social sin catalyst duro");
    parts.push("social sin catalyst duro -2");
  }

  if (isFiniteNumber(componentScores.catalyst.daysUntilCatalyst) && componentScores.catalyst.daysUntilCatalyst < 0) {
    penalty -= 4;
    redFlags.push("catalyst fechado ya vencido");
    parts.push("catalyst vencido -4");
  }

  return {
    parts,
    redFlags: [...new Set(redFlags)],
    score: clamp(round(penalty, 1), -20, 0)
  };
}

function isTriggerComplete(candidate, componentScores) {
  return Boolean(
    componentScores.catalyst.catalystDate &&
      isFiniteNumber(componentScores.catalyst.daysUntilCatalyst) &&
      componentScores.catalyst.daysUntilCatalyst >= 0 &&
      candidate.marketData.relativeVolume >= MIN_RELATIVE_VOLUME &&
      candidate.marketData.dollarVolume >= MIN_DOLLAR_VOLUME &&
      (!isFiniteNumber(candidate.marketData.dayChangePct) || candidate.marketData.dayChangePct <= MAX_A_PLUS_DAY_CHANGE_PCT) &&
      getMergedText(candidate, "status").toLowerCase() !== "descartar"
  );
}

function classify(totalScore, triggerComplete, forcedDiscard = false) {
  if (forcedDiscard) {
    return "discard";
  }

  if (totalScore >= 85 && triggerComplete) {
    return "A+ operable solo si trigger completo";
  }

  if (totalScore >= 70) {
    return "A candidate";
  }

  if (totalScore >= 50) {
    return "B watch";
  }

  if (totalScore >= 30) {
    return "C research";
  }

  return "discard";
}

function suggestAction(candidate, classification, triggerComplete) {
  const status = getMergedText(candidate, "status").toLowerCase();

  if (status === "descartar" || classification === "discard") {
    return "descartar";
  }

  if (candidate.inPortfolio) {
    return "mantener";
  }

  if (classification.startsWith("A+") && triggerComplete) {
    return "candidato_manual";
  }

  if (classification === "A candidate") {
    return "revisar_manual";
  }

  if (classification === "B watch" || classification === "C research") {
    return "vigilar";
  }

  return "no_operar";
}

function buildMainReason(candidate, componentScores, totalScore) {
  const bestPositive = [
    ["catalyst", componentScores.catalyst.score],
    ["liquidez", componentScores.volumeLiquidity.score],
    ["fit cartera", componentScores.portfolioFit.score],
    ["timing", componentScores.timing.score],
    ["social", componentScores.social.score]
  ].sort((left, right) => right[1] - left[1])[0];
  const worstFlags = [
    ...componentScores.riskPenalty.redFlags,
    ...componentScores.volumeLiquidity.redFlags,
    ...componentScores.portfolioFit.redFlags,
    ...componentScores.timing.redFlags
  ];

  if (totalScore < 30) {
    return worstFlags[0] || "score total insuficiente.";
  }

  if (bestPositive && bestPositive[1] > 0) {
    return `${bestPositive[0]} aporta el mayor peso, pero requiere revision manual.`;
  }

  return "faltan datos duros para priorizar.";
}

function buildMissingData(componentScores) {
  return [
    ...componentScores.catalyst.missing,
    ...componentScores.volumeLiquidity.missing,
    ...componentScores.portfolioFit.missing,
    ...componentScores.timing.missing
  ].filter(Boolean);
}

function evaluateCandidate(candidate, context) {
  const catalyst = scoreCatalyst(candidate, context.currentDate);
  const volumeLiquidity = scoreVolumeLiquidity(candidate);
  const portfolioFit = scorePortfolioFit(candidate, context.portfolio);
  const social = scoreSocial(candidate);
  const timing = scoreTiming(candidate, catalyst);
  const riskPenalty = scoreRiskPenalty(candidate, {
    catalyst,
    portfolioFit,
    social,
    timing,
    volumeLiquidity
  }, context.portfolio);
  const totalScore = clamp(round(
    catalyst.score +
      volumeLiquidity.score +
      portfolioFit.score +
      social.score +
      timing.score +
      riskPenalty.score,
    1
  ), 0, 100);
  const forcedDiscard = ["descartar", "discard"].includes(getMergedText(candidate, "status").toLowerCase()) ||
    ["descartar", "discard"].includes(getMergedText(candidate, "setupRank").toLowerCase());
  const triggerComplete = isTriggerComplete(candidate, {
    catalyst,
    portfolioFit,
    riskPenalty,
    social,
    timing,
    volumeLiquidity
  });
  const classification = classify(totalScore, triggerComplete, forcedDiscard);
  const suggestedAction = suggestAction(candidate, classification, triggerComplete);

  if (!ALLOWED_ACTIONS.has(suggestedAction)) {
    throw new Error(`Accion sugerida no permitida para ${candidate.ticker}: ${suggestedAction}`);
  }

  const redFlags = [
    ...volumeLiquidity.redFlags,
    ...portfolioFit.redFlags,
    ...social.redFlags,
    ...timing.redFlags,
    ...riskPenalty.redFlags
  ].filter(Boolean);
  const missingData = buildMissingData({
    catalyst,
    portfolioFit,
    timing,
    volumeLiquidity
  });

  return {
    actionSuggested: suggestedAction,
    classification,
    components: {
      catalystScore: catalyst.score,
      portfolioFitScore: portfolioFit.score,
      riskPenalty: riskPenalty.score,
      socialScore: social.score,
      timingScore: timing.score,
      volumeLiquidityScore: volumeLiquidity.score
    },
    context: {
      catalystDate: catalyst.catalystDate,
      catalystKind: catalyst.kind,
      daysUntilCatalyst: catalyst.daysUntilCatalyst,
      inPortfolio: candidate.inPortfolio,
      inWatchlist: candidate.inWatchlist,
      positionPct: portfolioFit.positionPct,
      socialMentions: social.mentionsCount
    },
    mainReason: buildMainReason(candidate, {
      catalyst,
      portfolioFit,
      riskPenalty,
      social,
      timing,
      volumeLiquidity
    }, totalScore),
    marketData: candidate.marketData,
    missingData: [...new Set(missingData)],
    redFlags: [...new Set(redFlags)],
    scoreParts: {
      catalyst: catalyst.parts,
      riskPenalty: riskPenalty.parts,
      social: social.parts,
      timing: timing.parts,
      volumeLiquidity: volumeLiquidity.parts
    },
    ticker: candidate.ticker,
    totalScore,
    triggerComplete
  };
}

function renderRankingTable(ranked) {
  const lines = [
    "| Rank | Ticker | Score | Componentes | Clasificacion | Accion | Origen | Razon principal | Red flags | Falta |",
    "|---:|---|---:|---|---|---|---|---|---|---|"
  ];

  ranked.forEach((item, index) => {
    const origin = [
      item.context.inPortfolio ? "cartera" : null,
      item.context.inWatchlist ? "watchlist" : null,
      item.context.socialMentions > 0 ? "social" : null
    ].filter(Boolean).join(", ") || "local";
    const components = [
      `Cat ${formatNumber(item.components.catalystScore)}/25`,
      `Vol ${formatNumber(item.components.volumeLiquidityScore)}/20`,
      `Fit ${formatNumber(item.components.portfolioFitScore)}/15`,
      `Risk ${formatNumber(item.components.riskPenalty)}`,
      `Soc ${formatNumber(item.components.socialScore)}/10`,
      `Tim ${formatNumber(item.components.timingScore)}/15`
    ].join("<br>");

    lines.push(`| ${index + 1} | ${item.ticker} | ${formatNumber(item.totalScore)} | ${components} | ${item.classification} | ${item.actionSuggested} | ${origin} | ${item.mainReason} | ${item.redFlags.join("; ") || "ninguna"} | ${item.missingData.join("; ") || "ninguno"} |`);
  });

  return lines.join("\n");
}

function renderFuturePhaseDocs() {
  return [
    "## Documentacion interna: fases futuras",
    "",
    "### Catalyst Engine",
    "- Falta normalizar feeds verificables por ticker, tipo, fecha exacta, fuente primaria y confianza.",
    "- Falta separar PDUFA, phase readout, earnings, insider y M&A sin depender de texto libre.",
    "- Falta invalidar catalysts vencidos o degradados con historial auditable.",
    "",
    "### Timing Engine",
    "- Falta timing intradia real con VWAP, apertura, rango, volumen por intervalo y extension/parabolicidad.",
    "- Falta distinguir acumulacion sana de chase tardio.",
    "- Falta persistir triggers por ticker sin generar ordenes.",
    "",
    "### Sizing Engine",
    "- Falta sizing manual sugerido por riesgo, cash, concentracion, liquidez y distancia a invalidacion.",
    "- Falta bloquear aumentos si el portfolio ya esta saturado en biotech/catalyst.",
    "- Falta convertir score en rango de revision, nunca en orden automatica.",
    "",
    "### Train/Test Split Engine",
    "- Falta separar historico en train/test temporal para calibrar pesos sin sobreajuste.",
    "- Falta congelar reglas antes de medir resultados fuera de muestra.",
    "- Falta comparar contra baseline simple de watchlist/ranking actual.",
    "",
    "### Post-mortem Engine",
    "- Falta conectar outcomes resueltos con el score que existia al momento de la decision.",
    "- Falta explicar falsos positivos, falsos negativos, drawdown y tiempo al peak.",
    "- Falta ajustar pesos solo despues de evidencia suficiente."
  ].join("\n");
}

function renderSummary(result) {
  const lines = [];

  lines.push("# WALY Selector Engine v1");
  lines.push("");
  lines.push(`Generado: ${result.generatedAt}`);
  lines.push(`Fecha local: ${result.currentDate}`);
  lines.push("Modo: read-only local. Selector Engine no opera, solo prioriza revision.");
  lines.push("");
  lines.push("## Ranking final de tickers");
  lines.push(renderRankingTable(result.ranking));
  lines.push("");
  lines.push("## Top 5");
  result.top5.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.ticker}: ${formatNumber(item.totalScore)} | ${item.classification} | ${item.actionSuggested}`);
  });
  if (result.top5.length === 0) {
    lines.push("- Sin tickers evaluados.");
  }
  lines.push("");
  lines.push("## A+");
  lines.push(result.hasAPlus ? "- Hay A+ con trigger completo." : "- No hay A+; ningun ticker cumple score y trigger completo.");
  lines.push("");
  lines.push("## Confirmaciones");
  result.confirmations.forEach((item) => lines.push(`- ${item}`));
  lines.push("");
  lines.push(renderFuturePhaseDocs());
  lines.push("");
  lines.push("## Advertencia");
  lines.push("- Selector Engine no opera, no compra, no vende, no ejecuta y no prepara ordenes.");
  lines.push("- social = discovery; data = conviction.");

  return `${lines.join("\n")}\n`;
}

function renderConsoleReport(result) {
  const top = result.top5.map((item) => `${item.ticker}:${formatNumber(item.totalScore)}:${item.classification}`);

  return [
    "WALY Selector Engine v1 generado.",
    `Tickers evaluados: ${result.ranking.length}`,
    `Top 5: ${top.length ? top.join(" | ") : "ninguno"}`,
    `A+: ${result.hasAPlus ? "si" : "no"}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no commit, no push."
  ].join("\n");
}

function runSelectorEngine() {
  const inputs = readInputs();
  const currentDate = getCurrentDateInTimezone(inputs.settings.timezone);
  const socialIndex = buildSocialIndex(inputs.socialRadar, inputs.socialInbox, inputs.socialSources);
  const portfolio = buildPortfolioContext(inputs.settings, inputs.positions);
  const candidates = buildUniverse(inputs, socialIndex);
  const ranking = candidates
    .map((candidate) => evaluateCandidate(candidate, { currentDate, portfolio }))
    .sort((left, right) =>
      right.totalScore - left.totalScore ||
      left.ticker.localeCompare(right.ticker)
    );
  const top5 = ranking.slice(0, 5);
  const hasAPlus = ranking.some((item) => item.classification.startsWith("A+"));
  const generatedAt = new Date().toISOString();
  const result = {
    actionsAllowed: [...ALLOWED_ACTIONS],
    confirmations: [
      "No ejecuta ordenes.",
      "No usa IBKR.",
      "No usa Binance.",
      "No toca positions manualmente.",
      "No toca outcomes.",
      "No modifica data/social_signals.json.",
      "Solo escribe en backtests/selector-engine/.",
      "No hace commit.",
      "No hace push."
    ],
    currentDate,
    generatedAt,
    hasAPlus,
    inputs: {
      dailyCockpitPath: inputs.dailyCockpit ? formatRelative(DAILY_COCKPIT_PATH) : null,
      positionsPath: formatRelative(POSITIONS_PATH),
      socialInboxPath: inputs.socialInbox ? formatRelative(SOCIAL_INBOX_PATH) : null,
      socialRadarPath: inputs.socialRadar ? formatRelative(SOCIAL_RADAR_PATH) : null,
      socialSourcesPath: inputs.socialSources ? formatRelative(SOCIAL_SOURCES_PATH) : null,
      watchlistPath: formatRelative(WATCHLIST_PATH)
    },
    mode: "read-only-local",
    notes: [
      "Master Score v1 es inicial y auditable, no definitivo.",
      "Catalyst Engine, Timing Engine, Sizing Engine, Train/Test y Post-mortem quedan documentados como fases futuras.",
      "Ninguna accion sugerida equivale a buy/sell/auto_execute."
    ],
    paths: {
      latestPath: LATEST_PATH,
      outputDir: OUTPUT_DIR,
      summaryPath: SUMMARY_PATH
    },
    portfolioContext: {
      biotechPct: round(portfolio.biotechPct, 2),
      cash: portfolio.cash,
      maxBiotechPct: portfolio.maxBiotechPct,
      maxPositionPct: portfolio.maxPositionPct,
      totalCapital: portfolio.totalCapital
    },
    ranking,
    scoringModel: {
      catalystScoreMax: 25,
      portfolioFitScoreMax: 15,
      riskPenaltyMin: -20,
      socialScoreMax: 10,
      timingScoreMax: 15,
      totalScoreMax: 100,
      volumeLiquidityScoreMax: 20
    },
    top5
  };
  const summaryMarkdown = renderSummary(result);

  writeJson(LATEST_PATH, result);
  writeText(SUMMARY_PATH, summaryMarkdown);

  return {
    ...result,
    consoleReport: renderConsoleReport(result),
    summaryMarkdown
  };
}

module.exports = {
  runSelectorEngine
};
