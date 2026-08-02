
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

function frequencyDistribution(digits = []) {
  const counts = Array.from({ length: 10 }, () => 1);
  for (const digit of digits) counts[digit] += 1;

  const total = counts.reduce((sum, value) => sum + value, 0);
  return counts.map((value) => value / total);
}

function nextDigitDistribution(digits = []) {
  if (digits.length < 3) {
    return frequencyDistribution(digits);
  }

  const matrix = Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => 1)
  );

  for (let index = 1; index < digits.length; index += 1) {
    matrix[digits[index - 1]][digits[index]] += 1;
  }

  const previous = digits[digits.length - 1];
  const row = matrix[previous];
  const total = row.reduce((sum, value) => sum + value, 0);

  return row.map((value) => value / total);
}

function probabilityFor(distribution, mode, digit = null) {
  if (mode === "MATCH") return distribution[digit] || 0;
  if (mode === "DIFFERS") return 1 - (distribution[digit] || 0);

  if (mode === "EVEN") {
    return [0, 2, 4, 6, 8].reduce(
      (sum, value) => sum + (distribution[value] || 0),
      0
    );
  }

  if (mode === "ODD") {
    return [1, 3, 5, 7, 9].reduce(
      (sum, value) => sum + (distribution[value] || 0),
      0
    );
  }

  let total = 0;

  for (let value = 0; value <= 9; value += 1) {
    if (mode === "OVER" && value > digit) {
      total += distribution[value] || 0;
    }

    if (mode === "UNDER" && value < digit) {
      total += distribution[value] || 0;
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

function contractName(mode, digit) {
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

function adaptiveWindows(digits = []) {
  const sizes = [30, 60, 120, 240];
  return sizes
    .map((size) => digits.slice(-Math.min(size, digits.length)))
    .filter(
      (windowDigits, index, array) =>
        windowDigits.length >= 20 &&
        array.findIndex(
          (item) => item.length === windowDigits.length
        ) === index
    );
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

function candidateEvidence(digits, mode, digit) {
  const windows = adaptiveWindows(digits);

  if (!windows.length) {
    const baseline = fairProbability(mode, digit);

    return {
      observed: baseline,
      transition: baseline,
      stability: 0,
      windowCount: 0,
    };
  }

  const rows = windows.map((windowDigits) => {
    const frequency = frequencyDistribution(windowDigits);
    const transition = nextDigitDistribution(windowDigits);

    return {
      observed: probabilityFor(frequency, mode, digit),
      transition: probabilityFor(transition, mode, digit),
      size: windowDigits.length,
    };
  });

  const weights = rows.map((_, index) => 1 / (index + 1));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);

  const weighted = (field) =>
    rows.reduce(
      (sum, row, index) => sum + row[field] * weights[index],
      0
    ) / totalWeight;

  const blended = rows.map(
    (row) => row.observed * 0.65 + row.transition * 0.35
  );

  return {
    observed: weighted("observed"),
    transition: weighted("transition"),
    stability: clamp(
      (1 - standardDeviation(blended) / 0.07) * 100
    ),
    windowCount: rows.length,
  };
}

function bayesianShrink(observed, baseline, sampleSize) {
  const prior =
    sampleSize < 50
      ? 180
      : sampleSize < 100
        ? 120
        : 80;

  return (
    observed * sampleSize +
    baseline * prior
  ) / (sampleSize + prior);
}

function expectedValue(probability, baseline) {
  const conservativeMultiplier =
    (1 / Math.max(0.01, baseline)) * 0.96;

  return probability * conservativeMultiplier - 1;
}

export function rankV62Contracts({
  digitHistory = [],
  allowHighRisk = false,
  minimumConfidence = 75,
} = {}) {
  const digits = validDigits(digitHistory);
  const sampleSize = digits.length;

  if (sampleSize < 20) {
    return {
      ready: false,
      sampleSize,
      best: null,
      candidates: [],
      reason: `Warm-up: ${sampleSize}/20 live digits.`,
    };
  }

  const candidates = definitions().map(({ mode, digit }) => {
    const baseline = fairProbability(mode, digit);
    const evidence = candidateEvidence(digits, mode, digit);
    const blendedObserved =
      evidence.observed * 0.65 +
      evidence.transition * 0.35;

    const probability = bayesianShrink(
      blendedObserved,
      baseline,
      sampleSize
    );

    const edge = probability - baseline;
    const ev = expectedValue(probability, baseline);
    const highRisk = mode === "MATCH" || mode === "DIFFERS";

    // Decision confidence is derived from actual evidence.
    // It is never allowed to display artificial certainty.
    let decisionConfidence =
      50 +
      ev * 260 +
      edge * 360 +
      (evidence.stability - 50) * 0.16;

    if (highRisk) {
      decisionConfidence -= 14;
      decisionConfidence = Math.min(84, decisionConfidence);
    } else {
      decisionConfidence = Math.min(95, decisionConfidence);
    }

    decisionConfidence = clamp(decisionConfidence);

    const sampleMinimum = highRisk ? 400 : 60;
    const evMinimum = highRisk ? 0.14 : 0.025;
    const edgeMinimum = highRisk ? 0.04 : 0.018;
    const stabilityMinimum = highRisk ? 80 : 68;

    const executable =
      sampleSize >= sampleMinimum &&
      ev >= evMinimum &&
      edge >= edgeMinimum &&
      evidence.stability >= stabilityMinimum &&
      decisionConfidence >= minimumConfidence &&
      (!highRisk || allowHighRisk);

    return {
      setup: contractName(mode, digit),
      mode,
      digit,
      highRisk,
      sampleSize,
      probability: probability * 100,
      baseline: baseline * 100,
      probabilityEdge: edge * 100,
      expectedValue: ev * 100,
      transitionProbability: evidence.transition * 100,
      consistency: evidence.stability,
      qualityScore: decisionConfidence,
      confidence: decisionConfidence,
      executable,
      source: "V62 FRESH CONTRACT RANKING",
      detail:
        `${contractName(mode, digit)} · probability ` +
        `${(probability * 100).toFixed(1)}% · EV ` +
        `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% · ` +
        `stability ${evidence.stability.toFixed(1)}%.`,
    };
  });

  // Executable candidates first, then strongest EV evidence.
  candidates.sort((left, right) => {
    if (left.executable !== right.executable) {
      return left.executable ? -1 : 1;
    }

    const leftRiskPenalty = left.highRisk ? 8 : 0;
    const rightRiskPenalty = right.highRisk ? 8 : 0;

    return (
      right.expectedValue - left.expectedValue ||
      right.probabilityEdge - left.probabilityEdge ||
      right.consistency - left.consistency ||
      right.qualityScore -
        rightRiskPenalty -
        (left.qualityScore - leftRiskPenalty)
    );
  });

  const best =
    candidates.find((candidate) => candidate.executable) ||
    null;

  return {
    ready: sampleSize >= 60,
    sampleSize,
    candidates,
    best,
    reason: best
      ? `EXECUTE ${best.setup}: strongest current EV evidence.`
      : sampleSize < 60
        ? `Collecting strict evidence: ${sampleSize}/60.`
        : "WAIT: no contract currently passes EV, edge and stability filters.",
  };
}
