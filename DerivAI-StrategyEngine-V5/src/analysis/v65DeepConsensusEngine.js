
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
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "MATCH", digit })),
    ...Array.from({ length: 10 }, (_, digit) => ({ mode: "DIFFERS", digit })),
  ];
}

function fairProbability(mode, digit = null) {
  if (mode === "MATCH") return 0.1;
  if (mode === "DIFFERS") return 0.9;
  if (mode === "EVEN" || mode === "ODD") return 0.5;
  if (mode === "OVER") return (9 - Number(digit)) / 10;
  if (mode === "UNDER") return Number(digit) / 10;
  return 0.5;
}

function wins(value, mode, digit = null) {
  if (mode === "MATCH") return value === digit;
  if (mode === "DIFFERS") return value !== digit;
  if (mode === "EVEN") return value % 2 === 0;
  if (mode === "ODD") return value % 2 === 1;
  if (mode === "OVER") return value > digit;
  if (mode === "UNDER") return value < digit;
  return false;
}

function rawProbability(digits, mode, digit = null) {
  if (!digits.length) return fairProbability(mode, digit);
  return digits.filter((value) => wins(value, mode, digit)).length / digits.length;
}

function weightedProbability(digits, mode, digit = null) {
  if (!digits.length) return fairProbability(mode, digit);

  let total = 0;
  let winTotal = 0;
  let weight = 1;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (wins(digits[index], mode, digit)) {
      winTotal += weight;
    }
    total += weight;
    weight *= 0.975;
  }

  return total ? winTotal / total : fairProbability(mode, digit);
}

function transitionProbability(digits, mode, digit = null) {
  if (digits.length < 8) return fairProbability(mode, digit);

  const last = digits[digits.length - 1];
  let total = 0;
  let winTotal = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index - 1] !== last) continue;
    total += 1;
    if (wins(digits[index], mode, digit)) winTotal += 1;
  }

  return total ? (winTotal + 1) / (total + 2) : rawProbability(digits, mode, digit);
}

function streakScore(digits, mode, digit = null) {
  let streak = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (!wins(digits[index], mode, digit)) break;
    streak += 1;
  }

  return clamp(50 + Math.min(streak, 6) * 7);
}

function reversalScore(digits, mode, digit = null) {
  if (digits.length < 12) return 50;

  const recent = digits.slice(-12);
  const first = rawProbability(recent.slice(0, 6), mode, digit);
  const second = rawProbability(recent.slice(6), mode, digit);

  return clamp(50 + (second - first) * 180);
}

function stability(digits, mode, digit = null) {
  const windows = [20, 50, 100, 200]
    .map((size) => digits.slice(-Math.min(size, digits.length)))
    .filter((window) => window.length >= 15);

  if (!windows.length) return 0;

  const values = windows.map((window) => rawProbability(window, mode, digit));
  const max = Math.max(...values);
  const min = Math.min(...values);

  return clamp((1 - (max - min) / 0.14) * 100);
}

function autocorrelation(digits, lag = 1) {
  if (digits.length < lag + 15) return 0;

  const x = digits.slice(lag);
  const y = digits.slice(0, -lag);
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;

  let numerator = 0;
  let denominatorX = 0;
  let denominatorY = 0;

  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    numerator += dx * dy;
    denominatorX += dx * dx;
    denominatorY += dy * dy;
  }

  const denominator = Math.sqrt(denominatorX * denominatorY);
  return denominator ? numerator / denominator : 0;
}

function chiSquareDeviation(digits) {
  if (digits.length < 30) return 0;

  const counts = Array.from({ length: 10 }, () => 0);
  digits.forEach((digit) => {
    counts[digit] += 1;
  });

  const expected = digits.length / 10;
  let chi = 0;

  counts.forEach((count) => {
    chi += ((count - expected) ** 2) / Math.max(1, expected);
  });

  return clamp(chi * 5.5);
}

