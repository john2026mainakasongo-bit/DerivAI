
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

function probability(digits, mode, digit = null) {
  if (!digits.length) return fairProbability(mode, digit);
  return digits.filter((value) => wins(value, mode, digit)).length / digits.length;
}

function weightedProbability(digits, mode, digit = null) {
  if (!digits.length) return fairProbability(mode, digit);

  let total = 0;
  let winTotal = 0;
  let weight = 1;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (wins(digits[index], mode, digit)) winTotal += weight;
    total += weight;
    weight *= 0.97;
  }

  return total ? winTotal / total : fairProbability(mode, digit);
}

function transitionProbability(digits, mode, digit = null) {
  if (digits.length < 8) return fairProbability(mode, digit);

  const previous = digits[digits.length - 1];
  let total = 0;
  let successful = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index - 1] !== previous) continue;
    total += 1;
    if (wins(digits[index], mode, digit)) successful += 1;
  }

  return total ? (successful + 1) / (total + 2) : probability(digits, mode, digit);
}

function stability(digits, mode, digit = null) {
  const windows = [20, 40, 80, 160]
    .map((size) => digits.slice(-Math.min(size, digits.length)))
    .filter((window) => window.length >= 12);

  if (windows.length < 2) return 50;

  const values = windows.map((window) => probability(window, mode, digit));
  const spread = Math.max(...values) - Math.min(...values);

  return clamp((1 - spread / 0.16) * 100);
}

function streakScore(digits, mode, digit = null) {
  let streak = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (!wins(digits[index], mode, digit)) break;
    streak += 1;
  }

  return clamp(50 + Math.min(streak, 5) * 8);
}

