"use strict";

const fs = require("fs");
const path = require("path");
const { buildPreCatalystExitGuardPayload } = require("./preCatalystExitGuard");
const { buildPositionShockPayload } = require("./positionShockMonitor");
const { formatRelative } = require("./realSignalLog");
const { BACKTESTS_DIR } = require("./storage");
const { buildPipelinePayload } = require("./walyPipeline");

const OUTPUT_DIR = path.join(BACKTESTS_DIR, "guardrail-regression-tests");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "summary.md");

function assertOutputPath(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(OUTPUT_DIR, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("guardrail-regression-tests solo puede escribir dentro de backtests/guardrail-regression-tests/.");
  }
}

function writeJson(filePath, value) {
  assertOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function writeText(filePath, value) {
  assertOutputPath(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
  return filePath;
}

function baseInputs(overrides = {}) {
  return {
    currentDate: overrides.currentDate || "2026-05-30",
    dailyCockpit: overrides.dailyCockpit || null,
    exampleOutcomes: null,
    parameterSweep: null,
    positions: {
      positions: overrides.positions || []
    },
    selectorEngine: overrides.selectorEngine || null,
    settings: {
      portfolio: {
        cashEstimate: 1040,
        totalCapitalEstimate: 3000
      },
      timezone: "America/Argentina/Buenos_Aires"
    },
    signalTypeAnalysis: null,
    socialRadar: null,
    v32Results: null,
    watchlist: {
      watchlist: overrides.watchlist || []
    }
  };
}

function positionFixture({
  avgPrice = 10,
  catalyst = "",
  catalystDate = null,
  dayChangePct,
  dollarVolume = 20000000,
  explicitHoldThroughBinary,
  lastPrice = 10,
  previousClose = 10,
  quantity = 10,
  relativeVolume = 1,
  ticker = "TEST"
}) {
  return {
    avgPrice,
    catalyst,
    catalystDate,
    catalystType: catalyst ? "fda" : null,
    explicitHoldThroughBinary,
    lastPrice,
    marketData: {
      dayChangePct,
      dollarVolume,
      price: lastPrice,
      previousClose,
      relativeVolume,
      source: "fixture"
    },
    quantity,
    side: "buy",
    status: "observar",
    ticker
  };
}

function shockRowFor(position, extraInputs = {}) {
  const inputs = baseInputs({
    ...extraInputs,
    positions: [position]
  });
  const payload = buildPositionShockPayload({
    dailyRun: null,
    inputs,
    pipelineLatest: null
  }).payload;

  return payload.rows.find((row) => row.ticker === position.ticker);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectTruthy(value, label) {
  if (!value) {
    throw new Error(`${label}: expected truthy, got ${JSON.stringify(value)}`);
  }
}

function expectFalse(value, label) {
  if (value !== false) {
    throw new Error(`${label}: expected false, got ${JSON.stringify(value)}`);
  }
}

function expectIncludes(values, expected, label) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(values)} to include ${JSON.stringify(expected)}`);
  }
}

function testPositionShockThresholds() {
  const cases = [
    { action: "hold", dayChangePct: -7.99, severity: "none" },
    { action: "alert", dayChangePct: -8, severity: "alert" },
    { action: "review", dayChangePct: -12, severity: "risk_event" },
    { action: "freeze", dayChangePct: -20, severity: "freeze_position" },
    { action: "thesis_broken_until_review", dayChangePct: -40, severity: "thesis_broken_until_review" }
  ];

  cases.forEach((item) => {
    const row = shockRowFor(positionFixture({
      dayChangePct: item.dayChangePct,
      previousClose: 10,
      ticker: `THR${String(Math.abs(item.dayChangePct)).replace(".", "")}`
    }));

    expectEqual(row.shockSeverity, item.severity, `${item.dayChangePct} severity`);
    expectEqual(row.suggestedAction, item.action, `${item.dayChangePct} action`);
  });
}

function testOcsShockFixture() {
  const row = shockRowFor(positionFixture({
    avgPrice: 27.98,
    dayChangePct: -23.42,
    dollarVolume: 34509125.15,
    lastPrice: 22.705,
    previousClose: 29.65,
    quantity: 7,
    relativeVolume: 3.272,
    ticker: "OCS"
  }));

  expectEqual(row.shockSeverity, "freeze_position", "OCS shockSeverity");
  expectEqual(row.suggestedAction, "freeze", "OCS suggestedAction");
  expectTruthy(row.requireManualReview, "OCS requireManualReview");
  expectTruthy(row.requireNewsCheck, "OCS requireNewsCheck");
  expectTruthy(row.noAdd, "OCS noAdd");
  expectTruthy(row.selectorOverride && row.selectorOverride.active, "OCS selectorOverride.active");
  expectEqual(row.selectorOverride && row.selectorOverride.sizingSuggested, 0, "OCS selectorOverride.sizingSuggested");
}

function testNonShockFixture() {
  const row = shockRowFor(positionFixture({
    dayChangePct: -3,
    ticker: "VRDN"
  }));

  expectEqual(row.shockSeverity, "none", "VRDN shockSeverity");
  expectEqual(row.suggestedAction, "hold", "VRDN suggestedAction");
  expectFalse(row.noAdd, "VRDN noAdd");
  expectFalse(row.requireManualReview, "VRDN requireManualReview");
}

function testPipelineIntegrationFixture() {
  const ocsPosition = positionFixture({
    avgPrice: 27.98,
    catalyst: "Phase 3 topline data readout in two days.",
    catalystDate: "2026-06-01",
    dayChangePct: -23.42,
    dollarVolume: 34509125.15,
    lastPrice: 22.705,
    previousClose: 29.65,
    quantity: 7,
    relativeVolume: 3.272,
    ticker: "OCS"
  });
  const inputs = baseInputs({
    dailyCockpit: {
      currentDate: "2026-05-30",
      generatedAt: "2026-05-30T00:00:00.000Z",
      marketData: {
        OCS: ocsPosition.marketData
      },
      portfolio: [],
      router: {
        manualCandidates: []
      },
      watchlist: []
    },
    positions: [ocsPosition],
    selectorEngine: {
      generatedAt: "2026-05-30T00:00:00.000Z",
      ranking: [
        {
          actionSuggested: "mantener",
          classification: "B watch",
          components: {},
          context: {
            catalystDate: "2026-06-01",
            catalystKind: "fda/clinical",
            inPortfolio: true
          },
          marketData: ocsPosition.marketData,
          missingData: [],
          redFlags: [],
          ticker: "OCS",
          totalScore: 67,
          triggerComplete: true
        }
      ]
    },
    watchlist: [
      {
        catalyst: "Phase 3 topline data readout in two days.",
        catalystDate: "2026-06-01",
        setupRank: "A",
        status: "observar",
        ticker: "OCS"
      }
    ]
  });
  const payload = buildPipelinePayload({
    inputs,
    mode: "demo"
  }).payload;
  const rankingRow = payload.selectorRanking.find((row) => row.ticker === "OCS");
  const sizingRow = payload.sizing.rows.find((row) => row.ticker === "OCS");

  expectTruthy(rankingRow, "pipeline OCS ranking row");
  expectTruthy(sizingRow, "pipeline OCS sizing row");
  expectEqual(rankingRow.pipelineClassification, "C research", "pipelineClassification");
  expectEqual(rankingRow.pipelineAction, "revisar_manual", "pipelineAction");
  expectEqual(sizingRow.suggestedSizeUSD, 0, "suggestedSizeUSD");
  expectEqual(sizingRow.suggestedShares, 0, "suggestedShares");
  expectEqual(sizingRow.sizingAction, "reduce_risk", "sizingAction");
  expectFalse(payload.safeToOperate, "pipeline safeToOperate");
}

function testPreCatalystExitGuardFixture() {
  const inputs = baseInputs({
    currentDate: "2026-05-30",
    positions: [
      positionFixture({
        catalyst: "Phase 3 topline data readout.",
        catalystDate: "2026-06-01",
        dayChangePct: 0,
        explicitHoldThroughBinary: false,
        ticker: "ATYR"
      })
    ]
  });
  const payload = buildPreCatalystExitGuardPayload({ inputs }).payload;
  const row = payload.rows.find((item) => item.ticker === "ATYR");

  expectTruthy(row, "pre-catalyst ATYR row");
  expectEqual(row.suggestedAction, "reduce_or_exit_suggested", "pre-catalyst suggestedAction");
  expectIncludes(payload.summary.tickersToFreeze, "ATYR", "pre-catalyst tickersToFreeze");
  expectFalse(payload.safeToOperate, "pre-catalyst safeToOperate");
}

function testMissingDayChangeData() {
  const row = shockRowFor(positionFixture({
    dayChangePct: null,
    ticker: "MISS"
  }));

  expectEqual(row.shockSeverity, "none", "missing dayChangePct shockSeverity");
  expectEqual(row.suggestedAction, "hold", "missing dayChangePct suggestedAction");
  expectFalse(row.requireManualReview, "missing dayChangePct requireManualReview");
  expectIncludes(row.missingData, "dayChangePct", "missing dayChangePct missingData");
}

function runOne(test) {
  try {
    test.fn();
    return {
      name: test.name,
      passed: true
    };
  } catch (error) {
    return {
      error: error && error.message ? error.message : String(error),
      name: test.name,
      passed: false
    };
  }
}

function buildPayload() {
  const tests = [
    { fn: testPositionShockThresholds, name: "Position Shock thresholds" },
    { fn: testOcsShockFixture, name: "OCS fixture" },
    { fn: testNonShockFixture, name: "Non-shock fixture" },
    { fn: testPipelineIntegrationFixture, name: "Pipeline integration fixture" },
    { fn: testPreCatalystExitGuardFixture, name: "Pre-Catalyst Exit Guard fixture" },
    { fn: testMissingDayChangeData, name: "Missing dayChangePct data" }
  ];
  const results = tests.map(runOne);
  const failed = results.filter((item) => !item.passed);
  const passed = results.filter((item) => item.passed);

  return {
    confirmations: [
      "No opera.",
      "No usa IBKR.",
      "No usa Binance.",
      "No envia ordenes.",
      "No modifica data/*.json reales.",
      "No modifica outcomes.",
      "No modifica data/social_signals.json.",
      "No commit.",
      "No push."
    ],
    generatedAt: new Date().toISOString(),
    mode: "read-only-fixtures",
    results,
    status: failed.length === 0 ? "PASS" : "FAIL",
    summary: {
      failed: failed.length,
      passed: passed.length,
      total: results.length
    }
  };
}

function renderSummary(payload) {
  const lines = [];

  lines.push("# WALY Guardrail Regression Tests v1");
  lines.push("");
  lines.push(`Generado: ${payload.generatedAt}`);
  lines.push(`Status: ${payload.status}`);
  lines.push(`Tests: ${payload.summary.total}`);
  lines.push(`Passed: ${payload.summary.passed}`);
  lines.push(`Failed: ${payload.summary.failed}`);
  lines.push("");
  lines.push("## Resultados");
  payload.results.forEach((result) => {
    lines.push(`- ${result.passed ? "PASS" : "FAIL"} | ${result.name}${result.error ? ` | ${result.error}` : ""}`);
  });
  lines.push("");
  lines.push("## Confirmaciones");
  payload.confirmations.forEach((item) => lines.push(`- ${item}`));

  return `${lines.join("\n")}\n`;
}

function writeOutputs(payload) {
  return {
    latestPath: writeJson(LATEST_PATH, payload),
    outputDir: OUTPUT_DIR,
    summaryPath: writeText(SUMMARY_PATH, renderSummary(payload))
  };
}

function renderConsoleReport(payload) {
  const failures = payload.results
    .filter((result) => !result.passed)
    .map((result) => `${result.name}: ${result.error}`);

  return [
    `WALY Guardrail Regression Tests v1: ${payload.status}`,
    `Tests: ${payload.summary.total}`,
    `Passed: ${payload.summary.passed}`,
    `Failed: ${payload.summary.failed}`,
    `Failures: ${failures.join(" | ") || "ninguno"}`,
    `latest.json: ${formatRelative(LATEST_PATH)}`,
    `summary.md: ${formatRelative(SUMMARY_PATH)}`,
    "Confirmacion: no operacion, no IBKR, no Binance, no commit, no push."
  ].join("\n");
}

function runGuardrailRegressionTests(options = {}) {
  const payload = buildPayload();
  let paths = {
    latestPath: null,
    outputDir: OUTPUT_DIR,
    summaryPath: null
  };

  if (options.writeOutput !== false) {
    paths = writeOutputs(payload);
  }

  return {
    ...payload,
    passed: payload.status === "PASS",
    paths,
    consoleReport: renderConsoleReport(payload),
    summaryMarkdown: renderSummary(payload)
  };
}

module.exports = {
  runGuardrailRegressionTests
};
