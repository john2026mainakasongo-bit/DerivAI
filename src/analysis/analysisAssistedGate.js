const DIGIT_MODES = new Set([
  "EVEN",
  "ODD",
  "OVER",
  "UNDER",
  "MATCH",
  "DIFFERS",
]);

const SUPPORTED_MODES = new Set([
  "AUTO",
  "RISE",
  "FALL",
  "EVEN",
  "ODD",
  "OVER",
  "UNDER",
  "MATCH",
  "DIFFERS",
]);

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeMode(value = "AUTO") {
  const mode = String(value || "AUTO").trim().toUpperCase();
  return SUPPORTED_MODES.has(mode) ? mode : "AUTO";
}

function normalizeOptions(input) {
  if (typeof input === "number") {
    return {
      minimumConfidence: clamp(input, 60, 95),
      contractMode: "AUTO",
      prediction: 2,
      durationUnit: "t",
    };
  }

  return {
    minimumConfidence: clamp(input?.minimumConfidence ?? 75, 60, 95),
    contractMode: normalizeMode(input?.contractMode),
    prediction: Math.max(
      0,
      Math.min(9, Math.floor(Number(input?.prediction ?? 2)))
    ),
    durationUnit: input?.durationUnit === "s" ? "s" : "t",
  };
}

function digitPercent(distribution = [], digit) {
  const row = (Array.isArray(distribution) ? distribution : []).find(
    (item) => Number(item?.digit) === Number(digit)
  );

  return Number(row?.percent || 0);
}

function sumDigits(distribution, digits) {
  return digits.reduce(
    (total, digit) => total + digitPercent(distribution, digit),
    0
  );
}

function candidate({
  setup,
  family,
  action,
  prediction = null,
  confidence,
  approved,
  reason,
  edge = 0,
  probability = 0,
  baseline = 0,
  priority = 0,
}) {
  return {
    setup: String(setup || "").toUpperCase(),
    family,
    action,
    prediction,
    confidence: clamp(confidence),
    approved: Boolean(approved),
    reason,
    edge: Number(edge) || 0,
    probability: Number(probability) || 0,
    baseline: Number(baseline) || 0,
    priority: Number(priority) || 0,
  };
}

function buildParityCandidates(analysis, minConfidence) {
  const even = Number(analysis?.parity?.evenPercent || 0);
  const odd = Number(analysis?.parity?.oddPercent || 0);
  const baseConfidence = Number(analysis?.confidence || 0);

  return [
    ["EVEN", even],
    ["ODD", odd],
  ].map(([setup, selected]) => {
    const edge = selected - 50;
    const confidence = Math.max(
      baseConfidence,
      Math.min(95, 50 + Math.abs(edge) * 4)
    );

    return candidate({
      setup,
      family: "PARITY",
      action: setup,
      confidence,
      approved: selected >= 54 && confidence >= minConfidence,
      reason:
        selected >= 54
          ? `${setup} ${selected.toFixed(1)}%`
          : `WAIT · EVEN ${even.toFixed(1)}% / ODD ${odd.toFixed(1)}%`,
      edge,
      probability: selected,
      baseline: 50,
      priority: 30,
    });
  });
}

function buildOverUnderCandidates(analysis, minConfidence) {
  const distribution = Array.isArray(analysis?.distribution)
    ? analysis.distribution
    : [];
  const baseConfidence = Number(analysis?.confidence || 0);
  const rows = [];

  for (let barrier = 0; barrier <= 8; barrier += 1) {
    const digits = Array.from(
      { length: 9 - barrier },
      (_, index) => barrier + index + 1
    );
    const probability = sumDigits(distribution, digits);
    const baseline = (9 - barrier) * 10;
    const edge = probability - baseline;
    const confidence = Math.max(
      baseConfidence,
      Math.min(95, 60 + Math.max(0, edge) * 3)
    );

    rows.push(
      candidate({
        setup: `OVER ${barrier}`,
        family: "OVER_UNDER",
        action: "OVER",
        prediction: barrier,
        confidence,
        approved: edge >= 3 && confidence >= minConfidence,
        reason:
          edge >= 3
            ? `OVER ${barrier} · ${probability.toFixed(1)}%`
            : `WAIT · OVER ${barrier} ${probability.toFixed(
                1
              )}% vs ${baseline.toFixed(1)}% baseline`,
        edge,
        probability,
        baseline,
        priority: 40,
      })
    );
  }

  for (let barrier = 1; barrier <= 9; barrier += 1) {
    const digits = Array.from(
      { length: barrier },
      (_, index) => index
    );
    const probability = sumDigits(distribution, digits);
    const baseline = barrier * 10;
    const edge = probability - baseline;
    const confidence = Math.max(
      baseConfidence,
      Math.min(95, 60 + Math.max(0, edge) * 3)
    );

    rows.push(
      candidate({
        setup: `UNDER ${barrier}`,
        family: "OVER_UNDER",
        action: "UNDER",
        prediction: barrier,
        confidence,
        approved: edge >= 3 && confidence >= minConfidence,
        reason:
          edge >= 3
            ? `UNDER ${barrier} · ${probability.toFixed(1)}%`
            : `WAIT · UNDER ${barrier} ${probability.toFixed(
                1
              )}% vs ${baseline.toFixed(1)}% baseline`,
        edge,
        probability,
        baseline,
        priority: 40,
      })
    );
  }

  return rows;
}