function entropyQuality(digits) {
  if (digits.length < 20) return 0;

  const counts = Array.from({ length: 10 }, () => 0);
  digits.forEach((digit) => {
    counts[digit] += 1;
  });

  const total = digits.length;
  let entropy = 0;

  counts.forEach((count) => {
    if (!count) return;
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  });

  const maximum = Math.log2(10);
  return maximum ? clamp((1 - entropy / maximum) * 100) : 0;
}

function bayesianProbability(observed, baseline, samples) {
  const prior =
    samples < 60 ? 160 :
    samples < 120 ? 110 :
    75;

  return (
    observed * samples +
    baseline * prior
  ) / (samples + prior);
}

function conservativeEv(probability, baseline) {
  const multiplier = (1 / Math.max(0.01, baseline)) * 0.94;
  return probability * multiplier - 1;
}

function walkForwardBacktest(digits, mode, digit = null) {
  if (digits.length < 60) {
    return {
      trades: 0,
      winRate: 0,
      profitUnits: 0,
      passed: false,
    };
  }

  const test = digits.slice(-Math.min(180, digits.length));
  const baseline = fairProbability(mode, digit);
  const payout = (1 / Math.max(0.01, baseline)) * 0.94;

  let winsCount = 0;

  test.forEach((value) => {
    if (wins(value, mode, digit)) winsCount += 1;
  });

  const lossesCount = test.length - winsCount;
  const profitUnits = winsCount * (payout - 1) - lossesCount;
  const winRate = winsCount / test.length;

  return {
    trades: test.length,
    winRate: winRate * 100,
    profitUnits,
    passed:
      profitUnits >= 2 &&
      winRate >= baseline + 0.018,
  };
}

function windowAgreement(digits, mode, digit = null) {
  const windows = [20, 50, 100, 200]
    .map((size) => digits.slice(-Math.min(size, digits.length)))
    .filter((window) => window.length >= 15);

  const baseline = fairProbability(mode, digit);
  const positive = windows.filter(
    (window) => rawProbability(window, mode, digit) > baseline
  ).length;

  return {
    count: positive,
    total: windows.length,
    passed: windows.length >= 3 && positive >= 3,
  };
}

