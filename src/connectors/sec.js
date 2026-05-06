"use strict";

const { requestJson } = require("./http");

function normalizeTicker(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(config) {
  return {
    "User-Agent": config.userAgent || "WALY Outlier Hunt/1.3 research@local.dev",
    Accept: "application/json"
  };
}

async function fetchTickerMap(config) {
  const response = await requestJson(config.tickerMapUrl, {
    headers: buildHeaders(config),
    timeoutMs: config.timeoutMs || 20000
  });
  const data = response.json;

  if (!Array.isArray(data.data) || !Array.isArray(data.fields)) {
    return new Map();
  }

  const fieldIndex = Object.fromEntries(data.fields.map((field, index) => [field, index]));
  const map = new Map();

  data.data.forEach((row) => {
    const ticker = normalizeTicker(row[fieldIndex.ticker]);

    if (!ticker) {
      return;
    }

    map.set(ticker, {
      cik: String(row[fieldIndex.cik] || "").padStart(10, "0"),
      companyName: row[fieldIndex.name] || "",
      exchange: row[fieldIndex.exchange] || ""
    });
  });

  return map;
}

function extractRecentForms(submissions, options = {}) {
  const { formTypes = ["4", "4/A"], lookbackDate } = options;
  const recent = submissions && submissions.filings && submissions.filings.recent;

  if (!recent || !Array.isArray(recent.form)) {
    return [];
  }

  const results = [];

  for (let index = 0; index < recent.form.length; index += 1) {
    const form = recent.form[index];
    const filingDate = recent.filingDate && recent.filingDate[index];

    if (!formTypes.includes(form)) {
      continue;
    }

    if (lookbackDate && typeof filingDate === "string" && filingDate < lookbackDate) {
      continue;
    }

    results.push({
      accessionNumber: recent.accessionNumber && recent.accessionNumber[index],
      filingDate,
      form,
      primaryDocDescription: recent.primaryDocDescription && recent.primaryDocDescription[index]
    });
  }

  return results;
}

async function fetchRecentInsiderCatalysts(config, tickers, options = {}) {
  if (!config || !config.enabled) {
    return {
      catalysts: [],
      status: "disabled"
    };
  }

  const tickerList = [...new Set(tickers.map(normalizeTicker).filter(Boolean))];

  if (tickerList.length === 0) {
    return {
      catalysts: [],
      status: "empty"
    };
  }

  const tickerMap = await fetchTickerMap(config);
  const catalysts = [];

  for (const ticker of tickerList.slice(0, config.maxTickersPerSync || 25)) {
    const company = tickerMap.get(ticker);

    if (!company || !company.cik) {
      continue;
    }

    const response = await requestJson(`${config.baseUrl}/submissions/CIK${company.cik}.json`, {
      headers: buildHeaders(config),
      timeoutMs: config.timeoutMs || 20000
    });
    const forms = extractRecentForms(response.json, {
      formTypes: config.formTypes || ["4", "4/A"],
      lookbackDate: options.lookbackDate
    });

    if (forms.length > 0) {
      const latestForm = forms[0];

      catalysts.push({
        catalystDate: latestForm.filingDate,
        catalystType: "insider",
        metadata: {
          accessionNumber: latestForm.accessionNumber || null,
          companyName: company.companyName,
          exchange: company.exchange,
          filingCount: forms.length,
          form: latestForm.form
        },
        notes: `SEC Form ${latestForm.form} reciente | ${company.companyName}`,
        source: "SEC EDGAR submissions API",
        ticker
      });
    }

    if (config.requestDelayMs) {
      await sleep(config.requestDelayMs);
    }
  }

  return {
    catalysts,
    status: "ok",
    tickerMap
  };
}

module.exports = {
  fetchRecentInsiderCatalysts,
  fetchTickerMap
};
