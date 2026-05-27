"use strict";

const path = require("path");
const {
  OUTPUT_DIR,
  formatRelative,
  readCoreInputs,
  round,
  writePillarJson
} = require("./realSignalLog");

function topCombinations(parameterSweep) {
  return ((parameterSweep && parameterSweep.combinations) || [])
    .slice()
    .sort((left, right) => (right.robustnessScore || 0) - (left.robustnessScore || 0))
    .slice(0, 5);
}

function summarizeSignalTypes(signalTypeAnalysis) {
  return ((signalTypeAnalysis && signalTypeAnalysis.signalTypes) || []).map((item) => ({
    bestRule: item.bestRule || null,
    signalCount: item.signalCount,
    signalType: item.signalType,
    verdict: item.verdict,
    walyFit: item.walyFit,
    worstRule: item.worstRule || null
  }));
}

function buildTrainTestPayload(options = {}) {
  const inputs = options.inputs || readCoreInputs();
  const allCombinations = (inputs.parameterSweep && inputs.parameterSweep.combinations) || [];
  const robustRules = topCombinations(inputs.parameterSweep);
  const signalTypes = summarizeSignalTypes(inputs.signalTypeAnalysis);
  const v32 = inputs.v32Results || null;
  const failedRules = [];

  if (v32 && v32.narrative) {
    failedRules.push({
      evidence: v32.narrative.recommendation || "descartar gate por ahora",
      rule: "v3.2 signal-quality gate"
    });
  } else {
    failedRules.push({
      evidence: "missingData: backtests/historical-research/v3-2-signal-quality-backtest/results.json",
      rule: "v3.2 signal-quality gate"
    });
  }

  signalTypes
    .filter((item) => /penalizar|requiere filtro/i.test(item.verdict || ""))
    .forEach((item) => {
      failedRules.push({
        evidence: item.verdict,
        rule: item.signalType
      });
    });

  const v31Rule = allCombinations.find((rule) =>
    rule.takeProfitPct === 30 &&
    rule.stopLossPct === -10 &&
    rule.exitDays === 20
  ) || null;
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "read-only-research",
    notes: [
      "No corre backtest pesado nuevo.",
      "Usa outputs historicos existentes si estan disponibles.",
      "Pide out-of-sample antes de activar reglas nuevas."
    ],
    outOfSampleRequirement: "No activar reglas nuevas sin forward/out-of-sample separado y congelado.",
    robustRules: robustRules.map((rule) => ({
      avgMaxDrawdownPct: rule.avgMaxDrawdownPct,
      avgReturnPct: rule.avgReturnPct,
      combo: rule.combo,
      robustnessScore: rule.robustnessScore,
      winRatePct: rule.winRatePct
    })),
    failedRules,
    specificFindings: {
      v31Defensive: v31Rule
        ? `v3.1 TP30/SL-10/20d defensivo existe pero no lidera robustez: score ${round(v31Rule.robustnessScore, 3)}.`
        : "v3.1 TP30/SL-10/20d defensivo no aparece en parameter-sweep local.",
      v32Gate: v32 && v32.narrative
        ? `v3.2 gate actual fallo como filtro operativo: ${v32.narrative.recommendation}. A_candidate spread 30d ${v32.aVsRest ? v32.aVsRest.avgReturnSpread30dPct : "n/d"}%.`
        : "missingData: v3.2 results."
    },
    signalTypes,
    summary: {
      historicalFilesAvailable: [
        inputs.parameterSweep ? "parameter-sweep" : null,
        inputs.signalTypeAnalysis ? "signal-type-analysis" : null,
        inputs.v32Results ? "v3-2-results" : null
      ].filter(Boolean),
      robustRulesCount: robustRules.length,
      signalTypesAnalyzed: signalTypes.length
    }
  };

  return {
    inputs,
    payload
  };
}

function renderConsoleReport(payload) {
  const top = payload.robustRules.slice(0, 3).map((rule) => `${rule.combo}:${rule.robustnessScore}`);

  return [
    "WALY Train/Test Engine generado.",
    `Historicos: ${payload.summary.historicalFilesAvailable.join(", ") || "missingData"}`,
    `Top rules: ${top.join(" | ") || "ninguna"}`,
    `v3.2: ${payload.specificFindings.v32Gate}`,
    `Output: ${formatRelative(path.join(OUTPUT_DIR, "train-test-engine.json"))}`,
    "Confirmacion: research-only, no backtest pesado nuevo."
  ].join("\n");
}

function runTrainTestEngine(options = {}) {
  const { inputs, payload } = buildTrainTestPayload(options);
  let outputPath = null;

  if (options.writeOutput !== false) {
    outputPath = writePillarJson("train-test-engine.json", payload);
  }

  return {
    ...payload,
    inputsRaw: inputs,
    paths: {
      outputPath
    },
    consoleReport: renderConsoleReport(payload)
  };
}

module.exports = {
  buildTrainTestPayload,
  runTrainTestEngine
};