export function rankV65DeepConsensus({
  digitHistory = [],
  allowHighRisk = false,
  minimumConfidence = 84,
} = {}) {
  const digits = validDigits(digitHistory);
  const sampleSize = digits.length;

  if (sampleSize < 35) {
    return {
      ready: false,
      sampleSize,
      best: null,
      candidates: [],
      reason: `Deep warm-up: ${sampleSize}/35 ticks.`,
    };
  }

  const recent = digits.slice(-Math.min(240, digits.length));
  const auto1 = Math.abs(autocorrelation(recent, 1));
  const auto2 = Math.abs(autocorrelation(recent, 2));
  const chi = chiSquareDeviation(recent);
  const entropy = entropyQuality(recent);

  const candidates = definitions().map(({ mode, digit }) => {
    const baseline = fairProbability(mode, digit);
    const highRisk = mode === "MATCH" || mode === "DIFFERS";

    const p20 = weightedProbability(digits.slice(-20), mode, digit);
    const p50 = weightedProbability(digits.slice(-50), mode, digit);
    const p100 = weightedProbability(digits.slice(-100), mode, digit);
    const p200 = weightedProbability(digits.slice(-200), mode, digit);
    const transition = transitionProbability(recent, mode, digit);

    const observed =
      p20 * 0.35 +
      p50 * 0.25 +
      p100 * 0.18 +
      p200 * 0.12 +
      transition * 0.10;

    const probability = bayesianProbability(observed, baseline, sampleSize);
    const edge = probability - baseline;
    const ev = conservativeEv(probability, baseline);
    const stable = stability(digits, mode, digit);
    const streak = streakScore(digits, mode, digit);
    const reversal = reversalScore(digits, mode, digit);
    const backtest = walkForwardBacktest(digits, mode, digit);
    const agreement = windowAgreement(digits, mode, digit);

    const autocorrelationScore = clamp(50 + auto1 * 130 + auto2 * 90);
    const distributionScore = clamp(50 + chi * 0.5);
    const entropyScore = clamp(50 + entropy * 0.5);

    const checks = [
      { name: "20-tick probability", pass: p20 > baseline + (highRisk ? 0.04 : 0.014) },
      { name: "50-tick probability", pass: p50 > baseline + (highRisk ? 0.035 : 0.012) },
      { name: "100-tick probability", pass: p100 > baseline + (highRisk ? 0.03 : 0.01) },
      { name: "200-tick probability", pass: p200 > baseline + (highRisk ? 0.025 : 0.008) },
      { name: "Expected value", pass: ev >= (highRisk ? 0.14 : 0.025) },
      { name: "Probability edge", pass: edge >= (highRisk ? 0.04 : 0.018) },
      { name: "Markov transition", pass: transition > baseline + (highRisk ? 0.04 : 0.015) },
      { name: "Window agreement", pass: agreement.passed },
      { name: "Stability", pass: stable >= (highRisk ? 80 : 70) },
      { name: "Streak behaviour", pass: streak >= 58 },
      { name: "Reversal control", pass: reversal >= 48 },
      { name: "Autocorrelation", pass: autocorrelationScore >= 58 },
      { name: "Backtest validation", pass: backtest.passed },
    ];

    const voteCount = checks.filter((check) => check.pass).length;

    let confidence =
      56 +
      ev * 170 +
      edge * 250 +
      (stable - 50) * 0.15 +
      (voteCount - 6) * 3.5 +
      (backtest.passed ? 8 : 0) +
      (agreement.passed ? 5 : 0);

    if (distributionScore < 52 || entropyScore < 52) {
      confidence -= 6;
    }

    if (highRisk) {
      confidence -= 14;
      confidence = Math.min(86, confidence);
    } else {
      confidence = Math.min(96, confidence);
    }

    confidence = clamp(confidence);

    const requiredVotes = highRisk ? 12 : 10;

    const executable =
      voteCount >= requiredVotes &&
      ev >= (highRisk ? 0.14 : 0.025) &&
      edge >= (highRisk ? 0.04 : 0.018) &&
      stable >= (highRisk ? 80 : 70) &&
      backtest.passed &&
      agreement.passed &&
      confidence >= minimumConfidence &&
      (!highRisk || allowHighRisk);

    return {
      setup: setupName(mode, digit),
      mode,
      digit,
      highRisk,
      sampleSize,
      probability: probability * 100,
      baseline: baseline * 100,
      probabilityEdge: edge * 100,
      expectedValue: ev * 100,
      transitionProbability: transition * 100,
      consistency: stable,
      qualityScore: confidence,
      confidence,
      voteCount,
      totalVotes: checks.length,
      passedChecks: checks.filter((check) => check.pass).map((check) => check.name),
      failedChecks: checks.filter((check) => !check.pass).map((check) => check.name),
      backtestTrades: backtest.trades,
      backtestWinRate: backtest.winRate,
      backtestProfitUnits: backtest.profitUnits,
      executable,
      source: "V65 DEEP CONSENSUS",
      detail:
        `${setupName(mode, digit)} · ${voteCount}/${checks.length} consensus · ` +
        `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% · ` +
        `BT ${backtest.winRate.toFixed(1)}%.`,
    };
  });

  candidates.sort((left, right) => {
    if (left.executable !== right.executable) {
      return left.executable ? -1 : 1;
    }

    return (
      right.voteCount - left.voteCount ||
      right.backtestProfitUnits - left.backtestProfitUnits ||
      right.expectedValue - left.expectedValue ||
      right.qualityScore - left.qualityScore
    );
  });

  const best =
    candidates.find((candidate) => candidate.executable) || null;

  return {
    ready: sampleSize >= 60,
    sampleSize,
    best,
    candidates,
    reason: best
      ? `EXECUTE ${best.setup}: ${best.voteCount}/${best.totalVotes} deep checks agree.`
      : sampleSize < 60
        ? `Building one-minute evidence: ${sampleSize}/60.`
        : "WAIT: fewer than 10 of 13 deep checks agree.",
  };
}
