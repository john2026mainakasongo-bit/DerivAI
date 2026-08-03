
function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function stdDev(values = []) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    mean(values.map((value) => (Number(value) - average) ** 2))
  );
}

function pointQuote(point) {
  const value = Number(point?.quote ?? point?.price ?? point);
  return Number.isFinite(value) ? value : null;
}

function pointTime(point, index = 0) {
  const raw =
    point?.epoch ??
    point?.time ??
    point?.timestamp ??
    point?.createdAt;

  const numeric = Number(raw);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 100000000000
      ? numeric
      : numeric * 1000;
  }

  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : index;
}

function normalizedPoints(prices = []) {
  return (Array.isArray(prices) ? prices : [])
    .map((point, index) => ({
      quote: pointQuote(point),
      time: pointTime(point, index),
    }))
    .filter((point) => Number.isFinite(point.quote));
}

function ema(values = [], period = 9) {
  if (!values.length) return 0;

  const k = 2 / (period + 1);
  let value = Number(values[0]);

  for (let index = 1; index < values.length; index += 1) {
    value = Number(values[index]) * k + value * (1 - k);
  }

  return value;
}

function emaSeries(values = [], period = 9) {
  if (!values.length) return [];

  const k = 2 / (period + 1);
  const result = [Number(values[0])];

  for (let index = 1; index < values.length; index += 1) {
    result.push(
      Number(values[index]) * k +
        result[index - 1] * (1 - k)
    );
  }

  return result;
}

function rsi(values = [], period = 14) {
  if (values.length < 3) return 50;

  const changes = values
    .slice(1)
    .map((value, index) => Number(value) - Number(values[index]));

  const sample = changes.slice(-Math.min(period, changes.length));
  const gains = sample.map((change) => Math.max(0, change));
  const losses = sample.map((change) => Math.max(0, -change));

  const averageGain = mean(gains);
  const averageLoss = mean(losses);

  if (averageLoss === 0) return averageGain > 0 ? 100 : 50;

  const relativeStrength = averageGain / averageLoss;
  return clamp(100 - 100 / (1 + relativeStrength));
}

function macd(values = []) {
  if (!values.length) {
    return {
      line: 0,
      signal: 0,
      histogram: 0,
    };
  }

  const fastSeries = emaSeries(values, 6);
  const slowSeries = emaSeries(values, 13);

  const lineSeries = values.map(
    (_, index) =>
      Number(fastSeries[index] || 0) -
      Number(slowSeries[index] || 0)
  );

  const signalSeries = emaSeries(lineSeries, 5);
  const line = lineSeries.at(-1) || 0;
  const signal = signalSeries.at(-1) || 0;

  return {
    line,
    signal,
    histogram: line - signal,
  };
}

function atrLike(values = [], period = 14) {
  if (values.length < 2) return 0;

  const moves = values
    .slice(1)
    .map((value, index) =>
      Math.abs(Number(value) - Number(values[index]))
    )
    .slice(-period);

  return mean(moves);
}

function slope(values = []) {
  if (values.length < 2) return 0;

  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;

  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });

  return denominator ? numerator / denominator : 0;
}

function directionConsistency(values = []) {
  if (values.length < 3) return 0;

  const changes = values
    .slice(1)
    .map((value, index) => Number(value) - Number(values[index]));

  const positive = changes.filter((value) => value > 0).length;
  const negative = changes.filter((value) => value < 0).length;

  return clamp(
    (Math.max(positive, negative) /
      Math.max(1, changes.length)) *
      100
  );
}

function reversals(values = []) {
  if (values.length < 4) return 0;

  const signs = values
    .slice(1)
    .map((value, index) =>
      Math.sign(Number(value) - Number(values[index]))
    );

  let count = 0;

  for (let index = 1; index < signs.length; index += 1) {
    if (
      signs[index] &&
      signs[index - 1] &&
      signs[index] !== signs[index - 1]
    ) {
      count += 1;
    }
  }

  return count;
}

function windowForMode(points, mode) {
  if (mode === "10ticks") {
    return points.slice(-10);
  }

  const latest = points.at(-1)?.time || 0;
  const timed = points.filter(
    (point) => latest - point.time <= 15000
  );

  return timed.length >= 5 ? timed : points.slice(-15);
}

