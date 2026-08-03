import {
  digitDistribution,
  parityStats,
  thresholdStats,
  lastDigitStreak,
  digitEntropy,
  recentVsBaseline,
} from "./digitAnalysis";

import {
  priceMomentum,
  volatilityScore,
  confidenceScore,
  confidenceLabel,
} from "./marketScore";

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

function makeSignal(signal, confidence, detail, extra = {}) {
  return {
    signal,
    confidence: clamp(confidence, 0, 99),
    detail,
    ...extra,
  };
}

function paritySignal(parity, sampleSize) {
  if (sampleSize < 60) {
    return makeSignal(
      "WAIT",
      0,
      `Need more samples (${sampleSize}/60)`
    );
  }

  const even = Number(parity.evenPercent || 0);
  const odd = Number(parity.oddPercent || 0);
  const edge = even - odd;
  const absEdge = Math.abs(edge);

  if (absEdge < 8) {
    return makeSignal(
      "WAIT",
      55 + absEdge * 1.5,
      `Balanced parity: EVEN ${even.toFixed(1)}% / ODD ${odd.toFixed(1)}%`
    );
  }

  const signal = edge > 0 ? "EVEN" : "ODD";
  const winner = Math.max(even, odd);
  const confidence = 68 + Math.min(24, absEdge * 1.35);

  return makeSignal(
    signal,
    confidence,
    `${signal} leads at ${winner.toFixed(1)}% across ${sampleSize} digits`
  );
}

function thresholdSignal(threshold2, sampleSize) {
  if (sampleSize < 60) {
    return makeSignal(
      "WAIT",
      0,
      `Need more samples (${sampleSize}/60)`
    );
  }

  const over = Number(threshold2.overPercent || 0);
  const under = Number(threshold2.underPercent || 0);
  const edge = over - under;
  const absEdge = Math.abs(edge);

  if (absEdge < 18) {
    return makeSignal(
      "WAIT",
      55 + absEdge,
      `No strong threshold edge: OVER 2 ${over.toFixed(1)}% / UNDER 2 ${under.toFixed(1)}%`
    );
  }

  const signal = edge > 0 ? "OVER 2" : "UNDER 2";
  const winner = Math.max(over, under);
  const confidence = 70 + Math.min(25, absEdge * 0.65);

  return makeSignal(
    signal,
    confidence,
    `${signal} dominates at ${winner.toFixed(1)}% across ${sampleSize} digits`
  );
}

function matchDiffAnalysis(distribution, digitHistory) {
  const sampleSize = digitHistory.length;
  const sorted = [...distribution].sort(
    (a, b) =>
      Number(b.percent || 0) -
        Number(a.percent || 0) ||
      a.digit - b.digit
  );

  const best = sorted[0] || {
    digit: null,
    percent: 0,
  };

  const second = sorted[1] || {
    digit: null,
    percent: 0,
  };

  const bestDigitPercent = Number(best.percent || 0);
  const secondPercent = Number(second.percent || 0);
  const concentrationEdge =
    bestDigitPercent - secondPercent;
  const differsEstimate = clamp(
    100 - bestDigitPercent,
    0,
    100
  );

  let signal = makeSignal(
    "WAIT",
    0,
    `Best digit ${best.digit ?? "—"} at ${bestDigitPercent.toFixed(1)}%`
  );

  if (sampleSize >= 80) {
    if (
      bestDigitPercent >= 16 &&
      concentrationEdge >= 3
    ) {
      const confidence =
        72 +
        Math.min(
          20,
          (bestDigitPercent - 16) * 2.1
        ) +
        Math.min(6, concentrationEdge);

      signal = makeSignal(
        `MATCH ${best.digit}`,
        confidence,
        `Digit ${best.digit} is unusually concentrated at ${bestDigitPercent.toFixed(1)}%`,
        { digit: best.digit }
      );
    } else if (
      differsEstimate >= 86 &&
      bestDigitPercent <= 14
    ) {
      const confidence =
        72 +
        Math.min(
          22,
          (differsEstimate - 86) * 1.4
        );

      signal = makeSignal(
        `DIFFERS ${best.digit}`,
        confidence,
        `Observed frequency for ${best.digit} is ${bestDigitPercent.toFixed(1)}%; differs estimate ${differsEstimate.toFixed(1)}%`,
        { digit: best.digit }
      );
    }
  }

  return {
    bestDigit: best.digit,
    bestDigitPercent,
    secondDigit: second.digit,
    secondPercent,
    concentrationEdge,
    differsEstimate,
    signal,
  };
}

