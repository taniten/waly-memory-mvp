"use strict";

const { requestText } = require("./http");

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const cleaned = String(value || "")
    .replace(/[$,%]/g, "")
    .replace(/,/g, "")
    .trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMagnitude(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);

  if (!match) {
    return toNumber(text);
  }

  const number = Number(match[1]);
  const suffix = (match[2] || "").toUpperCase();
  const multipliers = {
    K: 1e3,
    M: 1e6,
    B: 1e9,
    T: 1e12
  };

  return number * (multipliers[suffix] || 1);
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

  if (absoluteChange >= 20) {
    return 5;
  }

  if (absoluteChange >= 12) {
    return 4;
  }

  if (absoluteChange >= 7) {
    return 3;
  }

  if (absoluteChange >= 3) {
    return 2;
  }

  return 1;
}

function deriveBreakoutReadiness(dayChangePct, screenKind) {
  let score = 1;

  if (Math.abs(dayChangePct || 0) >= 4) {
    score += 1;
  }

  if (screenKind === "gap-momentum") {
    score += 2;
  }

  if (screenKind === "high-short-interest") {
    score += 1;
  }

  return Math.max(1, Math.min(score, 5));
}

function deriveCrowdingRisk(screenKind) {
  if (screenKind === "high-short-interest") {
    return 4;
  }

  return 2;
}

function deriveSocialDiscoveryScore(screenKind) {
  if (screenKind === "high-short-interest") {
    return 3;
  }

  if (screenKind === "relative-volume") {
    return 2;
  }

  return 2.5;
}

function deriveReratingPotential(screenKind) {
  if (screenKind === "high-short-interest") {
    return 3;
  }

  if (screenKind === "gap-momentum") {
    return 4;
  }

  return 3;
}

function inferScreenKind(savedScreen = {}) {
  if (savedScreen.kind) {
    return savedScreen.kind;
  }

  const url = String(savedScreen.url || "");

  if (url.includes("sh_short_o20")) {
    return "high-short-interest";
  }

  if (url.includes("ta_gap_")) {
    return "gap-momentum";
  }

  return "relative-volume";
}

function extractRows(html) {
  const rowMatches = html.match(/<tr class="styled-row[\s\S]*?<\/tr>/g) || [];

  return rowMatches
    .map((row) => {
      const tickerMatch = row.match(/data-boxover-ticker="([^"]+)"/);
      const cellMatches = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) => stripTags(match[1]));

      if (!tickerMatch || cellMatches.length < 6) {
        return null;
      }

      return {
        cells: cellMatches,
        ticker: tickerMatch[1].trim().toUpperCase()
      };
    })
    .filter(Boolean);
}

function toCandidate(row, savedScreen) {
  const screenKind = inferScreenKind(savedScreen);
  const cells = row.cells;
  const companyName = cells[2] || "";
  const sector = cells[3] || "";
  const industry = cells[4] || "";
  const country = cells[5] || "";
  const marketCap = parseMagnitude(cells[6]);
  const price = toNumber(cells[cells.length - 3]);
  const dayChangePct = toNumber(cells[cells.length - 2]);
  const volume = parseMagnitude(cells[cells.length - 1]);
  const dollarVolume = price && volume ? price * volume : 0;

  return {
    breakoutReadiness: deriveBreakoutReadiness(dayChangePct, screenKind),
    companyName,
    country,
    crowdingRisk: deriveCrowdingRisk(screenKind),
    dayChangePct: dayChangePct || 0,
    discoveryReasons: [
      `Finviz screen: ${savedScreen.name || screenKind}.`,
      industry ? `Industria: ${industry}.` : ""
    ].filter(Boolean),
    dollarVolume,
    industry,
    lastPrice: price,
    liquidityQuality: deriveLiquidityQuality(dollarVolume),
    marketCap,
    momentumQuality: deriveMomentumQuality(dayChangePct),
    reratingPotential: deriveReratingPotential(screenKind),
    screenKind,
    sector,
    socialDiscoveryScore: deriveSocialDiscoveryScore(screenKind),
    sourceTags: ["finviz", screenKind],
    ticker: row.ticker,
    volume
  };
}

async function fetchSavedFinvizScreens(config) {
  if (!config || !config.enabled) {
    return {
      candidates: [],
      status: "disabled"
    };
  }

  const savedScreens = Array.isArray(config.savedScreens) ? config.savedScreens : [];

  if (savedScreens.length === 0) {
    return {
      candidates: [],
      message: "No hay savedScreens de Finviz configurados.",
      status: "empty"
    };
  }

  const aggregated = [];

  for (const savedScreen of savedScreens) {
    if (!savedScreen.url) {
      continue;
    }

    const response = await requestText(savedScreen.url, {
      headers: {
        "User-Agent": config.userAgent || "Mozilla/5.0",
        ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {})
      },
      timeoutMs: config.timeoutMs || 20000
    });
    const rows = extractRows(response.body);
    const candidates = rows.map((row) => toCandidate(row, savedScreen));

    candidates.forEach((candidate) => {
      candidate.discoveryReasons.push(`Filtro URL: ${savedScreen.url}`);
      aggregated.push(candidate);
    });
  }

  return {
    candidates: aggregated,
    status: "ok"
  };
}

module.exports = {
  fetchSavedFinvizScreens
};