function momentumWindows(values = []) {
  const move = (count) => {
    const sample = values.slice(
      -Math.min(count, values.length)
    );

    if (sample.length < 2) return 0;

    return sample.at(-1) - sample[0];
  };

  return {
    fast: move(3),
    medium: move(5),
    slow: move(10),
  };
}

function supportResistance(values = []) {
  if (!values.length) {
    return {
      support: 0,
      resistance: 0,
      distanceToSupport: 0,
      distanceToResistance: 0,
    };
  }

  const recent = values.slice(-Math.min(30, values.length));
  const support = Math.min(...recent);
  const resistance = Math.max(...recent);
  const current = Number(recent.at(-1));

  return {
    support,
    resistance,
    distanceToSupport: current - support,
    distanceToResistance: resistance - current,
  };
}

function breakoutState(values = [], support, resistance, atr) {
  if (values.length < 4) return "NONE";

  const current = Number(values.at(-1));
  const previous = Number(values.at(-2));
  const buffer = Math.max(atr * 0.35, 0.0000001);

  if (
    previous <= resistance &&
    current > resistance + buffer
  ) {
    return "BULLISH BREAKOUT";
  }

  if (
    previous >= support &&
    current < support - buffer
  ) {
    return "BEARISH BREAKOUT";
  }

  return "NONE";
}

function pullbackState({
  values,
  emaFast,
  emaSlow,
  atr,
}) {
  if (values.length < 5) return "NONE";

  const current = Number(values.at(-1));
  const previous = Number(values.at(-2));
  const tolerance = Math.max(atr * 0.8, 0.0000001);

  if (
    emaFast > emaSlow &&
    current >= emaFast - tolerance &&
    previous < current
  ) {
    return "BULLISH PULLBACK";
  }

  if (
    emaFast < emaSlow &&
    current <= emaFast + tolerance &&
    previous > current
  ) {
    return "BEARISH PULLBACK";
  }

  return "NONE";
}

function regimeState({
  emaFast,
  emaSlow,
  atr,
  consistency,
  slopeValue,
}) {
  const separation = Math.abs(emaFast - emaSlow);
  const normalizedSeparation =
    atr > 0 ? separation / atr : 0;
  const normalizedSlope =
    atr > 0 ? Math.abs(slopeValue) / atr : 0;

  if (
    consistency >= 64 &&
    normalizedSeparation >= 0.24 &&
    normalizedSlope >= 0.05
  ) {
    return "TREND";
  }

  if (
    consistency <= 48 ||
    normalizedSeparation <= 0.09
  ) {
    return "RANGE";
  }

  return "TRANSITION";
}

function stochastic(values = [], period = 9) {
  if (!values.length) return 50;

  const recent = values.slice(-Math.min(period, values.length));
  const low = Math.min(...recent);
  const high = Math.max(...recent);
  const current = Number(recent.at(-1));

  if (high === low) return 50;
  return clamp(((current - low) / (high - low)) * 100);
}