function linearSlope(values) {
  if (!Array.isArray(values) || values.length < 3) {
    return 0;
  }

  const count = values.length;
  const meanX = (count - 1) / 2;
  const meanY =
    values.reduce((sum, value) => sum + value, 0) /
    count;

  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < count; index += 1) {
    const difference = index - meanX;
    numerator +=
      difference * (values[index] - meanY);
    denominator += difference * difference;
  }

  return denominator
    ? numerator / denominator
    : 0;
}

function directionAnalysis(prices) {
  if (!Array.isArray(prices) || prices.length < 40) {
    return {
      direction: "NEUTRAL",
      riseEstimate: 50,
      fallEstimate: 50,
      strength: 0,
      strengthLabel: "LOW",
      consistency: 0,
      shortSlope: 0,
      mediumSlope: 0,
      longSlope: 0,
      signal: makeSignal(
        "WAIT",
        0,
        "Need more price history"
      ),
    };
  }

  const clean = prices.filter(Number.isFinite);
  const recent12 = clean.slice(-12);
  const recent35 = clean.slice(-35);
  const recent90 = clean.slice(-90);
  const current = clean.at(-1) || 0;
  const scale = Math.max(Math.abs(current), 1e-9);

  const shortSlope =
    linearSlope(recent12) / scale;
  const mediumSlope =
    linearSlope(recent35) / scale;
  const longSlope =
    linearSlope(recent90) / scale;

  let upMoves = 0;
  let downMoves = 0;

  for (
    let index = Math.max(1, clean.length - 36);
    index < clean.length;
    index += 1
  ) {
    if (clean[index] > clean[index - 1]) {
      upMoves += 1;
    }

    if (clean[index] < clean[index - 1]) {
      downMoves += 1;
    }
  }

  const totalMoves = Math.max(
    1,
    upMoves + downMoves
  );

  const upRatio = upMoves / totalMoves;
  const downRatio = downMoves / totalMoves;

  const slopeScore =
    shortSlope * 70000 +
    mediumSlope * 50000 +
    longSlope * 25000;

  const consistencyScore =
    (upRatio - downRatio) * 34;

  const raw = slopeScore + consistencyScore;
  const riseEstimate = clamp(50 + raw, 8, 92);
  const fallEstimate = clamp(
    100 - riseEstimate,
    8,
    92
  );

  const strength =
    Math.abs(riseEstimate - 50) * 2;

  const strengthLabel =
    strength >= 55
      ? "STRONG"
      : strength >= 32
      ? "MODERATE"
      : "LOW";

  const direction =
    riseEstimate >= 56
      ? "RISE"
      : fallEstimate >= 56
      ? "FALL"
      : "NEUTRAL";

  const slopesAgreeRise =
    shortSlope > 0 &&
    mediumSlope > 0 &&
    longSlope >= 0;

  const slopesAgreeFall =
    shortSlope < 0 &&
    mediumSlope < 0 &&
    longSlope <= 0;

  const consistency =
    direction === "RISE"
      ? upRatio * 100
      : direction === "FALL"
      ? downRatio * 100
      : Math.max(upRatio, downRatio) * 100;

  const directionEstimate = Math.max(
    riseEstimate,
    fallEstimate
  );

  let signal = makeSignal(
    "WAIT",
    directionEstimate,
    `RISE ${riseEstimate.toFixed(0)}% / FALL ${fallEstimate.toFixed(0)}%`
  );

  if (
    direction !== "NEUTRAL" &&
    directionEstimate >= 67 &&
    strength >= 34 &&
    consistency >= 57 &&
    (
      (
        direction === "RISE" &&
        slopesAgreeRise
      ) ||
      (
        direction === "FALL" &&
        slopesAgreeFall
      )
    )
  ) {
    const confidence =
      70 +
      Math.min(
        18,
        (directionEstimate - 67) * 1.15
      ) +
      Math.min(
        8,
        Math.max(0, consistency - 57) * 0.6
      );

    signal = makeSignal(
      direction,
      confidence,
      `${direction} estimate ${directionEstimate.toFixed(0)}%, ${strengthLabel.toLowerCase()} trend, ${consistency.toFixed(0)}% recent consistency`
    );
  }

  return {
    direction,
    riseEstimate,
    fallEstimate,
    strength,
    strengthLabel,
    consistency,
    shortSlope,
    mediumSlope,
    longSlope,
    signal,
  };
}

