
const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const OVER_BARRIERS = [1, 2, 3, 4, 5, 6, 7];
const UNDER_BARRIERS = [1, 2, 3, 4, 5, 6, 7];

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function stdDev(values = []) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    mean(values.map((value) => (Number(value) - average) ** 2))
  );
}

function cleanDigits(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(
      (digit) =>
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-300);
}

function lastDigitFromPrice(value) {
  if (!Number.isFinite(Number(value))) return null;
  const text = String(value).replace(/\D/g, "");
  return text ? Number(text.at(-1)) : null;
}

function digitsFromInput(input = {}) {
  const direct = cleanDigits(input.digitHistory);
  if (direct.length) return direct;

  const prices = (Array.isArray(input.prices) ? input.prices : [])
    .map((item) => Number(item?.quote ?? item?.price ?? item))
    .filter(Number.isFinite);

  const digits = prices
    .map(lastDigitFromPrice)
    .filter((digit) => Number.isInteger(digit));

  const current = lastDigitFromPrice(Number(input.currentPrice));
  if (Number.isInteger(current) && digits.at(-1) !== current) {
    digits.push(current);
  }

  return digits.slice(-300);
}

function countsOf(digits = []) {
  const counts = Array(10).fill(0);
  digits.forEach((digit) => {
    counts[digit] += 1;
  });
  return counts;
}

function probabilitiesOf(digits = [], smoothing = 1) {
  const counts = countsOf(digits);
  const denominator = digits.length + smoothing * 10;

  return counts.map(
    (count) => (count + smoothing) / Math.max(1, denominator)
  );
}

function transitionModel(digits = []) {
  const matrix = Array.from(
    { length: 10 },
    () => Array(10).fill(0)
  );
  const totals = Array(10).fill(0);

  for (let index = 1; index < digits.length; index += 1) {
    const previous = digits[index - 1];
    const next = digits[index];
    matrix[previous][next] += 1;
    totals[previous] += 1;
  }

  return { matrix, totals };
}

function blendedNextProbabilities(digits = []) {
  const global = probabilitiesOf(digits, 1);
  const currentDigit = digits.at(-1);
  const transitions = transitionModel(digits);
  const transitionSamples =
    Number.isInteger(currentDigit)
      ? transitions.totals[currentDigit]
      : 0;

  if (!Number.isInteger(currentDigit) || transitionSamples < 3) {
    return {
      probabilities: global,
      currentDigit,
      transitionSamples,
      source: "GLOBAL_FREQUENCY",
    };
  }

  const row = transitions.matrix[currentDigit];
  const rowProbabilities = row.map(
    (count) => (count + 1) / (transitionSamples + 10)
  );

  const transitionWeight = Math.min(
    0.72,
    0.28 + transitionSamples / 45
  );

  return {
    probabilities: rowProbabilities.map(
      (value, digit) =>
        value * transitionWeight +
        global[digit] * (1 - transitionWeight)
    ),
    currentDigit,
    transitionSamples,
    source: "TRANSITION_BLEND",
  };
}

function windowProfiles(digits = []) {
  const sizes = [50, 100, 200].filter(
    (size) => digits.length >= Math.min(size, 50)
  );

  return sizes.map((size) => {
    const window = digits.slice(-Math.min(size, digits.length));
    return {
      size: window.length,
      probabilities: blendedNextProbabilities(window).probabilities,
    };
  });
}

function setupProbability(probabilities, mode, barrier) {
  if (mode === "OVER") {
    return probabilities.reduce(
      (sum, probability, digit) =>
        sum + (digit > barrier ? probability : 0),
      0
    );
  }

  if (mode === "UNDER") {
    return probabilities.reduce(
      (sum, probability, digit) =>
        sum + (digit < barrier ? probability : 0),
      0
    );
  }

  return 0;
}

function naturalProbability(mode, barrier) {
  return mode === "OVER"
    ? (9 - barrier) / 10
    : barrier / 10;
}

function qualityScore({
  probability,
  baseline,
  consistency,
  sampleSize,
  transitionSamples,
  barrierPriority = 0,
}) {
  const edge = (probability - baseline) * 100;
  const sampleQuality = clamp((sampleSize / 120) * 100);
  const transitionQuality = clamp((transitionSamples / 18) * 100);

  return clamp(
    48 +
      edge * 1.8 +
      consistency * 0.22 +
      sampleQuality * 0.08 +
      transitionQuality * 0.08 +
      barrierPriority,
    0,
    96
  );
}

