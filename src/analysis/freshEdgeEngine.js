const clamp = (value, minimum = 0, maximum = 100) =>
  Math.max(minimum, Math.min(maximum, Number(value) || 0));

const average = (values = []) => {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
};

const ema = (values = [], period = 9) => {
  if (!values.length) return 0;

  const alpha = 2 / (Math.max(2, period) + 1);
  let current = Number(values[0] || 0);

  for (let index = 1; index < values.length; index += 1) {
    current =
      Number(values[index] || 0) * alpha +
      current * (1 - alpha);
  }

  return current;
};

const slope = (values = []) => {
  if (values.length < 2) return 0;

  const first = Number(values[0] || 0);
  const last = Number(values.at(-1) || 0);

  return (last - first) / Math.max(1, values.length - 1);
};

const moves = (values = []) =>
  values.slice(1).map((value, index) =>
    Number(value || 0) - Number(values[index] || 0)
  );

const ratioAboveZero = (values = []) => {
  if (!values.length) return 0.5;
  return values.filter((value) => Number(value) > 0).length / values.length;
};

const standardDeviation = (values = []) => {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(
    average(values.map((value) => (Number(value) - mean) ** 2))
  );
};

export function analyzeFreshEdge(
  prices = [],
  options = {},
  learning = {}
) {
  const clean = prices
    .map(Number)
    .filter(Number.isFinite)
    .slice(-120);

  const minimumTicks = Math.max(10, Number(options.minimumTicks || 16));

  if (clean.length < minimumTicks) {
    return {
      ready: false,
      decision: "WAIT",
      direction: "",
      score: 0,
      confidence: 0,
      quality: 0,
      noise: 100,
      reversalRisk: 100,
      reason: `Collecting fresh ticks ${clean.length}/${minimumTicks}.`,
      metrics: {},
    };
  }

  const recent6 = clean.slice(-6);
  const recent8 = clean.slice(-8);
  const recent16 = clean.slice(-16);
  const recent32 = clean.slice(-32);
  const recent64 = clean.slice(-64);

  const move6 = moves(recent6);
  const move8 = moves(recent8);
  const move16 = moves(recent16);
  const move32 = moves(recent32);

  const ema6 = ema(clean, 6);
  const ema14 = ema(clean, 14);
  const ema30 = ema(clean, 30);

  const slope8 = slope(recent8);
  const slope16 = slope(recent16);
  const slope32 = slope(recent32);

  const volatility16 = standardDeviation(move16);
  const volatility32 = standardDeviation(move32);
  const averageMove = average(move32.map(Math.abs));
  const maximumMove = Math.max(...move32.map(Math.abs), 0);

  const spikeRatio =
    averageMove > 0 ? maximumMove / averageMove : 0;

  const up6 = ratioAboveZero(move6);
  const up8 = ratioAboveZero(move8);
  const up16 = ratioAboveZero(move16);
  const up32 = ratioAboveZero(move32);

  const trendUp =
    ema6 > ema14 &&
    ema14 > ema30 &&
    slope8 > 0 &&
    slope16 > 0;

  const trendDown =
    ema6 < ema14 &&
    ema14 < ema30 &&
    slope8 < 0 &&
    slope16 < 0;

  const direction = trendUp
    ? "RISE"
    : trendDown
    ? "FALL"
    : "";

  const voteUp =
    up6 * 28 +
    up8 * 27 +
    up16 * 25 +
    up32 * 20;

  const voteDown = 100 - voteUp;

  const voteConsensus = Math.max(voteUp, voteDown);

  const trendAgreement =
    direction === "RISE"
      ? clamp(
          50 +
            (ema6 > ema14 ? 15 : -15) +
            (ema14 > ema30 ? 15 : -15) +
            (slope8 > 0 ? 10 : -10) +
            (slope16 > 0 ? 10 : -10)
        )
      : direction === "FALL"
      ? clamp(
          50 +
            (ema6 < ema14 ? 15 : -15) +
            (ema14 < ema30 ? 15 : -15) +
            (slope8 < 0 ? 10 : -10) +
            (slope16 < 0 ? 10 : -10)
        )
      : 20;

  const noise = clamp(
    35 +
      spikeRatio * 7 +
      Math.min(30, volatility16 * 100) -
      Math.abs(up16 - 0.5) * 35
  );

  const reversalRisk = clamp(
    50 -
      Math.abs(slope8) * 500 +
      Math.abs(slope8 - slope16) * 700 +
      Math.max(0, spikeRatio - 3) * 8
  );

  const continuation = clamp(
    trendAgreement * 0.45 +
      voteConsensus * 0.35 +
      Math.max(0, 100 - reversalRisk) * 0.20
  );

  const quality = clamp(
    trendAgreement * 0.38 +
      voteConsensus * 0.28 +
      continuation * 0.24 +
      Math.max(0, 100 - noise) * 0.10
  );

  const weights = {
    quality: Number(learning.weights?.quality || 0.42),
    votes: Number(learning.weights?.votes || 0.22),
    continuation: Number(
      learning.weights?.continuation || 0.20
    ),
    risk: Number(learning.weights?.risk || 0.16),
  };

  const weightTotal = Math.max(
    0.01,
    weights.quality +
      weights.votes +
      weights.continuation +
      weights.risk
  );

  const confidence = clamp(
    (
      quality * weights.quality +
      voteConsensus * weights.votes +
      continuation * weights.continuation +
      Math.max(0, 100 - reversalRisk) *
        weights.risk
    ) / weightTotal
  );

  const adaptiveMinimumConfidence = clamp(
    Number(options.minimumConfidence || 60) +
      Number(learning.confidenceAdjustment || 0),
    54,
    82
  );

  const adaptiveMinimumQuality = clamp(
    Number(options.minimumQuality || 56) +
      Number(learning.qualityAdjustment || 0),
    50,
    78
  );

  const adaptiveMinimumVotes = clamp(
    Number(options.minimumVotes || 56) +
      Number(learning.voteAdjustment || 0),
    52,
    78
  );

  const adaptiveMinimumContinuation = clamp(
    Number(options.minimumContinuation || 54) +
      Number(learning.continuationAdjustment || 0),
    50,
    78
  );

  const hardRisk =
    noise >= Number(options.maximumNoise || 76) ||
    reversalRisk >= Number(options.maximumReversal || 70) ||
    spikeRatio >= Number(options.maximumSpikeRatio || 6);

  const entryReasons = [
    direction ? `EMA structure supports ${direction}` : "EMA structure mixed",
    `votes ${voteConsensus.toFixed(1)}%`,
    `continuation ${continuation.toFixed(1)}%`,
    `noise ${noise.toFixed(1)}%`,
    `reversal ${reversalRisk.toFixed(1)}%`,
    `spike ${spikeRatio.toFixed(2)}x`,
  ];

  const qualified =
    Boolean(direction) &&
    confidence >= adaptiveMinimumConfidence &&
    quality >= adaptiveMinimumQuality &&
    voteConsensus >= adaptiveMinimumVotes &&
    continuation >= adaptiveMinimumContinuation &&
    !hardRisk;

  return {
    ready: true,
    decision: qualified ? "BUY" : "WAIT",
    direction,
    score: quality,
    confidence,
    quality,
    noise,
    reversalRisk,
    continuation,
    voteConsensus,
    spikeRatio,
    entryReasons,
    adaptiveThresholds: {
      confidence: adaptiveMinimumConfidence,
      quality: adaptiveMinimumQuality,
      votes: adaptiveMinimumVotes,
      continuation: adaptiveMinimumContinuation,
    },
    learnedWeights: weights,
    reason: qualified
      ? `${direction} confirmed: ${entryReasons.join(" · ")}.`
      : hardRisk
      ? "Fresh setup rejected by live risk protection."
      : !direction
      ? "EMA structure and slopes are not aligned."
      : "Waiting for stronger confidence, quality and continuation.",
    metrics: {
      ema6,
      ema14,
      ema30,
      slope8,
      slope16,
      slope32,
      up6: up6 * 100,
      up8: up8 * 100,
      up16: up16 * 100,
      up32: up32 * 100,
      volatility16,
      volatility32,
      spikeRatio,
    },
  };
}
