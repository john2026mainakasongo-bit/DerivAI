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

// AUTO intentionally uses only contracts that can be checked by the
// walk-forward validator already used by the page. Every manual contract
// remains available, but AUTO no longer jumps into every barrier/digit.
const AUTO_SAFE_SETUPS = new Set([
  "RISE",
  "FALL",
  "EVEN",
  "ODD",
  "OVER 2",
]);

const MIN_DIGIT_SAMPLES = 120;

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
      minimumConfidence: clamp(input, 70, 95),
      contractMode: "AUTO",
      prediction: 2,
      durationUnit: "t",
    };
  }

  return {
    minimumConfidence: clamp(input?.minimumConfidence ?? 84, 70, 95),
    contractMode: normalizeMode(input?.contractMode),
    prediction: Math.max(
      0,
      Math.min(9, Math.floor(Number(input?.prediction ?? 2)))
    ),
    durationUnit: input?.durationUnit === "s" ? "s" : "t",
  };
}

function rowsOf(analysis) {
  return Array.isArray(analysis?.distribution)
    ? analysis.distribution
    : [];
}

function recencyRowsOf(analysis) {
  return Array.isArray(analysis?.recency)
    ? analysis.recency
    : [];
}

function digitPercent(distribution = [], digit, key = "percent") {
  const row = (Array.isArray(distribution) ? distribution : []).find(
    (item) => Number(item?.digit) === Number(digit)
  );

  return Number(row?.[key] || 0);
}

function sumDigits(distribution, digits, key = "percent") {
  return digits.reduce(
    (total, digit) => total + digitPercent(distribution, digit, key),
    0
  );
}

function probabilityProfile(analysis, digits) {
  const distribution = rowsOf(analysis);
  const recency = recencyRowsOf(analysis);
  const full = sumDigits(distribution, digits);

  const hasRecency = recency.length >= 10;
  const recent = hasRecency
    ? sumDigits(recency, digits, "recentPercent")
    : full;
  const baseline = hasRecency
    ? sumDigits(recency, digits, "baselinePercent")
    : full;

  const values = [full, recent, baseline].filter(Number.isFinite);
  const conservative = values.length ? Math.min(...values) : 0;
  const spread = values.length
    ? Math.max(...values) - Math.min(...values)
    : 100;

  return {
    full,
    recent,
    baseline,
    conservative,
    spread,
  };
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
  stability = 0,
  autoEligible = false,
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
    stability: Number(stability) || 0,
    autoEligible: Boolean(autoEligible),
    priority: Number(priority) || 0,
  };
}

function candidateConfidence(edge, spread, base = 65) {
  return clamp(base + Math.max(0, edge) * 3.4 - Math.max(0, spread - 3) * 1.6);
}

function buildParityCandidates(analysis, minConfidence, sampleReady) {
  return [
    ["EVEN", [0, 2, 4, 6, 8]],
    ["ODD", [1, 3, 5, 7, 9]],
  ].map(([setup, digits]) => {
    const profile = probabilityProfile(analysis, digits);
    const edge = profile.conservative - 50;
    const confidence = candidateConfidence(edge, profile.spread, 65);
    const approved =
      sampleReady &&
      profile.full >= 56 &&
      profile.recent >= 55 &&
      profile.baseline >= 53 &&
      profile.conservative >= 56.5 &&
      profile.spread <= 9 &&
      confidence >= minConfidence;

    return candidate({
      setup,
      family: "PARITY",
      action: setup,
      confidence,
      approved,
      reason: approved
        ? `${setup} stable · full ${profile.full.toFixed(1)}% · recent ${profile.recent.toFixed(1)}%`
        : `WAIT · ${setup} full ${profile.full.toFixed(1)}% / recent ${profile.recent.toFixed(1)}% / base ${profile.baseline.toFixed(1)}%`,
      edge,
      probability: profile.conservative,
      baseline: 50,
      stability: 100 - profile.spread,
      autoEligible: true,
      priority: 30,
    });
  });
}

