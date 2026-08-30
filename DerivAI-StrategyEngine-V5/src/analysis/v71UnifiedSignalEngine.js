
const DIGITS = Array.from({ length: 10 }, (_, index) => index);
const OVER_BARRIERS = [1, 2, 3, 4, 5, 6, 7];
const UNDER_BARRIERS = [1, 2, 3, 4, 5, 6, 7];

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function variance(values = []) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return mean(values.map((value) => (Number(value) - average) ** 2));
}

function stdDev(values = []) {
  return Math.sqrt(variance(values));
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
    .slice(-500);
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

  return digits.slice(-500);
}

function countsOf(digits = []) {
  const counts = Array(10).fill(0);
  digits.forEach((digit) => {
    counts[digit] += 1;
  });
  return counts;
}

function smoothedProbabilities(digits = [], alpha = 1.5) {
  const counts = countsOf(digits);
  const denominator = digits.length + alpha * 10;

  return counts.map(
    (count) => (count + alpha) / Math.max(1, denominator)
  );
}

function transitionTable(digits = []) {
  const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
  const totals = Array(10).fill(0);

  for (let index = 1; index < digits.length; index += 1) {
    const from = digits[index - 1];
    const to = digits[index];
    matrix[from][to] += 1;
    totals[from] += 1;
  }

  return { matrix, totals };
}

function calibratedNextModel(digits = []) {
  const currentDigit = digits.at(-1);
  const global = smoothedProbabilities(digits, 1.5);
  const transitions = transitionTable(digits);
  const transitionSamples =
    Number.isInteger(currentDigit) ? transitions.totals[currentDigit] : 0;

  if (!Number.isInteger(currentDigit) || transitionSamples < 8) {
    return {
      probabilities: global,
      currentDigit,
      transitionSamples,
      source: "GLOBAL_ONLY",
      calibrationPenalty: transitionSamples < 4 ? 12 : 7,
    };
  }

  const row = transitions.matrix[currentDigit];
  const rowProbabilities = row.map(
    (count) => (count + 1.5) / (transitionSamples + 15)
  );

  const transitionWeight = clamp(
    28 + transitionSamples * 2.1,
    28,
    68
  ) / 100;

  const probabilities = rowProbabilities.map(
    (probability, digit) =>
      probability * transitionWeight +
      global[digit] * (1 - transitionWeight)
  );

  return {
    probabilities,
    currentDigit,
    transitionSamples,
    source: "CALIBRATED_TRANSITION_BLEND",
    calibrationPenalty: Math.max(0, 9 - transitionSamples * 0.22),
  };
}

function modelForWindow(digits, size) {
  const window = digits.slice(-Math.min(size, digits.length));
  return {
    size: window.length,
    ...calibratedNextModel(window),
  };
}

function windowModels(digits = []) {
  return [60, 120, 240]
    .filter((size) => digits.length >= Math.min(60, size))
    .map((size) => modelForWindow(digits, size));
}

function sumProbability(probabilities, predicate) {
  return probabilities.reduce(
    (sum, probability, digit) =>
      sum + (predicate(digit) ? probability : 0),
    0
  );
}

function overUnderProbability(probabilities, mode, barrier) {
  return sumProbability(
    probabilities,
    mode === "OVER"
      ? (digit) => digit > barrier
      : (digit) => digit < barrier
  );
}

function naturalProbability(mode, barrier) {
  return mode === "OVER"
    ? (9 - barrier) / 10
    : barrier / 10;
}

function wilsonLowerBound(successes, samples, z = 1.64) {
  if (!samples) return 0;
  const rate = successes / samples;
  const z2 = z * z;
  const denominator = 1 + z2 / samples;
  const center = rate + z2 / (2 * samples);
  const margin =
    z *
    Math.sqrt(
      (rate * (1 - rate) + z2 / (4 * samples)) / samples
    );

  return Math.max(0, (center - margin) / denominator);
}