export function analyzeMarket(snapshot = {}) {
  const digitHistory = Array.isArray(
    snapshot.digitHistory
  )
    ? snapshot.digitHistory
        .map(Number)
        .filter(
          (value) =>
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 9
        )
    : [];

  const prices = Array.isArray(snapshot.prices)
    ? snapshot.prices
        .map(Number)
        .filter(Number.isFinite)
    : [];

  const distribution =
    digitDistribution(digitHistory);
  const parity = parityStats(digitHistory);
  const threshold2 = thresholdStats(
    digitHistory,
    2
  );
  const streak = lastDigitStreak(digitHistory);
  const entropy = digitEntropy(digitHistory);
  const recency = recentVsBaseline(
    digitHistory,
    20
  );
  const momentum = priceMomentum(prices, 35);
  const volatility = volatilityScore(
    prices.slice(-180)
  );

  const parityEdge =
    Number(parity.evenPercent || 0) -
    Number(parity.oddPercent || 0);

  const thresholdEdge =
    Number(threshold2.overPercent || 0) -
    Number(threshold2.underPercent || 0);

  const confidence = confidenceScore({
    parityEdge,
    thresholdEdge,
    entropyNormalized: Number(
      entropy.normalized || 0
    ),
    volatility: Number(volatility.score || 0),
    momentumPercent: Number(
      momentum.percent || 0
    ),
  });

  const sortedHot = [...distribution].sort(
    (a, b) =>
      Number(b.percent || 0) -
        Number(a.percent || 0) ||
      a.digit - b.digit
  );

  const sortedCold = [...distribution].sort(
    (a, b) =>
      Number(a.percent || 0) -
        Number(b.percent || 0) ||
      a.digit - b.digit
  );

  const bestDigit = sortedHot[0] || null;
  const coldDigit = sortedCold[0] || null;

  const parityBias =
    parityEdge >= 6
      ? "EVEN"
      : parityEdge <= -6
      ? "ODD"
      : "BALANCED";

  const thresholdBias =
    thresholdEdge >= 10
      ? "OVER 2"
      : thresholdEdge <= -10
      ? "UNDER 2"
      : "BALANCED";

  const label = confidenceLabel(confidence);
  const matchDiff = matchDiffAnalysis(
    distribution,
    digitHistory
  );
  const direction = directionAnalysis(prices);

  const signals = {
    parity: paritySignal(
      parity,
      digitHistory.length
    ),
    threshold: thresholdSignal(
      threshold2,
      digitHistory.length
    ),
    matchDiff: matchDiff.signal,
    riseFall: direction.signal,
  };

  const activeSignals = Object.values(
    signals
  ).filter(
    (item) => item.signal !== "WAIT"
  );

  const strongestSignal =
    activeSignals
      .slice()
      .sort(
        (a, b) =>
          b.confidence - a.confidence
      )[0] || null;

  const setup =
    strongestSignal &&
    strongestSignal.confidence >= 75
      ? "POSSIBLE SETUP"
      : "WAIT";

  const suppliedLastDigit = Number(
    snapshot.lastDigit
  );

  const lastDigit =
    Number.isInteger(suppliedLastDigit) &&
    suppliedLastDigit >= 0 &&
    suppliedLastDigit <= 9
      ? suppliedLastDigit
      : digitHistory.length
      ? digitHistory.at(-1)
      : null;

  const suppliedPrice = Number(
    snapshot.currentPrice
  );

  const currentPrice =
    Number.isFinite(suppliedPrice)
      ? suppliedPrice
      : prices.length
      ? prices.at(-1)
      : 0;

  return {
    sampleSize: digitHistory.length,
    currentPrice,
    lastDigit,
    distribution,
    parity,
    threshold2,
    streak,
    entropy,
    recency,
    momentum,
    volatility,
    bestDigit,
    coldDigit,
    parityBias,
    thresholdBias,
    matchDiff,
    direction,
    signals,
    strongestSignal,
    confidence,
    confidenceLabel: label,
    setup,
  };
}
