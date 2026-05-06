"use strict";

const { analyzeEventState } = require("./eventEngine");
const { rankUniverse } = require("./rankingEngine");
const { SOURCE_PRIORITY } = require("./constants");
const { compareDateOnlyStrings, isNonEmptyString, normalizeTicker } = require("./validators");

function getLatestEntry(entries) {
  if (!entries.length) {
    return null;
  }

  return [...entries].sort((left, right) => right.date.localeCompare(left.date))[0];
}

function createFlag(type, severity, message, details = {}) {
  return {
    ...details,
    message,
    severity,
    type
  };
}

function dedupeFlags(flags) {
  const seen = new Set();

  return flags.filter((flag) => {
    const key = [flag.type, flag.ticker || "", flag.source || "", flag.message].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function buildPriorityQueue(positions, watchlist, opportunities) {
  const queue = [
    ...positions.map((item) => ({
      reason: "Posicion abierta: siempre va primero.",
      source: "position",
      sourcePriority: SOURCE_PRIORITY.position,
      status: item.status,
      ticker: normalizeTicker(item.ticker)
    })),
    ...watchlist.map((item) => ({
      priority: item.priority,
      reason: `Watchlist prioritaria: prioridad ${item.priority}.`,
      source: "watchlist",
      sourcePriority: SOURCE_PRIORITY.watchlist,
      status: item.status,
      ticker: normalizeTicker(item.ticker)
    })),
    ...opportunities.map((item) => ({
      reason: "Nueva oportunidad: se revisa despues de cartera y watchlist.",
      source: "opportunity",
      sourcePriority: SOURCE_PRIORITY.opportunity,
      status: item.status,
      ticker: normalizeTicker(item.ticker)
    }))
  ];

  return queue.sort((left, right) => {
    if (left.sourcePriority !== right.sourcePriority) {
      return left.sourcePriority - right.sourcePriority;
    }

    if ((left.priority || 0) !== (right.priority || 0)) {
      return (left.priority || Number.MAX_SAFE_INTEGER) - (right.priority || Number.MAX_SAFE_INTEGER);
    }

    return left.ticker.localeCompare(right.ticker);
  });
}

function entryMentionsTicker(entry, ticker) {
  if (!entry || !ticker) {
    return false;
  }

  const haystack = [
    entry.marketContext,
    entry.decision,
    entry.justification,
    ...(entry.portfolioChanges || []),
    ...(entry.watchlistChanges || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  return haystack.includes(ticker);
}

function buildFinalDecision(positions, ranking, crowdingWarnings) {
  const openTickers = positions.map((position) => normalizeTicker(position.ticker)).filter(Boolean);
  const finalCandidates = ranking.finalOpportunities;
  const portfolioSentence = openTickers.length
    ? `Cartera primero: ${openTickers.join(", ")} sigue delante de cualquier idea nueva.`
    : "Sin posiciones abiertas: WALY puede dedicar toda la atencion a cazar asimetrias nuevas.";
  const candidateSentence = finalCandidates.length
    ? `Solo ${finalCandidates.map((item) => `${item.ticker} (${item.setupRank})`).join(", ")} merecen capital especulativo hoy.`
    : "No hay outlier real hoy. No fuerces trades por FOMO ni por narrativa.";
  const disciplineSentence =
    "Social sirve para descubrir antes; si no hay catalyst, precio, volumen, liquidez y downside claros, no hay conviccion.";
  const crowdedTickers = Array.from(new Set(crowdingWarnings.map((warning) => warning.ticker).filter(Boolean)));
  const crowdingSentence = crowdingWarnings.length
    ? `Hay crowding en ${crowdedTickers.join(", ")}: no persigas extension.`
    : "No hay crowding extremo dominando el radar actual.";

  return `${portfolioSentence} ${candidateSentence} ${disciplineSentence} ${crowdingSentence}`.trim();
}

function analyzeDecisionState(state, comparison) {
  const positions = state.positions.positions || [];
  const watchlist = state.watchlist.watchlist || [];
  const latestEntry = getLatestEntry(state.dailyLog.entries || []);
  const opportunities = latestEntry ? latestEntry.newOpportunities || [] : [];
  const eventState = analyzeEventState(state);
  const ranking = rankUniverse(eventState, state.settings.maxNewOpportunities || 3);
  const flags = [];
  const conflicts = [];
  const overdueReviews = [];
  const positionsByTicker = new Map();

  positions.forEach((position) => {
    const ticker = normalizeTicker(position.ticker);

    if (ticker) {
      positionsByTicker.set(ticker, position);
    }

    if (
      (position.status === "mantener" || position.status === "observar") &&
      !isNonEmptyString(position.invalidation)
    ) {
      flags.push(
        createFlag(
          "missingInvalidation",
          "warning",
          `${ticker} no tiene invalidation a pesar de estar en ${position.status}.`,
          { source: "position", ticker }
        )
      );
    }

    if (isNonEmptyString(position.nextReviewAt) && compareDateOnlyStrings(position.nextReviewAt, state.currentDate) < 0) {
      const flag = createFlag(
        "overdueReview",
        "warning",
        `${ticker} tiene nextReviewAt vencido (${position.nextReviewAt}).`,
        { source: "position", ticker }
      );
      flags.push(flag);
      overdueReviews.push(flag);
    }
  });

  watchlist.forEach((item) => {
    const ticker = normalizeTicker(item.ticker);

    if (positionsByTicker.has(ticker)) {
      const duplicatedFlag = createFlag(
        "duplicatedTicker",
        "warning",
        `${ticker} aparece tanto en posiciones como en watchlist.`,
        { source: "watchlist", ticker }
      );

      flags.push(duplicatedFlag);
      conflicts.push(duplicatedFlag);

      if (positionsByTicker.get(ticker).status !== item.status) {
        const statusFlag = createFlag(
          "conflictingStatus",
          "warning",
          `${ticker} tiene status conflictivo entre posiciones (${positionsByTicker.get(ticker).status}) y watchlist (${item.status}).`,
          { source: "watchlist", ticker }
        );
        flags.push(statusFlag);
        conflicts.push(statusFlag);
      }
    }

    if ((item.status === "mantener" || item.status === "observar") && !isNonEmptyString(item.invalidation)) {
      flags.push(
        createFlag(
          "missingInvalidation",
          "warning",
          `${ticker} no tiene invalidation a pesar de estar en ${item.status}.`,
          { source: "watchlist", ticker }
        )
      );
    }

    if (isNonEmptyString(item.nextReviewAt) && compareDateOnlyStrings(item.nextReviewAt, state.currentDate) < 0) {
      const flag = createFlag(
        "overdueReview",
        "warning",
        `${ticker} tiene nextReviewAt vencido (${item.nextReviewAt}).`,
        { source: "watchlist", ticker }
      );
      flags.push(flag);
      overdueReviews.push(flag);
    }
  });

  const seenOpportunityTickers = new Set();

  opportunities.forEach((item) => {
    const ticker = normalizeTicker(item.ticker);

    if (seenOpportunityTickers.has(ticker)) {
      const duplicateOpportunityFlag = createFlag(
        "duplicatedTicker",
        "warning",
        `${ticker} aparece duplicado dentro de nuevas oportunidades.`,
        { source: "opportunity", ticker }
      );
      flags.push(duplicateOpportunityFlag);
      conflicts.push(duplicateOpportunityFlag);
      return;
    }

    seenOpportunityTickers.add(ticker);

    if (positionsByTicker.has(ticker) || watchlist.some((watchItem) => normalizeTicker(watchItem.ticker) === ticker)) {
      const duplicateFlag = createFlag(
        "duplicatedTicker",
        isNonEmptyString(item.duplicateJustification) ? "warning" : "error",
        isNonEmptyString(item.duplicateJustification)
          ? `${ticker} reaparece en nuevas oportunidades con justificacion explicita.`
          : `${ticker} reaparece en nuevas oportunidades sin duplicateJustification.`,
        { source: "opportunity", ticker }
      );

      flags.push(duplicateFlag);
      conflicts.push(duplicateFlag);
    }
  });

  ranking.rankedWatchlist
    .filter((item) => item.status !== "descartar")
    .forEach((item) => {
      if (item.social.isHypey && !item.hasVerifiedCatalyst) {
        flags.push(
          createFlag(
            "hypeWithoutConfirmation",
            "warning",
            `${item.ticker} tiene ruido social temprano sin confirmacion suficiente de datos duros.`,
            { source: item.sourceKind, ticker: item.ticker }
          )
        );
      }

      if (item.outlierFactors.crowdingRisk >= 4) {
        flags.push(
          createFlag(
            "excessiveCrowding",
            "warning",
            `${item.ticker} tiene crowdingRisk alto (${item.outlierFactors.crowdingRisk}).`,
            { source: item.sourceKind, ticker: item.ticker }
          )
        );
      }

      if (item.outlierFactors.catalystStrength <= 2 || !item.hasVerifiedCatalyst) {
        flags.push(
          createFlag(
            "weakCatalyst",
            "warning",
            `${item.ticker} no tiene catalyst suficientemente fuerte para una apuesta outlier.`,
            { source: item.sourceKind, ticker: item.ticker }
          )
        );
      }

      if (item.outlierFactors.downsideClarity <= 2) {
        flags.push(
          createFlag(
            "missingDownsideClarity",
            "warning",
            `${item.ticker} no tiene downsideClarity suficiente para arriesgar capital.`,
            { source: item.sourceKind, ticker: item.ticker }
          )
        );
      }
    });

  eventState.flags.forEach((flag) => {
    flags.push(flag);
  });

  if (comparison && comparison.previousToLatest && latestEntry) {
    comparison.previousToLatest.forEach((change) => {
      if (
        (change.type === "thesisChanged" || change.type === "catalystChanged") &&
        change.ticker &&
        !entryMentionsTicker(latestEntry, change.ticker)
      ) {
        flags.push(
          createFlag(
            "missingLogJustification",
            "warning",
            `${change.ticker} cambio thesis o catalyst sin referencia explicita en el log del ${latestEntry.date}.`,
            { source: change.scope || "log", ticker: change.ticker }
          )
        );
      }
    });
  }

  const crowdingWarnings = dedupeFlags(eventState.social.crowdingWarnings || []);

  return {
    conflicts: dedupeFlags(conflicts),
    crowdingWarnings,
    eventState,
    finalDecision: buildFinalDecision(positions, ranking, crowdingWarnings),
    flags: dedupeFlags(flags),
    latestEntry,
    overdueReviews: dedupeFlags(overdueReviews),
    priorityQueue: buildPriorityQueue(positions, ranking.rankedWatchlist, opportunities),
    ranking
  };
}

module.exports = {
  analyzeDecisionState
};
