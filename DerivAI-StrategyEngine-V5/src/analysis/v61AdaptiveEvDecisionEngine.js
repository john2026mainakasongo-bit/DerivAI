
function clamp(value, minimum = 0, maximum = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function validDigits(values = []) {
  return values
    .map(Number)
    .filter(
      (value) =>
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 9
    );
}

function frequencies(digits = []) {
  const counts = Array.from({ length: 10 }, () => 0);

  for (const digit of digits) {
    counts[digit] += 1;
  }

  const total = Math.max(1, digits.length);
  return counts.map((count) => count / total);
}

function markovNext(digits = []) {
  if (digits.length < 3) {
    return frequencies(digits);
  }

  const matrix = Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => 1)
  );

  for (let index = 1; index < digits.length; index += 1) {
    matrix[digits[index - 1]][digits[index]] += 1;
  }

  const previous = digits[digits.length - 1];
  const row = matrix[previous];
  const total = row.reduce((sum, count) => sum + count, 0);

  return row.map((count) => count / total);
}

function probabilityFor(probabilities, mode, digit = null) {
  if (mode === "MATCH") return probabilities[digit] || 0;
  if (mode === "DIFFERS") return 1 - (probabilities[digit] || 0);

  if (mode === "EVEN") {
    return [0, 2, 4, 6, 8].reduce(
      (sum, value) => sum + (probabilities[value] || 0),
      0
    );
  }

  if (mode === "ODD") {
    return [1, 3, 5, 7, 9].reduce(
      (sum, value) => sum + (probabilities[value] || 0),
      0
    );
  }

  let total = 0;

  for (let value = 0; value <= 9; value += 1) {
    if (mode === "OVER" && value > digit) {
      total += probabilities[value] || 0;
    }

    if (mode === "UNDER" && value < digit) {
      total += probabilities[value] || 0;
    }
  }

  return total;
}

function fairProbability(mode, digit = null) {
  if (mode === "MATCH") return 0.1;
  if (mode === "DIFFERS") return 0.9;
  if (mode === "EVEN" || mode === "ODD") return 0.5;
  if (mode === "OVER") return (9 - Number(digit)) / 10;
  if (mode === "UNDER") return Number(digit) / 10;
  return 0.5;
}

function setupName(mode, digit) {
  if (mode === "EVEN" || mode === "ODD") return mode;
  return `${mode} ${digit}`;
}

function definitions() {
  return [
    ...[1, 2, 3, 4, 5, 6].map((digit) => ({ mode: "OVER", digit })),
    ...[3, 4, 5, 6, 7, 8].map((digit) => ({ mode: "UNDER", digit })),
    { mode: "EVEN", digit: null },
    { mode: "ODD", digit: null },
    ...Array.from({ length: 10 }, (_, digit) => ({
      mode: "MATCH",
      digit,
    })),
    ...Array.from({ length: 10 }, (_, digit) => ({
      mode: "DIFFERS",
      digit,
    })),
  ];
}

function entropyQuality(digits = []) {
  const probabilities = frequencies(digits)
    .filter((value) => value > 0);

  let entropy = 0;

  for (const probability of probabilities) {
    entropy -= probability * Math.log2(probability);
  }

  const maximum = Math.log2(10);

  return maximum
    ? clamp((1 - entropy / maximum) * 100)
    : 0;
}

function adaptiveWindows(digits = []) {
  const requested = [60, 120, 200, 500, 1000];
  const unique = [];

  for (const size of requested) {
    const actual = Math.min(size, digits.length);

    if (actual >= 30 && !unique.includes(actual)) {
      unique.push(actual);
    }
  }

  return unique
    .sort((left, right) => left - right)
    .map((size) => digits.slice(-size));
}