function rateOfChange(values = [], period = 5) {
  if (values.length < 2) return 0;

  const current = Number(values.at(-1));
  const previous = Number(
    values.at(-Math.min(period + 1, values.length))
  );

  if (!Number.isFinite(previous) || previous === 0) return 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function zScore(values = [], period = 20) {
  const recent = values.slice(-Math.min(period, values.length));
  if (recent.length < 3) return 0;

  const average = mean(recent);
  const deviation = stdDev(recent);

  if (!deviation) return 0;
  return (Number(recent.at(-1)) - average) / deviation;
}

function directionalStreak(values = []) {
  if (values.length < 2) {
    return { direction: "FLAT", length: 0 };
  }

  let direction = 0;
  let length = 0;

  for (let index = values.length - 1; index > 0; index -= 1) {
    const change = Number(values[index]) - Number(values[index - 1]);
    const sign = Math.sign(change);

    if (!sign) continue;

    if (!direction) {
      direction = sign;
      length = 1;
      continue;
    }

    if (sign !== direction) break;
    length += 1;
  }

  return {
    direction:
      direction > 0
        ? "RISE"
        : direction < 0
          ? "FALL"
          : "FLAT",
    length,
  };
}


function bollinger(values = [], period = 20, multiplier = 2) {
  const recent = values.slice(-Math.min(period, values.length));

  if (recent.length < 3) {
    const current = Number(recent.at(-1) || 0);
    return {
      middle: current,
      upper: current,
      lower: current,
      position: "MIDDLE",
      width: 0,
    };
  }

  const middle = mean(recent);
  const deviation = stdDev(recent);
  const upper = middle + deviation * multiplier;
  const lower = middle - deviation * multiplier;
  const current = Number(recent.at(-1));

  const position =
    current >= upper
      ? "ABOVE UPPER"
      : current <= lower
        ? "BELOW LOWER"
        : current > middle
          ? "UPPER HALF"
          : current < middle
            ? "LOWER HALF"
            : "MIDDLE";

  return {
    middle,
    upper,
    lower,
    position,
    width: upper - lower,
  };
}

function trendAge(values = []) {
  if (values.length < 2) {
    return { direction: "FLAT", ticks: 0 };
  }

  const recentChanges = values
    .slice(1)
    .map((value, index) => Number(value) - Number(values[index]));

  let direction = 0;
  let ticks = 0;

  for (let index = recentChanges.length - 1; index >= 0; index -= 1) {
    const sign = Math.sign(recentChanges[index]);

    if (!sign) continue;

    if (!direction) {
      direction = sign;
      ticks = 1;
      continue;
    }

    if (sign !== direction) break;
    ticks += 1;
  }

  return {
    direction:
      direction > 0
        ? "RISE"
        : direction < 0
          ? "FALL"
          : "FLAT",
    ticks,
  };
}

function pressureScore(values = []) {
  if (values.length < 2) {
    return {
      buying: 50,
      selling: 50,
    };
  }

  const changes = values
    .slice(1)
    .map((value, index) => Number(value) - Number(values[index]));

  const weighted = changes.map((change, index) => ({
    change,
    weight: 1 + index / Math.max(1, changes.length - 1),
  }));

  const buy = weighted.reduce(
    (sum, item) =>
      sum + (item.change > 0 ? Math.abs(item.change) * item.weight : 0),
    0
  );

  const sell = weighted.reduce(
    (sum, item) =>
      sum + (item.change < 0 ? Math.abs(item.change) * item.weight : 0),
    0
  );

  const total = buy + sell;

  if (!total) {
    return {
      buying: 50,
      selling: 50,
    };
  }

  return {
    buying: clamp((buy / total) * 100),
    selling: clamp((sell / total) * 100),
  };
}

function supportResistanceStrength(values = [], level, tolerance) {
  if (!values.length || !Number.isFinite(level)) return 0;

  const hits = values.filter(
    (value) => Math.abs(Number(value) - level) <= tolerance
  ).length;

  return clamp((hits / Math.max(1, values.length)) * 100 * 2.4);
}

function fakeBreakoutProbability({
  breakout,
  current,
  support,
  resistance,
  atr,
  consistency,
}) {
  if (breakout === "NONE") return 0;

  const extension =
    breakout === "BULLISH BREAKOUT"
      ? current - resistance
      : support - current;

  const extensionScore =
    atr > 0 ? clamp((extension / atr) * 100) : 0;

  return clamp(
    100 -
      extensionScore * 0.55 -
      consistency * 0.35
  );
}

function reversalContinuation({
  rsiValue,
  stochasticValue,
  zScoreValue,
  trendTicks,
  consistency,
  emaAligned,
  momentumAligned,
}) {
  const exhaustion =
    Math.max(
      Math.abs(rsiValue - 50) * 1.3,
      Math.abs(stochasticValue - 50) * 1.1,
      Math.abs(zScoreValue) * 18
    );

  const agePenalty = clamp(trendTicks * 3.2, 0, 35);

  const reversal = clamp(
    exhaustion * 0.45 +
      agePenalty * 0.35 +
      (100 - consistency) * 0.2
  );

  const continuation = clamp(
    consistency * 0.42 +
      (emaAligned ? 24 : 0) +
      (momentumAligned ? 24 : 0) +
      Math.max(0, 100 - agePenalty) * 0.1
  );

  return {
    reversal,
    continuation,
  };
}

function scoreGrade(score) {
  if (score >= 90) return "A";
  if (score >= 82) return "B";
  if (score >= 72) return "C";
  return "WAIT";
}

function durationRecommendation({
  mode,
  confidence,
  atr,
  consistency,
  regime,
}) {
  if (
    confidence >= 86 &&
    consistency >= 74 &&
    regime === "TREND"
  ) {
    return mode === "10ticks"
      ? "10 TICKS"
      : "15 SECONDS";
  }

  if (atr > 0 && confidence >= 78) {
    return mode === "10ticks"
      ? "10 TICKS"
      : "15 SECONDS";
  }

  return "WAIT";
}

export function analyzeRiseFall(
  prices = [],
  mode = "15s"
) {
  const points = normalizedPoints(prices);
  const sample = windowForMode(points, mode);
  const values = sample.map((point) => point.quote);

  if (values.length < 4) {
    return {
      signal: "WAIT",
      rawDirection: "WAIT",
      confidence: 0,
      probabilityRise: 50,
      probabilityFall: 50,
      risk: "WAITING",
      samples: values.length,
      reason: `Collecting ${
        mode === "10ticks"
          ? "10 ticks"
          : "15 seconds"
      } of live prices.`,
      points: sample,
      momentum: {
        fast: 0,
        medium: 0,
        slow: 0,
      },
      indicators: {
        emaFast: 0,
        emaSlow: 0,
        rsi: 50,
        macd: {
          line: 0,
          signal: 0,
          histogram: 0,
        },
        atr: 0,
      },
      supportResistance: {
        support: 0,
        resistance: 0,
      },
      breakout: "NONE",
      pullback: "NONE",
      regime: "WAITING",
      duration: "WAIT",
      ready: false,
    };
  }

  const first = Number(values[0]);
  const last = Number(values.at(-1));
  const netMove = last - first;
  const linearSlope = slope(values);

  const changes = values
    .slice(1)
    .map(
      (value, index) =>
        Number(value) - Number(values[index])
    );

  const volatility = stdDev(changes);
  const consistency = directionConsistency(values);
  const reversalCount = reversals(values);
  const momentum = momentumWindows(values);

  const emaFast = ema(values, 5);
  const emaSlow = ema(values, 9);
  const rsiValue = rsi(values, 9);
  const macdValue = macd(values);
  const atr = atrLike(values, 9);
  const stochasticValue = stochastic(values, 9);
  const rocValue = rateOfChange(values, 5);
  const zScoreValue = zScore(values, 20);
  const streak = directionalStreak(values);
  const trend = trendAge(values);
  const bands = bollinger(values, 20, 2);
  const pressure = pressureScore(values);

  const levels = supportResistance(values);

  const breakout = breakoutState(
    values,
    levels.support,
    levels.resistance,
    atr
  );

  const pullback = pullbackState({
    values,
    emaFast,
    emaSlow,
    atr,
  });

  const tolerance = Math.max(atr * 0.7, 0.0000001);
  const supportStrength = supportResistanceStrength(
    values,
    levels.support,
    tolerance
  );
  const resistanceStrength = supportResistanceStrength(
    values,
    levels.resistance,
    tolerance
  );

  const breakoutFakeProbability = fakeBreakoutProbability({
    breakout,
    current: Number(values.at(-1)),
    support: levels.support,
    resistance: levels.resistance,
    atr,
    consistency,
  });

  const regime = regimeState({
    emaFast,
    emaSlow,
    atr,
    consistency,
    slopeValue: linearSlope,
  });

  const voteSignals = [
    netMove > 0 ? 1 : netMove < 0 ? -1 : 0,
    linearSlope > 0 ? 1 : linearSlope < 0 ? -1 : 0,
    emaFast > emaSlow ? 1 : emaFast < emaSlow ? -1 : 0,
    macdValue.histogram > 0
      ? 1
      : macdValue.histogram < 0
        ? -1
        : 0,
    rsiValue >= 55 ? 1 : rsiValue <= 45 ? -1 : 0,
    momentum.fast > 0
      ? 1
      : momentum.fast < 0
        ? -1
        : 0,
    momentum.medium > 0
      ? 1
      : momentum.medium < 0
        ? -1
        : 0,
    momentum.slow > 0
      ? 1
      : momentum.slow < 0
        ? -1
        : 0,
    stochasticValue >= 58
      ? 1
      : stochasticValue <= 42
        ? -1
        : 0,
    rocValue > 0
      ? 1
      : rocValue < 0
        ? -1
        : 0,
    zScoreValue >= 0.25
      ? 1
      : zScoreValue <= -0.25
        ? -1
        : 0,
    streak.direction === "RISE" && streak.length >= 2
      ? 1
      : streak.direction === "FALL" && streak.length >= 2
        ? -1
        : 0,
  ];

  const riseVotes = voteSignals.filter(
    (vote) => vote > 0
  ).length;

  const fallVotes = voteSignals.filter(
    (vote) => vote < 0
  ).length;

  const dominantVotes = Math.max(
    riseVotes,
    fallVotes
  );

  const direction =
    riseVotes > fallVotes
      ? "RISE"
      : fallVotes > riseVotes
        ? "FALL"
        : "WAIT";

  const normalizedMove =
    volatility > 0
      ? Math.abs(netMove) / volatility
      : 0;

  const trendStrength = clamp(
    normalizedMove * 11
  );

  const voteScore = clamp(
    (dominantVotes / voteSignals.length) * 100
  );

  const emaScore =
    atr > 0
      ? clamp(
          (Math.abs(emaFast - emaSlow) / atr) * 35
        )
      : 0;

  const reversalPenalty = clamp(
    reversalCount * 6,
    0,
    30
  );

  const rangePenalty =
    regime === "RANGE" ? 14 : 0;

  const confidence = clamp(
    consistency * 0.24 +
      trendStrength * 0.19 +
      voteScore * 0.28 +
      emaScore * 0.13 +
      Math.min(100, values.length * 8) * 0.12 +
      (breakout !== "NONE" ? 6 : 0) +
      (pullback !== "NONE" ? 5 : 0) -
      reversalPenalty * 0.65 -
      rangePenalty * 0.55,
    0,
    96
  );

  const voteDifference =
    riseVotes - fallVotes;

  const probabilityRise = clamp(
    50 +
      voteDifference * 4.4 +
      (linearSlope > 0 ? 5 : linearSlope < 0 ? -5 : 0) +
      (emaFast > emaSlow ? 5 : emaFast < emaSlow ? -5 : 0) +
      (macdValue.histogram > 0 ? 3 : macdValue.histogram < 0 ? -3 : 0) +
      (rsiValue - 50) * 0.22,
    5,
    95
  );

  const probabilityFall = 100 - probabilityRise;

  const emaAligned =
    direction === "RISE"
      ? emaFast > emaSlow
      : direction === "FALL"
        ? emaFast < emaSlow
        : false;

  const momentumAligned =
    direction === "RISE"
      ? momentum.fast > 0 && momentum.medium > 0
      : direction === "FALL"
        ? momentum.fast < 0 && momentum.medium < 0
        : false;

  const continuationReversal = reversalContinuation({
    rsiValue,
    stochasticValue,
    zScoreValue,
    trendTicks: trend.ticks,
    consistency,
    emaAligned,
    momentumAligned,
  });

  const confirmationChecks = [
    {
      id: "direction",
      label: "Directional votes",
      passed: dominantVotes >= 7,
      detail: `${dominantVotes}/${voteSignals.length}`,
    },
    {
      id: "confidence",
      label: "Confidence",
      passed: confidence >= 68,
      detail: `${confidence.toFixed(1)}%`,
    },
    {
      id: "consistency",
      label: "Consistency",
      passed: consistency >= 54,
      detail: `${consistency.toFixed(1)}%`,
    },
    {
      id: "regime",
      label: "Non-ranging regime",
      passed:
        regime !== "RANGE" ||
        (consistency >= 58 && dominantVotes >= 9),
      detail: regime,
    },
    {
      id: "ema",
      label: "EMA alignment",
      passed: emaAligned,
      detail:
        emaFast > emaSlow
          ? "BULLISH"
          : emaFast < emaSlow
            ? "BEARISH"
            : "FLAT",
    },
    {
      id: "momentum",
      label: "Momentum alignment",
      passed: momentumAligned,
      detail: `${momentum.fast.toFixed(5)} / ${momentum.medium.toFixed(5)}`,
    },
    {
      id: "pressure",
      label: "Directional pressure",
      passed:
        direction === "RISE"
          ? pressure.buying >= 58
          : direction === "FALL"
            ? pressure.selling >= 58
            : false,
      detail:
        direction === "RISE"
          ? `${pressure.buying.toFixed(1)}% BUY`
          : `${pressure.selling.toFixed(1)}% SELL`,
    },
    {
      id: "continuation",
      label: "Continuation edge",
      passed:
        continuationReversal.continuation >=
        continuationReversal.reversal + 8,
      detail:
        `${continuationReversal.continuation.toFixed(1)}% / ${continuationReversal.reversal.toFixed(1)}%`,
    },
  ];

  const confirmationsPassed = confirmationChecks.filter(
    (item) => item.passed
  ).length;

  const tradeNow =
    direction !== "WAIT" &&
    confirmationsPassed >= 6 &&
    dominantVotes >= 7 &&
    confidence >= 68 &&
    consistency >= 54 &&
    (
      regime !== "RANGE" ||
      (dominantVotes >= 9 && consistency >= 58)
    );

  const prepare =
    !tradeNow &&
    direction !== "WAIT" &&
    confirmationsPassed >= 5 &&
    dominantVotes >= 7 &&
    confidence >= 58;

  const decision = tradeNow
    ? `TRADE ${direction}`
    : prepare
      ? `PREPARE ${direction}`
      : "NO TRADE";

  const ready = tradeNow;
  const signal = tradeNow ? direction : "WAIT";

  const risk = ready
    ? confidence >= 86 &&
      reversalCount <= 1 &&
      regime === "TREND"
      ? "LOW"
      : "MEDIUM"
    : "HIGH";

  const duration = durationRecommendation({
    mode,
    confidence,
    atr,
    consistency,
    regime,
  });

  const trendScore = clamp(
    consistency * 0.45 +
      Math.min(100, dominantVotes / voteSignals.length * 100) * 0.35 +
      (regime === "TREND" ? 20 : regime === "TRANSITION" ? 10 : 0)
  );

  const patternScore = clamp(
    (breakout !== "NONE" ? 28 : 0) +
      (pullback !== "NONE" ? 24 : 0) +
      (bands.position.includes("UPPER") || bands.position.includes("LOWER") ? 18 : 10) +
      Math.min(30, trend.ticks * 3)
  );

  const momentumScore = clamp(
    Math.max(pressure.buying, pressure.selling) * 0.45 +
      Math.min(100, Math.abs(rocValue) * 180) * 0.2 +
      Math.min(100, dominantVotes / voteSignals.length * 100) * 0.35
  );

  const volatilityScore = clamp(
    atr > 0
      ? Math.min(100, (volatility / atr) * 45)
      : 0
  );

  const qualityScore = clamp(
    confidence * 0.34 +
      trendScore * 0.2 +
      momentumScore * 0.2 +
      continuationReversal.continuation * 0.16 +
      (100 - breakoutFakeProbability) * 0.1
  );

  const finalScore = clamp(
    qualityScore * 0.72 +
      confirmationsPassed / confirmationChecks.length * 100 * 0.28
  );

  const setupGrade = tradeNow
    ? scoreGrade(finalScore)
    : prepare
      ? "PREPARE"
      : "WAIT";

  const failedConfirmations = confirmationChecks
    .filter((item) => !item.passed)
    .map((item) => item.label);

  const reason = tradeNow
    ? `${decision}: ${confirmationsPassed}/${confirmationChecks.length} confirmations aligned.`
    : prepare
      ? `${decision}: one or two checks are still forming — ${failedConfirmations.join(", ") || "fresh confirmation"}.`
      : regime === "RANGE"
        ? "NO TRADE: market is ranging or noisy."
        : direction === "WAIT"
          ? "NO TRADE: direction is mixed."
          : `NO TRADE: missing ${failedConfirmations.join(", ") || "strong confirmation"}.`;

  return {
    signal,
    rawDirection: direction,
    confidence,
    probabilityRise,
    probabilityFall,
    risk,
    samples: values.length,
    first,
    last,
    netMove,
    slope: linearSlope,
    volatility,
    consistency,
    reversalCount,
    riseVotes,
    fallVotes,
    totalVotes: voteSignals.length,
    momentum,
    indicators: {
      emaFast,
      emaSlow,
      rsi: rsiValue,
      macd: macdValue,
      atr,
      stochastic: stochasticValue,
      roc: rocValue,
      zScore: zScoreValue,
    },
    streak,
    confirmationChecks,
    confirmationsPassed,
    setupGrade,
    decision,
    prepare,
    tradeNow,
    trend,
    bollinger: bands,
    pressure,
    supportStrength,
    resistanceStrength,
    breakoutFakeProbability,
    reversalProbability: continuationReversal.reversal,
    continuationProbability: continuationReversal.continuation,
    scores: {
      trend: trendScore,
      pattern: patternScore,
      momentum: momentumScore,
      volatility: volatilityScore,
      quality: qualityScore,
      final: finalScore,
    },
    supportResistance: levels,
    breakout,
    pullback,
    regime,
    duration,
    points: sample,
    ready,
    reason,
  };
}

export default analyzeRiseFall;
