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
  const cleaned = String(value || "")
    .replace(/[$,%]/g, "")
    .replace(/,/g, "")
    .trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractTickerCells(html) {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];

  return rows
    .map((row) => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) => stripTags(match[1])))
    .filter((cells) => cells.length >= 12)
    .filter((cells) => /^[A-Z.\-]{1,10}$/.test(cells[3] || ""));
}

function inferScreenKind(savedScreen = {}) {
  if (savedScreen.kind) {
    return savedScreen.kind;
  }

  const url = String(savedScreen.url || "");

  if (url.includes("isceo=1") && url.includes("fd=7")) {
    return "ceo-buying";
  }

  return "broad-insider-buying";
}

function toCandidate(cells, savedScreen) {
  const screenKind = inferScreenKind(savedScreen);
  const ticker = String(cells[3] || "").trim().toUpperCase();
  const companyName = cells[4] || "";
  const tradeDate = cells[2] || "";
  const price = toNumber(cells[8]);
  const qty = toNumber(cells[9]);
  const value = toNumber(cells[10]);

  return {
    catalystDate: /^\d{4}-\d{2}-\d{2}$/.test(tradeDate) ? tradeDate : null,
    catalystStrength: screenKind === "ceo-buying" ? 4 : 3,
    catalystType: "insider",
    companyName,
    crowdingRisk: 2,
    discoveryReasons: [
      `OpenInsider screen: ${savedScreen.name || screenKind}.`,
      value ? `Compra insider por USD ${Math.round(value).toLocaleString("en-US")}.` : ""
    ].filter(Boolean),
    insiderSupport: screenKind === "ceo-buying" ? 4 : 3,
    lastPrice: price,
    liquidityQuality: value && value >= 1000000 ? 3 : 2,
    notes: `${screenKind} detectado en OpenInsider.`,
    reratingPotential: screenKind === "ceo-buying" ? 3 : 2,
    screenKind,
    socialDiscoveryScore: 1,
    sourceTags: ["openinsider", screenKind],
    ticker,
    tradeValue: value,
    volumeHint: qty
  };
}

async function fetchSavedOpenInsiderScreens(config) {
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
      message: "No hay savedScreens de OpenInsider configurados.",
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
        "User-Agent": config.userAgent || "Mozilla/5.0"
      },
      timeoutMs: config.timeoutMs || 20000
    });
    const rows = extractTickerCells(response.body);

    rows.forEach((cells) => {
      const candidate = toCandidate(cells, savedScreen);
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
  fetchSavedOpenInsiderScreens
};