function standardDeviation(values = []) {
  if (!values.length) return 0;

  const mean =
    values.reduce((sum, value) => sum + value, 0) /
    values.length;

  const variance =
    values.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function bayesianProbability(
  observed,
  baseline,
  sampleSize
) {
  // Shrink small samples strongly and relax gradually.
  const priorStrength =
    sampleSize < 80
      ? 240
      : sampleSize < 150
        ? 180
        : sampleSize < 300
          ? 120
          : 80;

  return (
    observed * sampleSize +
    baseline * priorStrength
  ) / (sampleSize + priorStrength);
}

function conservativeExpectedValue(
  probability,
  baseline
) {
  // Uses a conservative 4% payout haircut.
  const multiplier =
    (1 / Math.max(0.01, baseline)) * 0.96;

  return probability * multiplier - 1;
}

function evidenceFor(digits, mode, digit) {
  const windows = adaptiveWindows(digits);

  if (!windows.length) {
    const baseline = fairProbability(mode, digit);

    return {
      probability: baseline,
      transitionProbability: baseline,
      stability: 0,
      entropy: 0,
      windowProbabilities: [],
    };
  }

  const results = windows.map((windowDigits) => {
    const frequency = frequencies(windowDigits);
    const transition = markovNext(windowDigits);

    return {
      size: windowDigits.length,
      frequencyProbability: probabilityFor(
        frequency,
        mode,
        digit
      ),
      transitionProbability: probabilityFor(
        transition,
        mode,
        digit
      ),
      entropy: entropyQuality(windowDigits),
    };
  });

  const weights = results.map((_, index) => {
    // Recent/smaller windows receive more weight.
    return 1 / (index + 1);
  });

  const weightTotal = weights.reduce(
    (sum, value) => sum + value,
    0
  );

  const weighted = (key) =>
    results.reduce(
      (sum, item, index) =>
        sum + item[key] * weights[index],
      0
    ) / weightTotal;

  const blendedProbabilities = results.map(
    (item) =>
      item.frequencyProbability * 0.65 +
      item.transitionProbability * 0.35
  );

  const deviation =
    standardDeviation(blendedProbabilities);

  return {
    probability:
      weighted("frequencyProbability") * 0.65 +
      weighted("transitionProbability") * 0.35,
    transitionProbability: weighted(
      "transitionProbability"
    ),
    stability: clamp((1 - deviation / 0.08) * 100),
    entropy: weighted("entropy"),
    windowProbabilities: results,
  };
}

function scoreCandidate({
  probability,
  baseline,
  transitionProbability,
  stability,
  sampleSize,
  entropy,
  highRisk,
}) {
  const bayesian = bayesianProbability(
    probability,
    baseline,
    sampleSize
  );
  const ev = conservativeExpectedValue(
    bayesian,
    baseline
  );
  const probabilityEdge = bayesian - baseline;
  const transitionEdge =
    transitionProbability - baseline;

  const evComponent = clamp(
    50 + ev * 280
  );
  const probabilityComponent = clamp(
    50 + probabilityEdge * 420
  );
  const transitionComponent = clamp(
    50 + transitionEdge * 320
  );
  const stabilityComponent = clamp(stability);
  const bayesianComponent = clamp(
    50 +
      probabilityEdge *
        Math.min(500, 180 + sampleSize)
  );

  let quality =
    evComponent * 0.4 +
    probabilityComponent * 0.25 +
    transitionComponent * 0.15 +
    stabilityComponent * 0.1 +
    bayesianComponent * 0.1;

  // Entropy is a veto/penalty, not an artificial source of confidence.
  if (entropy < 3) {
    quality -= 8;
  }

  if (highRisk) {
    quality -= 14;
    quality = Math.min(84, quality);
  } else {
    quality = Math.min(95, quality);
  }

  return {
    bayesian,
    ev,
    probabilityEdge,
    transitionEdge,
    quality: clamp(quality),
    components: {
      expectedValue: evComponent,
      probabilityEdge: probabilityComponent,
      transition: transitionComponent,
      stability: stabilityComponent,
      bayesian: bayesianComponent,
    },
  };
}

export function rankV61DigitContracts({
  digitHistory = [],
  allowHighRisk = false,
  minimumQuality = 75,
} = {}) {
  const digits = validDigits(digitHistory);
  const sampleSize = digits.length;

  if (sampleSize < 30) {
    return {
      ready: false,
      sampleSize,
      reason: `Collecting live digits: ${sampleSize}/30.`,
      best: null,
      candidates: [],
    };
  }

  const candidates = definitions().map(
    ({ mode, digit }) => {
      const baseline = fairProbability(mode, digit);
      const evidence = evidenceFor(
        digits,
        mode,
        digit
      );
      const highRisk =
        mode === "MATCH" ||
        mode === "DIFFERS";

      const score = scoreCandidate({
        probability: evidence.probability,
        baseline,
        transitionProbability:
          evidence.transitionProbability,
        stability: evidence.stability,
        sampleSize,
        entropy: evidence.entropy,
        highRisk,
      });

      const sampleRequirement =
        highRisk ? 400 : 60;
      const minimumEv =
        highRisk ? 0.12 : 0.015;
      const minimumEdge =
        highRisk ? 0.035 : 0.012;
      const minimumStability =
        sampleSize < 120 ? 68 : 60;

      const executable =
        sampleSize >= sampleRequirement &&
        score.ev >= minimumEv &&
        score.probabilityEdge >= minimumEdge &&
        evidence.stability >= minimumStability &&
        score.quality >= minimumQuality &&
        (!highRisk || allowHighRisk);

      return {
        setup: setupName(mode, digit),
        mode,
        digit,
        highRisk,
        sampleSize,
        probability: score.bayesian * 100,
        rawProbability:
          evidence.probability * 100,
        baseline: baseline * 100,
        expectedValue: score.ev * 100,
        probabilityEdge:
          score.probabilityEdge * 100,
        transitionEdge:
          score.transitionEdge * 100,
        consistency: evidence.stability,
        entropyQuality: evidence.entropy,
        qualityScore: score.quality,
        components: score.components,
        executable,
        source: "V61 ADAPTIVE EV",
        detail:
          `${setupName(mode, digit)} · ` +
          `EV ${score.ev >= 0 ? "+" : ""}` +
          `${(score.ev * 100).toFixed(1)}% · ` +
          `edge ${(score.probabilityEdge * 100).toFixed(1)}% · ` +
          `stability ${evidence.stability.toFixed(1)}%.`,
      };
    }
  );

  candidates.sort((left, right) => {
    if (left.executable !== right.executable) {
      return left.executable ? -1 : 1;
    }

    const leftRiskPenalty =
      left.highRisk ? 10 : 0;
    const rightRiskPenalty =
      right.highRisk ? 10 : 0;

    return (
      right.qualityScore -
        rightRiskPenalty -
        (left.qualityScore - leftRiskPenalty) ||
      right.expectedValue -
        left.expectedValue ||
      right.consistency -
        left.consistency
    );
  });

  const best =
    candidates.find(
      (candidate) => candidate.executable
    ) || null;

  return {
    ready: sampleSize >= 60,
    sampleSize,
    reason: best
      ? "EXECUTE: EV, edge, transition, stability and Bayesian confidence passed."
      : sampleSize < 60
        ? `Warm-up: ${sampleSize}/60 ticks.`
        : "WAIT: no contract passes the adaptive EV decision gate.",
    best,
    candidates,
  };
}