function buildOverUnderCandidates(analysis, minConfidence, sampleReady) {
  const rows = [];

  for (let barrier = 0; barrier <= 8; barrier += 1) {
    const digits = Array.from(
      { length: 9 - barrier },
      (_, index) => barrier + index + 1
    );
    const naturalBaseline = (9 - barrier) * 10;
    const profile = probabilityProfile(analysis, digits);
    const edge = profile.conservative - naturalBaseline;
    const confidence = candidateConfidence(edge, profile.spread, 66);
    const approved =
      sampleReady &&
      profile.full >= naturalBaseline + 5.5 &&
      profile.recent >= naturalBaseline + 5 &&
      profile.baseline >= naturalBaseline + 3.5 &&
      profile.conservative >= naturalBaseline + 6 &&
      profile.spread <= 10 &&
      confidence >= minConfidence;

    rows.push(
      candidate({
        setup: `OVER ${barrier}`,
        family: "OVER_UNDER",
        action: "OVER",
        prediction: barrier,
        confidence,
        approved,
        reason: approved
          ? `OVER ${barrier} stable · conservative ${profile.conservative.toFixed(1)}%`
          : `WAIT · OVER ${barrier} ${profile.full.toFixed(1)}% / ${profile.recent.toFixed(1)}% recent vs ${naturalBaseline.toFixed(1)}% base`,
        edge,
        probability: profile.conservative,
        baseline: naturalBaseline,
        stability: 100 - profile.spread,
        autoEligible: barrier === 2,
        priority: barrier === 2 ? 50 : 20,
      })
    );
  }

  for (let barrier = 1; barrier <= 9; barrier += 1) {
    const digits = Array.from({ length: barrier }, (_, index) => index);
    const naturalBaseline = barrier * 10;
    const profile = probabilityProfile(analysis, digits);
    const edge = profile.conservative - naturalBaseline;
    const confidence = candidateConfidence(edge, profile.spread, 66);
    const approved =
      sampleReady &&
      profile.full >= naturalBaseline + 5.5 &&
      profile.recent >= naturalBaseline + 5 &&
      profile.baseline >= naturalBaseline + 3.5 &&
      profile.conservative >= naturalBaseline + 6 &&
      profile.spread <= 10 &&
      confidence >= minConfidence;

    rows.push(
      candidate({
        setup: `UNDER ${barrier}`,
        family: "OVER_UNDER",
        action: "UNDER",
        prediction: barrier,
        confidence,
        approved,
        reason: approved
          ? `UNDER ${barrier} stable · conservative ${profile.conservative.toFixed(1)}%`
          : `WAIT · UNDER ${barrier} ${profile.full.toFixed(1)}% / ${profile.recent.toFixed(1)}% recent vs ${naturalBaseline.toFixed(1)}% base`,
        edge,
        probability: profile.conservative,
        baseline: naturalBaseline,
        stability: 100 - profile.spread,
        // UNDER barriers stay manual because the current walk-forward validator
        // only validates UNDER 2, which is a high-variance contract.
        autoEligible: false,
        priority: 20,
      })
    );
  }

  return rows;
}

function buildMatchDiffersCandidates(analysis, minConfidence, sampleReady) {
  const rows = [];

  for (let digit = 0; digit <= 9; digit += 1) {
    const match = probabilityProfile(analysis, [digit]);
    const matchEdge = match.conservative - 10;
    const matchConfidence = candidateConfidence(matchEdge, match.spread, 60);
    const matchApproved =
      sampleReady &&
      match.full >= 17 &&
      match.recent >= 15 &&
      match.baseline >= 13 &&
      match.conservative >= 15 &&
      match.spread <= 8 &&
      matchConfidence >= minConfidence;

    rows.push(
      candidate({
        setup: `MATCH ${digit}`,
        family: "MATCH_DIFFERS",
        action: "MATCH",
        prediction: digit,
        confidence: matchConfidence,
        approved: matchApproved,
        reason: matchApproved
          ? `MATCH ${digit} stable · conservative ${match.conservative.toFixed(1)}%`
          : `WAIT · MATCH ${digit} ${match.full.toFixed(1)}% / ${match.recent.toFixed(1)}% recent`,
        edge: matchEdge,
        probability: match.conservative,
        baseline: 10,
        stability: 100 - match.spread,
        autoEligible: false,
        priority: 5,
      })
    );

    const targetWorst = Math.max(match.full, match.recent, match.baseline);
    const differsProbability = 100 - targetWorst;
    const differsEdge = differsProbability - 90;
    const differsConfidence = candidateConfidence(
      differsEdge,
      match.spread,
      62
    );
    const differsApproved =
      sampleReady &&
      targetWorst <= 4.5 &&
      match.spread <= 6 &&
      differsConfidence >= minConfidence;

    rows.push(
      candidate({
        setup: `DIFFERS ${digit}`,
        family: "MATCH_DIFFERS",
        action: "DIFFERS",
        prediction: digit,
        confidence: differsConfidence,
        approved: differsApproved,
        reason: differsApproved
          ? `DIFFERS ${digit} stable · target worst-case ${targetWorst.toFixed(1)}%`
          : `WAIT · DIFFERS ${digit}, target worst-case ${targetWorst.toFixed(1)}%`,
        edge: differsEdge,
        probability: differsProbability,
        baseline: 90,
        stability: 100 - match.spread,
        autoEligible: false,
        priority: 5,
      })
    );
  }

  return rows;
}