function buildMatchDiffersCandidates(analysis, minConfidence) {
  const distribution = Array.isArray(analysis?.distribution)
    ? analysis.distribution
    : [];
  const signalConfidence = Number(
    analysis?.signals?.matchDiff?.confidence || 0
  );
  const rows = [];

  for (let digit = 0; digit <= 9; digit += 1) {
    const probability = digitPercent(distribution, digit);
    const matchConfidence = Math.max(
      signalConfidence,
      Math.min(95, 50 + Math.max(0, probability - 10) * 7)
    );

    rows.push(
      candidate({
        setup: `MATCH ${digit}`,
        family: "MATCH_DIFFERS",
        action: "MATCH",
        prediction: digit,
        confidence: matchConfidence,
        approved:
          probability >= 13.5 &&
          matchConfidence >= minConfidence,
        reason:
          probability >= 13.5
            ? `MATCH ${digit} · ${probability.toFixed(1)}%`
            : `WAIT · MATCH ${digit} is ${probability.toFixed(1)}%`,
        edge: probability - 10,
        probability,
        baseline: 10,
        priority: 10,
      })
    );

    const differsConfidence = Math.max(
      signalConfidence,
      Math.min(95, 50 + Math.max(0, 10 - probability) * 7)
    );

    rows.push(
      candidate({
        setup: `DIFFERS ${digit}`,
        family: "MATCH_DIFFERS",
        action: "DIFFERS",
        prediction: digit,
        confidence: differsConfidence,
        approved:
          probability <= 7.5 &&
          differsConfidence >= minConfidence,
        reason:
          probability <= 7.5
            ? `DIFFERS ${digit} · digit ${probability.toFixed(1)}%`
            : `WAIT · DIFFERS ${digit}, digit is ${probability.toFixed(
                1
              )}%`,
        edge: 10 - probability,
        probability,
        baseline: 10,
        priority: 20,
      })
    );
  }

  return rows;
}

function buildRiseFallCandidates(analysis, minConfidence) {
  const momentumDirection = String(
    analysis?.momentum?.direction || ""
  ).toUpperCase();

  const signal = String(
    analysis?.direction?.signal?.signal ||
      analysis?.signals?.riseFall?.signal ||
      ""
  ).toUpperCase();

  const preferred =
    signal === "RISE" || signal === "FALL"
      ? signal
      : momentumDirection === "UP"
      ? "RISE"
      : momentumDirection === "DOWN"
      ? "FALL"
      : "";

  const confidence = Math.max(
    Number(analysis?.direction?.signal?.confidence || 0),
    Number(analysis?.signals?.riseFall?.confidence || 0),
    Number(analysis?.confidence || 0)
  );

  return ["RISE", "FALL"].map((setup) => {
    const approved = preferred === setup && confidence >= minConfidence;

    return candidate({
      setup,
      family: "RISE_FALL",
      action: setup,
      confidence,
      approved,
      reason: approved
        ? `${setup} · momentum ${momentumDirection || "CONFIRMED"}`
        : `WAIT · preferred direction ${preferred || "NEUTRAL"}`,
      edge: approved ? confidence - minConfidence : 0,
      probability: confidence,
      baseline: minConfidence,
      priority: 50,
    });
  });
}