function buildOverUnderCandidates(digits, minimumConfidence) {
  const blended = blendedNextProbabilities(digits);
  const windows = windowProfiles(digits);
  const rows = [];

  for (const mode of ["OVER", "UNDER"]) {
    const barriers = mode === "OVER" ? OVER_BARRIERS : UNDER_BARRIERS;

    for (const barrier of barriers) {
      const probability = setupProbability(
        blended.probabilities,
        mode,
        barrier
      );
      const baseline = naturalProbability(mode, barrier);
      const windowValues = windows.map((window) =>
        setupProbability(window.probabilities, mode, barrier)
      );
      const consistency = clamp(
        100 - stdDev(windowValues.map((value) => value * 100)) * 7
      );
      const edge = (probability - baseline) * 100;

      // Smaller barriers are preferred when evidence is comparable.
      // Higher barriers can still win when their measured edge is stronger.
      const barrierPriority =
        mode === "OVER"
          ? Math.max(-4, 4 - barrier * 0.8)
          : Math.max(-4, barrier * 0.35 - 1.5);

      const score = qualityScore({
        probability,
        baseline,
        consistency,
        sampleSize: digits.length,
        transitionSamples: blended.transitionSamples,
        barrierPriority,
      });

      const minimumProbability =
        mode === "OVER"
          ? Math.max(0.22, baseline + 0.015)
          : Math.max(0.18, baseline + 0.015);

      const executable =
        digits.length >= 50 &&
        blended.transitionSamples >= 3 &&
        probability >= minimumProbability &&
        edge >= 1.5 &&
        consistency >= 70 &&
        score >= minimumConfidence;

      rows.push({
        setup: `${mode} ${barrier}`,
        mode,
        prediction: barrier,
        contractType: mode === "OVER" ? "DIGITOVER" : "DIGITUNDER",
        barrier: String(barrier),
        probability: probability * 100,
        baselineProbability: baseline * 100,
        probabilityEdge: edge,
        expectedValue: edge,
        consistency,
        stability: consistency,
        qualityScore: score,
        confidence: score,
        sampleSize: digits.length,
        transitionSamples: blended.transitionSamples,
        voteCount: [
          probability >= minimumProbability,
          edge >= 1.5,
          consistency >= 58,
          digits.length >= 50,
          blended.transitionSamples >= 3,
        ].filter(Boolean).length,
        totalVotes: 5,
        executable,
        highRisk: barrier >= 5,
        source: blended.source,
        reason: executable
          ? `${mode} ${barrier} qualifies at ${(probability * 100).toFixed(1)}% with ${edge.toFixed(1)}% measured edge.`
          : `${mode} ${barrier} scanning: ${(probability * 100).toFixed(1)}%, edge ${edge.toFixed(1)}%, consistency ${consistency.toFixed(0)}%.`,
      });
    }
  }

  return rows;
}

function buildParityCandidates(digits, minimumConfidence) {
  const blended = blendedNextProbabilities(digits);

  return [
    { setup: "EVEN", mode: "EVEN", digits: [0, 2, 4, 6, 8], contractType: "DIGITEVEN" },
    { setup: "ODD", mode: "ODD", digits: [1, 3, 5, 7, 9], contractType: "DIGITODD" },
  ].map((definition) => {
    const probability = definition.digits.reduce(
      (sum, digit) => sum + blended.probabilities[digit],
      0
    );
    const edge = (probability - 0.5) * 100;
    const score = clamp(50 + edge * 1.9 + Math.min(14, blended.transitionSamples), 0, 96);
    const executable =
      digits.length >= 60 &&
      blended.transitionSamples >= 4 &&
      probability >= 0.545 &&
      clamp(65 + edge * 2) >= 70 &&
      score >= minimumConfidence;

    return {
      ...definition,
      probability: probability * 100,
      baselineProbability: 50,
      probabilityEdge: edge,
      expectedValue: edge,
      consistency: clamp(65 + edge * 2),
      stability: clamp(65 + edge * 2),
      qualityScore: score,
      confidence: score,
      sampleSize: digits.length,
      transitionSamples: blended.transitionSamples,
      voteCount: [
        probability >= 0.535,
        score >= minimumConfidence,
        digits.length >= 60,
        blended.transitionSamples >= 4,
      ].filter(Boolean).length,
      totalVotes: 4,
      executable,
      highRisk: false,
      source: blended.source,
      reason: executable
        ? `${definition.setup} qualifies at ${(probability * 100).toFixed(1)}%.`
        : `${definition.setup} scanning at ${(probability * 100).toFixed(1)}%.`,
    };
  });
}

