"use strict";

const { requestJson } = require("./http");

function clampScore(value, min = 0, max = 5) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(min, Math.min(max, value));
}

function deriveLiquidityQuality(dollarVolume) {
  if (dollarVolume >= 250000000) {
    return 5;
  }

  if (dollarVolume >= 100000000) {
    return 4;
  }

  if (dollarVolume >= 30000000) {
    return 3;
  }

  if (dollarVolume >= 10000000) {
    return 2;
  }

  return 1;
}

function deriveMomentumQuality(dayChangePct) {
  const absoluteChange = Math.abs(dayChangePct || 0);

  if (absoluteChange >= 12) {
    return 5;
  }

  if (absoluteChange >= 8) {
    return 4;
  }

  if (absoluteChange >= 5) {
    return 3;
  }

  if (absoluteChange >= 2) {
    return 2;
  }

  return 1;
}

function deriveBreakoutReadiness(dayChangePct, relativeVolume, gapPct) {
  let score = 1;

  if ((dayChangePct || 0) >= 4) {
    score += 1;
  }

  if ((relativeVolume || 0) >= 1.5) {
    score += 1;
  }

  if ((gapPct || 0) >= 3) {
    score += 1;
  }

  if ((dayChangePct || 0) >= 8 && (relativeVolume || 0) >= 2) {
    score += 1;
  }

  return clampScore(score);
}

function toSnapshotCandidate(snapshot) {
  const day = snapshot.day || {};
  const prevDay = snapshot.prevDay || {};
  const lastPrice =
    (typeof day.c === "number" && Number.isFinite(day.c) && day.c) ||
    (snapshot.lastTrade && snapshot.lastTrade.p) ||
    null;
  const open = typeof day.o === "number" ? day.o : null;
  const prevClose = typeof prevDay.c === "number" ? prevDay.c : null;
  const volume = typeof day.v === "number" ? day.v : 0;
  const prevVolume = typeof prevDay.v === "number" ? prevDay.v : 0;
  const dayChangePct =
    typeof snapshot.todaysChangePerc === "number"
      ? snapshot.todaysChangePerc
      : lastPrice && prevClose
        ? ((lastPrice - prevClose) / prevClose) * 100
        : 0;
  const gapPct = open && prevClose ? ((open - prevClose) / prevClose) * 100 : 0;
  const relativeVolume = prevVolume > 0 ? volume / prevVolume : 0;
  const dollarVolume = lastPrice && volume ? lastPrice * volume : 0;
  const liquidityQuality = deriveLiquidityQuality(dollarVolume);
  const momentumQuality = deriveMomentumQuality(dayChangePct);
  const breakoutReadiness = deriveBreakoutReadiness(dayChangePct, relativeVolume, gapPct);

  return {
    breakoutReadiness,
    companyName: snapshot.name || "",
    dayChangePct: Number(dayChangePct.toFixed(2)),
    dollarVolume: Number(dollarVolume.toFixed(2)),
    gapPct: Number(gapPct.toFixed(2)),
    lastPrice: lastPrice ? Number(lastPrice.toFixed(2)) : null,
    liquidityQuality,
    momentumQuality,
    relativeVolume: Number(relativeVolume.toFixed(2)),
    sourceTags: ["polygon"],
    ticker: snapshot.ticker,
    volume
  };
}

function shouldKeepCandidate(candidate, filters = {}) {
  const minPrice = filters.minPrice || 2;
  const minDollarVolume = filters.minDollarVolume || 10000000;
  const minRelativeVolume = filters.minRelativeVolume || 1.25;
  const minAbsoluteDayChangePct = filters.minAbsoluteDayChangePct || 4;

  return (
    typeof candidate.lastPrice === "number" &&
    candidate.lastPrice >= minPrice &&
    candidate.dollarVolume >= minDollarVolume &&
    (
      Math.abs(candidate.dayChangePct) >= minAbsoluteDayChangePct ||
      candidate.relativeVolume >= minRelativeVolume ||
      Math.abs(candidate.gapPct) >= minAbsoluteDayChangePct
    )
  );
}

async function fetchMarketSnapshotCandidates(config, filters, seedTickers = []) {
  if (!config || !config.enabled) {
    return {
      candidates: [],
      status: "disabled"
    };
  }

  if (!config.apiKey) {
    return {
      candidates: [],
      message: "POLYGON_API_KEY no configurado.",
      status: "missing-api-key"
    };
  }

  const query = {
    apiKey: config.apiKey
  };

  if (config.seedMode === "seed-tickers" && seedTickers.length > 0) {
    query.tickers = seedTickers.join(",");
  }

  const response = await requestJson(`${config.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers`, {
    query,
    timeoutMs: config.timeoutMs || 20000
  });
  const snapshots = Array.isArray(response.json.tickers) ? response.json.tickers : [];
  const candidates = snapshots
    .map(toSnapshotCandidate)
    .filter((candidate) => candidate.ticker)
    .filter((candidate) => shouldKeepCandidate(candidate, filters))
    .sort((left, right) => {
      if (left.breakoutReadiness !== right.breakoutReadiness) {
        return right.breakoutReadiness - left.breakoutReadiness;
      }

      if (left.relativeVolume !== right.relativeVolume) {
        return right.relativeVolume - left.relativeVolume;
      }

      return right.dollarVolume - left.dollarVolume;
    })
    .slice(0, config.marketSnapshotLimit || 50);

  return {
    candidates,
    rawCount: snapshots.length,
    status: "ok"
  };
}

function normalizeEarningsRecord(record) {
  const importance = typeof record.importance === "number" ? record.importance : 0;

  return {
    catalystDate: record.date || null,
    catalystType: "earnings",
    metadata: {
      dateStatus: record.date_status || null,
      estimatedEps: record.estimated_eps || null,
      estimatedRevenue: record.estimated_revenue || null,
      importance
    },
    notes: `Polygon earnings calendar | importance ${importance} | ${record.date_status || "status n/d"}`,
    source: "Polygon Benzinga Earnings API",
    ticker: record.ticker
  };
}

async function fetchEarningsCatalysts(config, options = {}) {
  if (!config || !config.enabled) {
    return {
      catalysts: [],
      status: "disabled"
    };
  }

  if (!config.apiKey) {
    return {
      catalysts: [],
      message: "POLYGON_API_KEY no configurado para earnings.",
      status: "missing-api-key"
    };
  }

  const query = {
    apiKey: config.apiKey,
    limit: options.limit || 250,
    sort: "date.asc"
  };

  if (options.date) {
    query.date = options.date;
  }

  if (options.ticker) {
    query.ticker = options.ticker;
  }

  const response = await requestJson(`${config.baseUrl}/benzinga/v1/earnings`, {
    query,
    timeoutMs: config.timeoutMs || 20000
  });
  const results = Array.isArray(response.json.results) ? response.json.results : [];

  return {
    catalysts: results.map(normalizeEarningsRecord).filter((item) => item.ticker),
    status: "ok"
  };
}

module.exports = {
  fetchEarningsCatalysts,
  fetchMarketSnapshotCandidates
};