function selectCandidates(candidates, options) {
  const { contractMode, prediction, durationUnit } = options;

  // Digit contracts are kept on tick duration. In seconds mode,
  // AUTO scans Rise/Fall only to avoid invalid contract combinations.
  if (durationUnit === "s" && DIGIT_MODES.has(contractMode)) {
    return {
      candidates: [],
      compatibilityError:
        "Seconds mode is available for AUTO, RISE or FALL. Digit contracts use ticks.",
    };
  }

  if (contractMode === "AUTO") {
    return {
      candidates:
        durationUnit === "s"
          ? candidates.filter((item) => item.family === "RISE_FALL")
          : candidates,
      compatibilityError: "",
    };
  }

  if (["RISE", "FALL", "EVEN", "ODD"].includes(contractMode)) {
    return {
      candidates: candidates.filter((item) => item.setup === contractMode),
      compatibilityError: "",
    };
  }

  if (contractMode === "OVER") {
    if (prediction > 8) {
      return {
        candidates: [],
        compatibilityError: "OVER prediction must be between 0 and 8.",
      };
    }

    return {
      candidates: candidates.filter(
        (item) => item.action === "OVER" && item.prediction === prediction
      ),
      compatibilityError: "",
    };
  }

  if (contractMode === "UNDER") {
    if (prediction < 1) {
      return {
        candidates: [],
        compatibilityError: "UNDER prediction must be between 1 and 9.",
      };
    }

    return {
      candidates: candidates.filter(
        (item) => item.action === "UNDER" && item.prediction === prediction
      ),
      compatibilityError: "",
    };
  }

  if (["MATCH", "DIFFERS"].includes(contractMode)) {
    return {
      candidates: candidates.filter(
        (item) => item.action === contractMode && item.prediction === prediction
      ),
      compatibilityError: "",
    };
  }

  return { candidates, compatibilityError: "" };
}

/**
 * Decides WAIT / ENTER for the selected contract, or finds the best contract
 * when AUTO is selected. Settlement and P&L are handled by the bot engine.
 */
export function evaluateAnalysisAssistedSignal(analysis = {}, input = {}) {
  const options = normalizeOptions(input);
  const {
    minimumConfidence,
    contractMode,
    prediction,
    durationUnit,
  } = options;

  const sampleSize = Number(analysis?.sampleSize || 0);
  const distribution = Array.isArray(analysis?.distribution)
    ? analysis.distribution
    : [];

  if (sampleSize < 60 || distribution.length < 10) {
    return {
      approved: false,
      setup: "WAIT",
      confidence: 0,
      minConfidence: minimumConfidence,
      reason: `Need more samples (${sampleSize}/60).`,
      candidates: [],
      contractMode,
      prediction,
      durationUnit,
    };
  }

  const allCandidates = [
    ...buildRiseFallCandidates(analysis, minimumConfidence),
    ...buildParityCandidates(analysis, minimumConfidence),
    ...buildOverUnderCandidates(analysis, minimumConfidence),
    ...buildMatchDiffersCandidates(analysis, minimumConfidence),
  ];

  const selection = selectCandidates(allCandidates, options);

  if (selection.compatibilityError) {
    return {
      approved: false,
      setup: "WAIT",
      confidence: 0,
      minConfidence: minimumConfidence,
      reason: selection.compatibilityError,
      candidates: [],
      contractMode,
      prediction,
      durationUnit,
    };
  }

  const selectedCandidates = selection.candidates;
  const approvedCandidates = selectedCandidates
    .filter((item) => item.approved)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.edge - a.edge ||
        b.priority - a.priority
    );

  if (approvedCandidates.length) {
    const best = approvedCandidates[0];

    return {
      approved: true,
      setup: best.setup,
      confidence: best.confidence,
      minConfidence: minimumConfidence,
      reason: best.reason,
      candidates: selectedCandidates,
      contractMode,
      prediction: best.prediction ?? prediction,
      durationUnit,
      selectedProbability: best.probability,
      baselineProbability: best.baseline,
      edge: best.edge,
    };
  }

  const nearest = selectedCandidates
    .slice()
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.edge - a.edge ||
        b.priority - a.priority
    )[0];

  const selectedLabel =
    contractMode === "AUTO"
      ? "AUTO BEST"
      : ["OVER", "UNDER", "MATCH", "DIFFERS"].includes(contractMode)
      ? `${contractMode} ${prediction}`
      : contractMode;

  return {
    approved: false,
    setup: "WAIT",
    confidence: Number(nearest?.confidence || 0),
    minConfidence: minimumConfidence,
    reason:
      nearest?.reason || `WAIT · no approved ${selectedLabel} entry yet.`,
    candidates: selectedCandidates,
    contractMode,
    prediction,
    durationUnit,
    selectedProbability: Number(nearest?.probability || 0),
    baselineProbability: Number(nearest?.baseline || 0),
    edge: Number(nearest?.edge || 0),
  };
}

export default evaluateAnalysisAssistedSignal;