function historicalHitRate(digits, candidate, lookback = 300) {
  const sample = digits.slice(-lookback);
  if (sample.length < 80) {
    return {
      samples: 0,
      wins: 0,
      hitRate: 0,
      lowerBound: 0,
    };
  }

  let wins = 0;
  let samples = 0;

  for (let index = 60; index < sample.length; index += 1) {
    const previousWindow = sample.slice(Math.max(0, index - 120), index);
    const nextDigit = sample[index];
    const model = calibratedNextModel(previousWindow);

    if (model.transitionSamples < 5) continue;

    samples += 1;

    if (candidate.mode === "OVER") {
      if (nextDigit > candidate.prediction) wins += 1;
    } else if (candidate.mode === "UNDER") {
      if (nextDigit < candidate.prediction) wins += 1;
    } else if (candidate.mode === "EVEN") {
      if (nextDigit % 2 === 0) wins += 1;
    } else if (candidate.mode === "ODD") {
      if (nextDigit % 2 === 1) wins += 1;
    } else if (candidate.mode === "DIFFERS") {
      if (nextDigit !== candidate.prediction) wins += 1;
    }
  }

  return {
    samples,
    wins,
    hitRate: samples ? wins / samples : 0,
    lowerBound: wilsonLowerBound(wins, samples),
  };
}

function calibratedScore({
  probability,
  baseline,
  consistency,
  sampleSize,
  transitionSamples,
  historical,
  penalty = 0,
  priority = 0,
}) {
  const edgePct = (probability - baseline) * 100;
  const historicalEdgePct =
    (historical.lowerBound - baseline) * 100;

  return clamp(
    44 +
      edgePct * 1.25 +
      Math.max(0, historicalEdgePct) * 1.8 +
      consistency * 0.18 +
      Math.min(12, sampleSize / 18) +
      Math.min(10, transitionSamples / 2.5) +
      priority -
      penalty,
    0,
    94
  );
}

function overUnderCandidates(digits, minimumConfidence) {
  const primary = calibratedNextModel(digits);
  const windows = windowModels(digits);
  const candidates = [];

  for (const mode of ["OVER", "UNDER"]) {
    const barriers = mode === "OVER" ? OVER_BARRIERS : UNDER_BARRIERS;

    for (const barrier of barriers) {
      const probability = overUnderProbability(
        primary.probabilities,
        mode,
        barrier
      );
      const baseline = naturalProbability(mode, barrier);
      const windowValues = windows.map((window) =>
        overUnderProbability(window.probabilities, mode, barrier)
      );
      const consistency = clamp(
        100 - stdDev(windowValues.map((value) => value * 100)) * 8
      );
      const edge = (probability - baseline) * 100;

      const prototype = {
        mode,
        prediction: barrier,
      };
      const historical = historicalHitRate(digits, prototype);

      const lowerBarrierPriority =
        mode === "OVER"
          ? Math.max(-5, 5 - barrier * 1.1)
          : Math.max(-5, 1.5 - Math.abs(barrier - 6) * 0.6);

      const qualityScore = calibratedScore({
        probability,
        baseline,
        consistency,
        sampleSize: digits.length,
        transitionSamples: primary.transitionSamples,
        historical,
        penalty: primary.calibrationPenalty,
        priority: lowerBarrierPriority,
      });

      const coreBarrier =
        (mode === "OVER" && barrier <= 3) ||
        (mode === "UNDER" && barrier >= 5);

      const highBarrierEvidence =
        historical.samples >= 180 &&
        historical.lowerBound >= baseline + 0.025 &&
        consistency >= 80 &&
        primary.transitionSamples >= 12;

      const executable =
        digits.length >= 100 &&
        primary.transitionSamples >= 8 &&
        probability >= baseline + 0.02 &&
        edge >= 2 &&
        consistency >= 72 &&
        historical.samples >= 80 &&
        historical.lowerBound >= baseline + 0.01 &&
        qualityScore >= minimumConfidence &&
        (coreBarrier || highBarrierEvidence);

      candidates.push({
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
        qualityScore,
        confidence: qualityScore,
        sampleSize: digits.length,
        transitionSamples: primary.transitionSamples,
        historicalSamples: historical.samples,
        historicalHitRate: historical.hitRate * 100,
        historicalLowerBound: historical.lowerBound * 100,
        voteCount: [
          probability >= baseline + 0.02,
          consistency >= 72,
          historical.samples >= 80,
          historical.lowerBound >= baseline + 0.01,
          primary.transitionSamples >= 8,
        ].filter(Boolean).length,
        totalVotes: 5,
        executable,
        highRisk: !coreBarrier,
        source: primary.source,
        reason: executable
          ? `${mode} ${barrier} calibrated: ${(probability * 100).toFixed(1)}%, lower bound ${(historical.lowerBound * 100).toFixed(1)}%.`
          : `${mode} ${barrier} waiting: model ${(probability * 100).toFixed(1)}%, history ${(historical.lowerBound * 100).toFixed(1)}%, stability ${consistency.toFixed(0)}%.`,
      });
    }
  }

  return candidates;
}

