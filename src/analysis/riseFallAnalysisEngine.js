
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
    consistency >= 72 &&
    normalizedSeparation >= 0.35 &&
    normalizedSlope >= 0.08
  ) {
    return "TREND";
  }

  if (
    consistency <= 58 ||
    normalizedSeparation <= 0.15
  ) {
    return "RANGE";
  }

  return "TRANSITION";
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

  if (values.length < 5) {
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
      Math.min(100, values.length * 6) * 0.1 +
      (breakout !== "NONE" ? 5 : 0) +
      (pullback !== "NONE" ? 4 : 0) -
      reversalPenalty -
      rangePenalty,
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

  const ready =
    direction !== "WAIT" &&
    confidence >= 76 &&
    dominantVotes >= 6 &&
    consistency >= 62 &&
    regime !== "RANGE";

  const signal = ready ? direction : "WAIT";

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

  const reason = ready
    ? `${direction} setup aligned across EMA, MACD, RSI, momentum and price direction.`
    : regime === "RANGE"
      ? "Market is ranging. Wait for stronger directional separation."
      : direction === "WAIT"
        ? "Direction is mixed. Continue collecting fresh prices."
        : `${direction} is forming, but confirmations are not strong enough yet.`;

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