function reversalScore(digits, mode, digit = null) {
  if (digits.length < 12) return 50;

  const recent = digits.slice(-12);
  const first = probability(recent.slice(0, 6), mode, digit);
  const second = probability(recent.slice(6), mode, digit);

  return clamp(50 + (second - first) * 160);
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

function bayesianProbability(observed, baseline, samples) {
  const prior =
    samples < 50 ? 120 :
    samples < 100 ? 85 :
    60;

  return (
    observed * samples +
    baseline * prior
  ) / (samples + prior);
}

function conservativeEv(probabilityValue, baseline) {
  const multiplier = (1 / Math.max(0.01, baseline)) * 0.94;
  return probabilityValue * multiplier - 1;
}

function fastBacktest(digits, mode, digit = null) {
  if (digits.length < 45) {
    return {
      trades: 0,
      winRate: 0,
      profitUnits: 0,
      passed: false,
    };
  }

  const test = digits.slice(-Math.min(120, digits.length));
  const baseline = fairProbability(mode, digit);
  const payout = (1 / Math.max(0.01, baseline)) * 0.94;
  const winsCount = test.filter((value) => wins(value, mode, digit)).length;
  const lossesCount = test.length - winsCount;
  const profitUnits = winsCount * (payout - 1) - lossesCount;
  const winRate = winsCount / test.length;

  return {
    trades: test.length,
    winRate: winRate * 100,
    profitUnits,
    passed:
      profitUnits >= 1 &&
      winRate >= baseline + 0.012,
  };
}

function windowAgreement(digits, mode, digit = null) {
  const windows = [20, 40, 80, 160]
    .map((size) => digits.slice(-Math.min(size, digits.length)))
    .filter((window) => window.length >= 12);

  const baseline = fairProbability(mode, digit);
  const positive = windows.filter(
    (window) => probability(window, mode, digit) > baseline
  ).length;

  return {
    count: positive,
    total: windows.length,
    passed:
      windows.length >= 3 &&
      positive >= Math.min(3, windows.length),
  };
}

export function rankV66FastProfessional({
  digitHistory = [],
  allowHighRisk = false,
  minimumConfidence = 82,
} = {}) {
  const digits = validDigits(digitHistory);
  const sampleSize = digits.length;

  if (sampleSize < 25) {
    return {
      ready: false,
      sampleSize,
      best: null,
      candidates: [],
      reason: `Fast warm-up: ${sampleSize}/25 ticks.`,
    };
  }

  const recent = digits.slice(-Math.min(180, digits.length));
  const auto1 = Math.abs(autocorrelation(recent, 1));
  const auto2 = Math.abs(autocorrelation(recent, 2));

  const candidates = definitions().map(({ mode, digit }) => {
    const baseline = fairProbability(mode, digit);
    const highRisk = mode === "MATCH" || mode === "DIFFERS";

    const p20 = weightedProbability(digits.slice(-20), mode, digit);
    const p40 = weightedProbability(digits.slice(-40), mode, digit);
    const p80 = weightedProbability(digits.slice(-80), mode, digit);
    const p160 = weightedProbability(digits.slice(-160), mode, digit);
    const transition = transitionProbability(recent, mode, digit);

    const observed =
      p20 * 0.42 +
      p40 * 0.28 +
      p80 * 0.17 +
      p160 * 0.08 +
      transition * 0.05;

    const probabilityValue = bayesianProbability(
      observed,
      baseline,
      sampleSize
    );

    const edge = probabilityValue - baseline;
    const ev = conservativeEv(probabilityValue, baseline);
    const stable = stability(digits, mode, digit);
    const streak = streakScore(digits, mode, digit);
    const reversal = reversalScore(digits, mode, digit);
    const agreement = windowAgreement(digits, mode, digit);
    const backtest = fastBacktest(digits, mode, digit);

    const autocorrelationScore = clamp(50 + auto1 * 120 + auto2 * 80);

    const checks = [
      { name: "20-tick probability", pass: p20 > baseline + (highRisk ? 0.035 : 0.012) },
      { name: "40-tick probability", pass: p40 > baseline + (highRisk ? 0.03 : 0.01) },
      { name: "80-tick probability", pass: p80 > baseline + (highRisk ? 0.025 : 0.008) },
      { name: "160-tick probability", pass: p160 > baseline + (highRisk ? 0.02 : 0.006) },
      { name: "Expected value", pass: ev >= (highRisk ? 0.12 : 0.018) },
      { name: "Probability edge", pass: edge >= (highRisk ? 0.035 : 0.013) },
      { name: "Markov transition", pass: transition > baseline + (highRisk ? 0.035 : 0.012) },
      { name: "Window agreement", pass: agreement.passed },
      { name: "Stability", pass: stable >= (highRisk ? 78 : 64) },
      { name: "Streak behaviour", pass: streak >= 56 },
      { name: "Reversal control", pass: reversal >= 46 },
      { name: "Autocorrelation", pass: autocorrelationScore >= 55 },
      { name: "Fast backtest", pass: backtest.passed },
    ];

    const voteCount = checks.filter((check) => check.pass).length;

    let confidence =
      55 +
      ev * 180 +
      edge * 260 +
      (stable - 50) * 0.14 +
      (voteCount - 6) * 3.2 +
      (backtest.passed ? 7 : 0) +
      (agreement.passed ? 4 : 0);

    if (highRisk) {
      confidence -= 14;
      confidence = Math.min(85, confidence);
    } else {
      confidence = Math.min(96, confidence);
    }

    confidence = clamp(confidence);

    const requiredVotes = highRisk ? 11 : 9;

    const executable =
      voteCount >= requiredVotes &&
      ev >= (highRisk ? 0.12 : 0.018) &&
      edge >= (highRisk ? 0.035 : 0.013) &&
      stable >= (highRisk ? 78 : 64) &&
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
      probability: probabilityValue * 100,
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
      source: "V66 FAST PROFESSIONAL",
      detail:
        `${setupName(mode, digit)} · ${voteCount}/${checks.length} checks · ` +
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
      right.expectedValue - left.expectedValue ||
      right.backtestProfitUnits - left.backtestProfitUnits ||
      right.qualityScore - left.qualityScore
    );
  });

  const best =
    candidates.find((candidate) => candidate.executable) || null;

  return {
    ready: sampleSize >= 45,
    sampleSize,
    best,
    candidates,
    reason: best
      ? `EXECUTE ${best.setup}: ${best.voteCount}/${best.totalVotes} fast checks agree.`
      : sampleSize < 45
        ? `Building fast evidence: ${sampleSize}/45.`
        : "WAIT: no setup passes 9 of 13 fast professional checks.",
  };
}
