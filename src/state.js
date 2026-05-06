"use strict";

const fs = require("fs");
const path = require("path");
const { compareState, createStateSnapshot } = require("./compareState");
const { analyzeDecisionState } = require("./decisionEngine");
const { analyzeOutcomes } = require("./outcomeEngine");
const { readJson, writeJson } = require("./storage");
const {
  assertValid,
  mergeValidationResults,
  validateCatalystFeed,
  validateIncomingLogEntry,
  validateLog,
  validateOutcomes,
  validatePositions,
  validateSettings,
  validateSocialSignalFeed,
  validateStateConsistency,
  validateWatchlist
} = require("./validators");

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

function loadState() {
  const settings = readJson("settings.json");
  const currentDate = getCurrentDateInTimezone(settings.timezone);
  const earnings = readJson("earnings.json");
  const insiders = readJson("insiders.json");
  const fda = readJson("fda.json");
  const outcomes = readJson("outcomes.json");
  const socialSignals = readJson("social_signals.json");
  const positions = readJson("positions.json");
  const watchlist = readJson("watchlist.json");
  const dailyLog = readJson("daily_log.json");

  const validation = mergeValidationResults(
    validateSettings(settings),
    validateCatalystFeed(earnings, { expectedType: "earnings", fileName: "earnings.json" }),
    validateCatalystFeed(insiders, { expectedType: "insider", fileName: "insiders.json" }),
    validateCatalystFeed(fda, { expectedType: "fda", fileName: "fda.json" }),
    validateOutcomes(outcomes, { currentDate, fileName: "outcomes.json" }),
    validateSocialSignalFeed(socialSignals, { fileName: "social_signals.json" }),
    validatePositions(positions, { currentDate }),
    validateWatchlist(watchlist, { currentDate }),
    validateLog(dailyLog, settings.maxNewOpportunities || 3, { currentDate }),
    validateStateConsistency({ positions, watchlist })
  );

  assertValid(validation);

  return {
    currentDate,
    dailyLog,
    ingestion: {
      earnings,
      fda,
      insiders
    },
    outcomes,
    positions,
    socialSignals,
    settings,
    validation,
    watchlist
  };
}

function getLatestEntry(entries) {
  if (!entries.length) {
    return null;
  }

  return [...entries].sort((left, right) => right.date.localeCompare(left.date))[0];
}

function getPreviousEntry(entries) {
  if (entries.length < 2) {
    return null;
  }

  return [...entries].sort((left, right) => right.date.localeCompare(left.date))[1];
}

function dedupeIssues(issues) {
  const seen = new Set();

  return issues.filter((issue) => {
    const key = [
      issue.code || issue.type || "",
      issue.ticker || "",
      issue.source || ""
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function summarizeState(state) {
  const latestEntry = getLatestEntry(state.dailyLog.entries);
  const previousEntry = getPreviousEntry(state.dailyLog.entries);
  const prioritizedWatchlist = [...state.watchlist.watchlist].sort(
    (left, right) => left.priority - right.priority
  );
  const comparison = compareState(state);
  const decision = analyzeDecisionState(state, comparison);
  const outcomesSummary = analyzeOutcomes(state);
  const alerts = dedupeIssues([...(state.validation.warnings || []), ...(decision.flags || [])]);

  return {
    activeCatalysts: decision.eventState.activeCatalysts,
    alerts,
    comparison,
    conflicts: dedupeIssues(decision.conflicts || []),
    crowdingWarnings: dedupeIssues(decision.crowdingWarnings || []),
    decision,
    eventIngestion: decision.eventState.ingestion,
    finalOpportunities: decision.ranking.finalOpportunities,
    latestEntry,
    openPositions: state.positions.positions,
    outcomesSummary,
    overdueReviews: dedupeIssues(decision.overdueReviews || []),
    previousEntry,
    prioritizedWatchlist,
    socialRelevantSignals: decision.eventState.social.relevantSignals,
    validation: state.validation
  };
}

function readExternalJson(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function replacePositions(filePath) {
  const settings = readJson("settings.json");
  const currentDate = getCurrentDateInTimezone(settings.timezone);
  const incoming = readExternalJson(filePath);
  const validation = validatePositions(incoming, { currentDate });

  assertValid(validation);
  incoming.updatedAt = new Date().toISOString();
  writeJson("positions.json", incoming);
  return incoming;
}

function replaceWatchlist(filePath) {
  const settings = readJson("settings.json");
  const currentDate = getCurrentDateInTimezone(settings.timezone);
  const incoming = readExternalJson(filePath);
  const validation = validateWatchlist(incoming, { currentDate });

  assertValid(validation);
  incoming.updatedAt = new Date().toISOString();
  writeJson("watchlist.json", incoming);
  return incoming;
}

function addLogEntry(filePath) {
  const state = loadState();
  const nextEntry = readExternalJson(filePath);
  const entryWithSnapshot = {
    ...nextEntry,
    stateSnapshot: nextEntry.stateSnapshot || createStateSnapshot(state)
  };
  const entryValidation = validateIncomingLogEntry(entryWithSnapshot, {
    currentDate: state.currentDate,
    existingPositions: state.positions.positions,
    existingWatchlist: state.watchlist.watchlist,
    maxNewOpportunities: state.settings.maxNewOpportunities || 3
  });

  assertValid(entryValidation);

  const nextLog = {
    updatedAt: new Date().toISOString(),
    entries: [...state.dailyLog.entries, entryWithSnapshot]
  };
  const logValidation = validateLog(nextLog, state.settings.maxNewOpportunities || 3, {
    currentDate: state.currentDate
  });

  assertValid(logValidation);
  writeJson("daily_log.json", nextLog);
  return entryWithSnapshot;
}

module.exports = {
  addLogEntry,
  getCurrentDateInTimezone,
  getLatestEntry,
  getPreviousEntry,
  loadState,
  replacePositions,
  replaceWatchlist,
  summarizeState
};
