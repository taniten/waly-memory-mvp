"use strict";

const { CATALYST_NEAR_DAYS, STATUS_STRENGTH } = require("./constants");
const {
  isNonEmptyString,
  isValidDateOnlyString,
  normalizeTicker,
  parseDateOnlyToUtc
} = require("./validators");

function cloneItems(items) {
  return (items || []).map((item) => ({ ...item }));
}

function createStateSnapshot(state) {
  return {
    positions: cloneItems((state.positions && state.positions.positions) || []),
    watchlist: cloneItems((state.watchlist && state.watchlist.watchlist) || [])
  };
}

function normalizeSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    positions: cloneItems(snapshot.positions || []),
    watchlist: cloneItems(snapshot.watchlist || [])
  };
}

function getEntriesSorted(entries) {
  return [...entries].sort((left, right) => right.date.localeCompare(left.date));
}

function toRecords(snapshot) {
  return [
    ...(snapshot.positions || []).map((item) => ({
      item,
      key: `position:${normalizeTicker(item.ticker)}`,
      scope: "position",
      ticker: normalizeTicker(item.ticker)
    })),
    ...(snapshot.watchlist || []).map((item) => ({
      item,
      key: `watchlist:${normalizeTicker(item.ticker)}`,
      scope: "watchlist",
      ticker: normalizeTicker(item.ticker)
    }))
  ];
}

function createChange(type, message, details = {}) {
  return {
    ...details,
    message,
    type
  };
}

function daysUntil(referenceDate, targetDate) {
  const reference = parseDateOnlyToUtc(referenceDate);
  const target = parseDateOnlyToUtc(targetDate);

  if (!reference || !target) {
    return null;
  }

  return Math.round((target.getTime() - reference.getTime()) / (24 * 60 * 60 * 1000));
}

