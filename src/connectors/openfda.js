"use strict";

const { requestJson } = require("./http");

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function buildSearchTerm(companyName, sponsorOverride) {
  if (typeof sponsorOverride === "string" && sponsorOverride.trim()) {
    return sponsorOverride.trim();
  }

  return companyName || "";
}

function looksLikeStrongSponsorMatch(companyName, sponsorName, sponsorOverride) {
  const left = normalizeText(buildSearchTerm(companyName, sponsorOverride));
  const right = normalizeText(sponsorName);

  if (!left || !right) {
    return false;
  }

  return right.includes(left) || left.includes(right);
}

function pickLatestSubmission(result) {
  const submissions = Array.isArray(result.submissions) ? result.submissions : [];

  return submissions
    .filter((submission) => typeof submission.submission_status_date === "string")
    .sort((left, right) => right.submission_status_date.localeCompare(left.submission_status_date))[0] || null;
}

async function fetchRecentFdaCatalysts(config, companies, options = {}) {
  if (!config || !config.enabled) {
    return {
      catalysts: [],
      status: "disabled"
    };
  }

  const catalysts = [];
  const lookbackDate = options.lookbackDate || null;

  for (const company of companies.slice(0, config.maxCompaniesPerSync || 20)) {
    const searchTerm = buildSearchTerm(company.companyName, company.sponsorName);

    if (!searchTerm) {
      continue;
    }

    const query = {
      limit: config.limitPerCompany || 5,
      search: `sponsor_name:"${searchTerm.replace(/"/g, "")}"`,
      sort: "submissions.submission_status_date:desc"
    };

    if (config.apiKey) {
      query.api_key = config.apiKey;
    }

    let response;

    try {
      response = await requestJson(`${config.baseUrl}/drug/drugsfda.json`, {
        query,
        timeoutMs: config.timeoutMs || 20000
      });
    } catch (error) {
      if (error && error.statusCode === 404) {
        continue;
      }

      throw error;
    }

    const results = Array.isArray(response.json.results) ? response.json.results : [];

    results.forEach((result) => {
      if (!looksLikeStrongSponsorMatch(company.companyName, result.sponsor_name, company.sponsorName)) {
        return;
      }

      const latestSubmission = pickLatestSubmission(result);

      if (!latestSubmission || (lookbackDate && latestSubmission.submission_status_date < lookbackDate)) {
        return;
      }

      catalysts.push({
        catalystDate: latestSubmission.submission_status_date,
        catalystType: "fda",
        metadata: {
          applicationNumber: result.application_number || null,
          productCount: Array.isArray(result.products) ? result.products.length : 0,
          sponsorName: result.sponsor_name || company.companyName,
          submissionStatus: latestSubmission.submission_status || null,
          submissionType: latestSubmission.submission_type || null
        },
        notes: `openFDA / Drugs@FDA | ${latestSubmission.submission_status || "submission reciente"}`,
        source: "openFDA Drugs@FDA API",
        ticker: company.ticker
      });
    });
  }

  const deduped = [];
  const seen = new Set();

  catalysts
    .sort((left, right) => right.catalystDate.localeCompare(left.catalystDate))
    .forEach((item) => {
      const key = `${item.ticker}|${item.catalystDate}|${item.metadata.applicationNumber || ""}`;

      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      deduped.push(item);
    });

  return {
    catalysts: deduped,
    status: "ok"
  };
}

module.exports = {
  fetchRecentFdaCatalysts
};