function buildDiffersCandidates(digits, minimumConfidence) {
  const blended = blendedNextProbabilities(digits);

  return DIGITS.map((target) => {
    const targetProbability = blended.probabilities[target];
    const differsProbability = 1 - targetProbability;
    const edge = (differsProbability - 0.9) * 100;
    const score = clamp(
      52 +
        edge * 2.2 +
        Math.min(14, blended.transitionSamples * 0.75),
      0,
      96
    );
    const executable =
      digits.length >= 70 &&
      blended.transitionSamples >= 5 &&
      targetProbability <= 0.075 &&
      differsProbability >= 0.925 &&
      score >= minimumConfidence;

    return {
      setup: `DIFFERS ${target}`,
      mode: "DIFFERS",
      prediction: target,
      contractType: "DIGITDIFF",
      barrier: String(target),
      probability: differsProbability * 100,
      targetProbability: targetProbability * 100,
      baselineProbability: 90,
      probabilityEdge: edge,
      expectedValue: edge,
      consistency: clamp(100 - targetProbability * 250),
      stability: clamp(100 - targetProbability * 250),
      qualityScore: score,
      confidence: score,
      sampleSize: digits.length,
      transitionSamples: blended.transitionSamples,
      voteCount: [
        targetProbability <= 0.085,
        differsProbability >= 0.915,
        digits.length >= 70,
        blended.transitionSamples >= 5,
        score >= minimumConfidence,
      ].filter(Boolean).length,
      totalVotes: 5,
      executable,
      highRisk: false,
      source: blended.source,
      reason: executable
        ? `After digit ${blended.currentDigit ?? "—"}, target ${target} has only ${(targetProbability * 100).toFixed(1)}% estimated return probability.`
        : `DIFFERS ${target} scanning: target return ${(targetProbability * 100).toFixed(1)}%.`,
    };
  });
}

function rankCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    if (Boolean(right.executable) !== Boolean(left.executable)) {
      return Number(right.executable) - Number(left.executable);
    }

    // Prefer low-barrier Over/Under when quality is close.
    const qualityDifference =
      Number(right.qualityScore || 0) -
      Number(left.qualityScore || 0);

    if (Math.abs(qualityDifference) > 2.5) {
      return qualityDifference;
    }

    const leftPriority =
      left.mode === "OVER" || left.mode === "UNDER"
        ? 10 - Number(left.prediction || 0)
        : 0;
    const rightPriority =
      right.mode === "OVER" || right.mode === "UNDER"
        ? 10 - Number(right.prediction || 0)
        : 0;

    return (
      rightPriority - leftPriority ||
      Number(right.probabilityEdge || 0) -
        Number(left.probabilityEdge || 0)
    );
  });
}

export function analyzeUnifiedSignals(input = {}) {
  const digits = digitsFromInput(input);
  const minimumConfidence = clamp(
    input.minimumConfidence ?? 76,
    60,
    95
  );

  const candidates = rankCandidates([
    ...buildOverUnderCandidates(digits, minimumConfidence),
    ...buildParityCandidates(digits, minimumConfidence),
    ...buildDiffersCandidates(digits, minimumConfidence),
  ]);

  const best = candidates.find((candidate) => candidate.executable) || null;

  return {
    digit: {
      candidates,
      best,
      executable: Boolean(best),
      sampleSize: digits.length,
      currentDigit: digits.at(-1) ?? null,
      reason: best
        ? best.reason
        : digits.length < 50
          ? `Collecting fresh digits ${digits.length}/50.`
          : "No digit contract has enough evidence yet. Continue scanning or switch market.",
    },
    riseFall: {
      executable: false,
      signal: "WAIT",
      setup: "WAIT",
      risk: "DISABLED",
      reason: "RISE/FALL is disabled. This build trades digits only.",
      instruction: "Use OVER, UNDER, EVEN, ODD or DIFFERS.",
    },
  };
}

export default analyzeUnifiedSignals;