function compareSnapshots(previousSnapshot, nextSnapshot, referenceDate) {
  if (!previousSnapshot || !nextSnapshot) {
    return [];
  }

  const changes = [];
  const previousRecords = new Map(toRecords(previousSnapshot).map((record) => [record.key, record]));
  const nextRecords = new Map(toRecords(nextSnapshot).map((record) => [record.key, record]));
  const allKeys = new Set([...previousRecords.keys(), ...nextRecords.keys()]);

  Array.from(allKeys)
    .sort()
    .forEach((key) => {
      const previousRecord = previousRecords.get(key) || null;
      const nextRecord = nextRecords.get(key) || null;
      const ticker = previousRecord ? previousRecord.ticker : nextRecord.ticker;
      const scope = previousRecord ? previousRecord.scope : nextRecord.scope;

      if (!previousRecord && nextRecord) {
        changes.push(
          createChange("tickerNew", `${ticker} aparece como ticker nuevo en ${scope}.`, {
            scope,
            ticker
          })
        );
      }

      if (previousRecord && !nextRecord) {
        changes.push(
          createChange("tickerRemoved", `${ticker} fue removido de ${scope}.`, {
            scope,
            ticker
          })
        );
        return;
      }

      if (!previousRecord || !nextRecord) {
        return;
      }

      if (
        Number.isInteger(previousRecord.item.priority) &&
        Number.isInteger(nextRecord.item.priority) &&
        previousRecord.item.priority !== nextRecord.item.priority
      ) {
        changes.push(
          createChange(
            previousRecord.item.priority > nextRecord.item.priority ? "priorityUp" : "priorityDown",
            previousRecord.item.priority > nextRecord.item.priority
              ? `${ticker} subio prioridad de ${previousRecord.item.priority} a ${nextRecord.item.priority}.`
              : `${ticker} bajo prioridad de ${previousRecord.item.priority} a ${nextRecord.item.priority}.`,
            {
              from: previousRecord.item.priority,
              scope,
              ticker,
              to: nextRecord.item.priority
            }
          )
        );
      }

      const previousStatusStrength = STATUS_STRENGTH[previousRecord.item.status] ?? -1;
      const nextStatusStrength = STATUS_STRENGTH[nextRecord.item.status] ?? -1;

      if (nextStatusStrength < previousStatusStrength) {
        changes.push(
          createChange(
            "thesisWeakened",
            `${ticker} muestra tesis debilitada (${previousRecord.item.status} -> ${nextRecord.item.status}).`,
            {
              from: previousRecord.item.status,
              scope,
              ticker,
              to: nextRecord.item.status
            }
          )
        );
      } else if (nextStatusStrength > previousStatusStrength) {
        changes.push(
          createChange(
            "thesisStrengthened",
            `${ticker} mejora de status (${previousRecord.item.status} -> ${nextRecord.item.status}).`,
            {
              from: previousRecord.item.status,
              scope,
              ticker,
              to: nextRecord.item.status
            }
          )
        );
      }

      if (
        isNonEmptyString(previousRecord.item.thesis) &&
        isNonEmptyString(nextRecord.item.thesis) &&
        previousRecord.item.thesis !== nextRecord.item.thesis
      ) {
        changes.push(
          createChange("thesisChanged", `${ticker} actualizo su thesis en ${scope}.`, {
            scope,
            ticker
          })
        );
      } else if (
        isNonEmptyString(previousRecord.item.thesis) &&
        previousRecord.item.thesis === nextRecord.item.thesis
      ) {
        changes.push(
          createChange("thesisIntact", `${ticker} mantiene thesis intacta.`, {
            scope,
            ticker
          })
        );
      }

      const previousCatalystDate = previousRecord.item.catalystDate || previousRecord.item.catalystWindow || "";
      const nextCatalystDate = nextRecord.item.catalystDate || nextRecord.item.catalystWindow || "";
      const previousCatalystType = previousRecord.item.catalystType || "";
      const nextCatalystType = nextRecord.item.catalystType || "";

      if (previousCatalystType !== nextCatalystType || previousCatalystDate !== nextCatalystDate) {
        changes.push(
          createChange("catalystChanged", `${ticker} actualizo catalyst activo o su fecha.`, {
            scope,
            ticker
          })
        );
      }

      if (
        scope === "watchlist" &&
        isNonEmptyString(nextCatalystDate) &&
        isValidDateOnlyString(nextCatalystDate)
      ) {
        const distance = daysUntil(referenceDate, nextCatalystDate);

        if (distance !== null && distance < 0) {
          changes.push(
            createChange(
              "catalystExpired",
              `${ticker} tiene catalystDate vencido (${nextCatalystDate}).`,
              {
                scope,
                ticker
              }
            )
          );
        } else if (distance !== null && distance <= CATALYST_NEAR_DAYS) {
          changes.push(
            createChange(
              "catalystNear",
              `${ticker} tiene catalystDate cercano (${nextCatalystDate}).`,
              {
                scope,
                ticker
              }
            )
          );
        }
      }
    });

  return changes;
}

function compareState(state) {
  const entries = getEntriesSorted(state.dailyLog.entries || []);
  const latestEntry = entries[0] || null;
  const previousEntry = entries[1] || null;
  const currentSnapshot = createStateSnapshot(state);
  const latestSnapshot = latestEntry ? normalizeSnapshot(latestEntry.stateSnapshot || currentSnapshot) : currentSnapshot;
  const previousSnapshot = previousEntry ? normalizeSnapshot(previousEntry.stateSnapshot) : null;
  const notes = [];

  if (latestEntry && !latestEntry.stateSnapshot) {
    notes.push("La ultima revision no tenia stateSnapshot; se usa el estado actual como referencia.");
  }

  if (previousEntry && !previousEntry.stateSnapshot) {
    notes.push("La revision previa no tenia stateSnapshot; la comparacion historica puede ser incompleta.");
  }

  return {
    currentSnapshot,
    latestEntry,
    latestSnapshot,
    latestToCurrent: latestEntry ? compareSnapshots(latestSnapshot, currentSnapshot, state.currentDate) : [],
    notes,
    previousEntry,
    previousSnapshot,
    previousToLatest: previousSnapshot
      ? compareSnapshots(previousSnapshot, latestSnapshot, latestEntry ? latestEntry.date : state.currentDate)
      : [],
    snapshotCoverage: {
      latest: Boolean(latestEntry && latestEntry.stateSnapshot),
      previous: Boolean(previousEntry && previousEntry.stateSnapshot)
    }
  };
}

module.exports = {
  compareState,
  createStateSnapshot
};