function parityCandidates(digits, minimumConfidence) {
  const primary = calibratedNextModel(digits);

  return [
    { setup: "EVEN", mode: "EVEN", digits: [0, 2, 4, 6, 8], contractType: "DIGITEVEN" },
    { setup: "ODD", mode: "ODD", digits: [1, 3, 5, 7, 9], contractType: "DIGITODD" },
  ].map((definition) => {
    const probability = definition.digits.reduce(
      (sum, digit) => sum + primary.probabilities[digit],
      0
    );
    const historical = historicalHitRate(digits, definition);
    const edge = (probability - 0.5) * 100;
    const consistency = clamp(
      70 + edge * 1.4 - primary.calibrationPenalty
    );
    const qualityScore = calibratedScore({
      probability,
      baseline: 0.5,
      consistency,
      sampleSize: digits.length,
      transitionSamples: primary.transitionSamples,
      historical,
      penalty: primary.calibrationPenalty,
    });

    const executable =
      digits.length >= 120 &&
      primary.transitionSamples >= 10 &&
      probability >= 0.55 &&
      historical.samples >= 100 &&
      historical.lowerBound >= 0.52 &&
      consistency >= 74 &&
      qualityScore >= minimumConfidence;

    return {
      ...definition,
      probability: probability * 100,
      baselineProbability: 50,
      probabilityEdge: edge,
      expectedValue: edge,
      consistency,
      stability: consistency,
      qualityScore,
      confidence: qualityScore,
      sampleSize: digits.length,
      transitionSamples: primary.transitionSamples,
      historicalSamples: historical.samples,
      historicalHitRate: historical.hitRate * 100,
      historicalLowerBound: historical.lowerBound * 100,
      voteCount: [
        probability >= 0.55,
        historical.lowerBound >= 0.52,
        consistency >= 74,
        digits.length >= 120,
      ].filter(Boolean).length,
      totalVotes: 4,
      executable,
      highRisk: false,
      source: primary.source,
      reason: executable
        ? `${definition.setup} calibrated at ${(probability * 100).toFixed(1)}%.`
        : `${definition.setup} waiting at ${(probability * 100).toFixed(1)}%.`,
    };
  });
}