function buildRiseFallCandidates(analysis, minConfidence) {
  const direction = analysis?.direction || {};
  const directionSignal = String(
    direction?.signal?.signal || analysis?.signals?.riseFall?.signal || ""
  ).toUpperCase();
  const momentumDirection = String(
    analysis?.momentum?.direction || ""
  ).toUpperCase();
  const momentumSetup =
    momentumDirection === "UP"
      ? "RISE"
      : momentumDirection === "DOWN"
      ? "FALL"
      : "";

  const preferred = ["RISE", "FALL"].includes(directionSignal)
    ? directionSignal
    : "";
  const confidence = Number(
    direction?.signal?.confidence || analysis?.signals?.riseFall?.confidence || 0
  );
  const strength = Number(direction?.strength || 0);
  const consistency = Number(direction?.consistency || 0);
  const estimate =
    preferred === "RISE"
      ? Number(direction?.riseEstimate || 0)
      : preferred === "FALL"
      ? Number(direction?.fallEstimate || 0)
      : 0;

  return ["RISE", "FALL"].map((setup) => {
    const approved =
      preferred === setup &&
      momentumSetup === setup &&
      estimate >= 70 &&
      strength >= 40 &&
      consistency >= 62 &&
      confidence >= minConfidence;

    return candidate({
      setup,
      family: "RISE_FALL",
      action: setup,
      confidence,
      approved,
      reason: approved
        ? `${setup} confirmed · estimate ${estimate.toFixed(1)}% · consistency ${consistency.toFixed(1)}%`
        : `WAIT · direction ${preferred || "NEUTRAL"} / momentum ${momentumSetup || "NEUTRAL"} / consistency ${consistency.toFixed(1)}%`,
      edge: Math.max(0, estimate - 50),
      probability: estimate,
      baseline: 50,
      stability: consistency,
      autoEligible: true,
      priority: 60,
    });
  });
}

function selectCandidates(candidates, options) {
  const { contractMode, prediction, durationUnit } = options;

  if (durationUnit === "s" && DIGIT_MODES.has(contractMode)) {
    return {
      candidates: [],
      compatibilityError:
        "Seconds mode is available for AUTO, RISE or FALL. Digit contracts use ticks.",
    };
  }

  if (contractMode === "AUTO") {
    return {
      candidates: candidates.filter(
        (item) =>
          item.autoEligible &&
          AUTO_SAFE_SETUPS.has(item.setup) &&
          (durationUnit !== "s" || item.family === "RISE_FALL")
      ),
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
 * Conservative Analysis Assisted gate.
 * It only returns ENTER when full-window, recent-window and baseline-window
 * evidence agree. AUTO is intentionally narrower than manual mode.
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
  const distribution = rowsOf(analysis);
  const sampleReady =
    sampleSize >= MIN_DIGIT_SAMPLES && distribution.length >= 10;

  if (DIGIT_MODES.has(contractMode) && !sampleReady) {
    return {
      approved: false,
      setup: "WAIT",
      confidence: 0,
      minConfidence: minimumConfidence,
      reason: `Need more digit samples (${sampleSize}/${MIN_DIGIT_SAMPLES}).`,
      candidates: [],
      contractMode,
      prediction,
      durationUnit,
    };
  }

  const allCandidates = [
    ...buildRiseFallCandidates(analysis, minimumConfidence),
    ...buildParityCandidates(analysis, minimumConfidence, sampleReady),
    ...buildOverUnderCandidates(analysis, minimumConfidence, sampleReady),
    ...buildMatchDiffersCandidates(analysis, minimumConfidence, sampleReady),
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
        b.edge - a.edge ||
        b.stability - a.stability ||
        b.confidence - a.confidence ||
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
      stability: best.stability,
      riskMode: "CONSERVATIVE",
    };
  }

  const nearest = selectedCandidates
    .slice()
    .sort(
      (a, b) =>
        b.edge - a.edge ||
        b.stability - a.stability ||
        b.confidence - a.confidence ||
        b.priority - a.priority
    )[0];

  const selectedLabel =
    contractMode === "AUTO"
      ? "AUTO SAFE"
      : ["OVER", "UNDER", "MATCH", "DIFFERS"].includes(contractMode)
      ? `${contractMode} ${prediction}`
      : contractMode;

  const sampleReason =
    contractMode === "AUTO" && !sampleReady
      ? ` Digit contracts need ${MIN_DIGIT_SAMPLES} samples; Rise/Fall is still being checked.`
      : "";

  return {
    approved: false,
    setup: "WAIT",
    confidence: Number(nearest?.confidence || 0),
    minConfidence: minimumConfidence,
    reason:
      (nearest?.reason || `WAIT · no approved ${selectedLabel} entry yet.`) +
      sampleReason,
    candidates: selectedCandidates,
    contractMode,
    prediction,
    durationUnit,
    selectedProbability: Number(nearest?.probability || 0),
    baselineProbability: Number(nearest?.baseline || 0),
    edge: Number(nearest?.edge || 0),
    stability: Number(nearest?.stability || 0),
    riskMode: "CONSERVATIVE",
  };
}

export default evaluateAnalysisAssistedSignal;