function differsCandidates(digits, minimumConfidence) {
  const primary = calibratedNextModel(digits);

  return DIGITS.map((target) => {
    const targetProbability = primary.probabilities[target];
    const probability = 1 - targetProbability;
    const baseline = 0.9;
    const prototype = {
      mode: "DIFFERS",
      prediction: target,
    };
    const historical = historicalHitRate(digits, prototype);
    const consistency = clamp(
      100 -
        targetProbability * 240 -
        primary.calibrationPenalty
    );
    const qualityScore = calibratedScore({
      probability,
      baseline,
      consistency,
      sampleSize: digits.length,
      transitionSamples: primary.transitionSamples,
      historical,
      penalty: primary.calibrationPenalty + 4,
    });

    const executable =
      digits.length >= 160 &&
      primary.transitionSamples >= 12 &&
      targetProbability <= 0.07 &&
      probability >= 0.93 &&
      historical.samples >= 140 &&
      historical.lowerBound >= 0.91 &&
      consistency >= 82 &&
      qualityScore >= Math.max(88, minimumConfidence);

    return {
      setup: `DIFFERS ${target}`,
      mode: "DIFFERS",
      prediction: target,
      contractType: "DIGITDIFF",
      barrier: String(target),
      probability: probability * 100,
      targetProbability: targetProbability * 100,
      baselineProbability: 90,
      probabilityEdge: (probability - baseline) * 100,
      expectedValue: (probability - baseline) * 100,
      consistency,
      stability: consistency,
      qualityScore,
      confidence: qualityScore,
      sampleSize: digits.length,
      transitionSamples: primary.transitionSamples,
      historicalSamples: historical.samples,
      historicalHitRate: historical.hitRate * 100,
      historicalLowerBound: historical.lowerBound * 100,
      voteCount: [
        targetProbability <= 0.07,
        historical.lowerBound >= 0.91,
        primary.transitionSamples >= 12,
        consistency >= 82,
        digits.length >= 160,
      ].filter(Boolean).length,
      totalVotes: 5,
      executable,
      highRisk: false,
      source: primary.source,
      reason: executable
        ? `After ${primary.currentDigit ?? "—"}, digit ${target} return estimate ${(targetProbability * 100).toFixed(1)}%; historical lower bound ${(historical.lowerBound * 100).toFixed(1)}%.`
        : `DIFFERS ${target} waiting: return ${(targetProbability * 100).toFixed(1)}%, lower bound ${(historical.lowerBound * 100).toFixed(1)}%.`,
    };
  });
}

function rankCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    if (Boolean(right.executable) !== Boolean(left.executable)) {
      return Number(right.executable) - Number(left.executable);
    }

    const historyDifference =
      Number(right.historicalLowerBound || 0) -
      Number(left.historicalLowerBound || 0);

    if (Math.abs(historyDifference) >= 0.8) {
      return historyDifference;
    }

    const qualityDifference =
      Number(right.qualityScore || 0) -
      Number(left.qualityScore || 0);

    if (Math.abs(qualityDifference) >= 1.5) {
      return qualityDifference;
    }

    const leftPriority =
      left.mode === "OVER"
        ? 8 - Number(left.prediction || 0)
        : left.mode === "UNDER"
          ? Number(left.prediction || 0)
          : 0;

    const rightPriority =
      right.mode === "OVER"
        ? 8 - Number(right.prediction || 0)
        : right.mode === "UNDER"
          ? Number(right.prediction || 0)
          : 0;

    return rightPriority - leftPriority;
  });
}

export function analyzeUnifiedSignals(input = {}) {
  const digits = digitsFromInput(input);
  const minimumConfidence = clamp(
    input.minimumConfidence ?? 88,
    70,
    95
  );

  const candidates = rankCandidates([
    ...overUnderCandidates(digits, minimumConfidence),
    ...parityCandidates(digits, minimumConfidence),
    ...differsCandidates(digits, minimumConfidence),
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
        : digits.length < 100
          ? `Collecting calibrated history ${digits.length}/100.`
          : "No calibrated digit entry. Continue scanning or switch market.",
    },
    riseFall: {
      executable: false,
      signal: "WAIT",
      setup: "WAIT",
      risk: "DISABLED",
      reason: "RISE/FALL is disabled in V52.",
      instruction: "Use calibrated digit contracts only.",
    },
  };
}

export default analyzeUnifiedSignals;
