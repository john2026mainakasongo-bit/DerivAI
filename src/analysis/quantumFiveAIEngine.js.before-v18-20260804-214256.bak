import { analyzeQuantumRiseFall } from "./quantumRiseFallEngine";

const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(value) || 0));

function clean(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) =>
      Number(
        typeof item === "number"
          ? item
          : item?.quote ??
              item?.price ??
              item?.value ??
              item?.currentPrice ??
              0
      )
    )
    .filter(Number.isFinite);
}

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values = []) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      values.length
  );
}

function ema(values = [], period = 9) {
  const source = clean(values);
  if (!source.length) return 0;

  const alpha = 2 / (Math.max(2, period) + 1);
  return source.slice(1).reduce(
    (result, value) => value * alpha + result * (1 - alpha),
    source[0]
  );
}

function slope(values = []) {
  const source = clean(values);
  if (source.length < 3) return 0;
  return (source.at(-1) - source[0]) / Math.max(1, source.length - 1);
}

function rsi(values = [], period = 14) {
  const source = clean(values).slice(-(Math.max(2, period) + 1));
  if (source.length < 3) return 50;

  let gains = 0;
  let losses = 0;

  for (let index = 1; index < source.length; index += 1) {
    const delta = source[index] - source[index - 1];
    if (delta > 0) gains += delta;
    if (delta < 0) losses += Math.abs(delta);
  }

  if (!losses) return gains ? 100 : 50;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function changes(values = []) {
  const source = clean(values);
  const output = [];

  for (let index = 1; index < source.length; index += 1) {
    const previous = source[index - 1];
    if (previous) {
      output.push((source[index] - previous) / Math.abs(previous));
    }
  }

  return output;
}

function direction(value, deadZone = 0) {
  if (value > deadZone) return "RISE";
  if (value < -deadZone) return "FALL";
  return "WAIT";
}

function layer(name, signal, score, reason, details = {}) {
  return {
    name,
    signal,
    score: clamp(score),
    reason,
    details,
  };
}

function trendLayer(source) {
  const fast = ema(source, 6);
  const medium = ema(source, 14);
  const slow = ema(source, 30);
  const fastSlope = slope(source.slice(-10));
  const mediumSlope = slope(source.slice(-28));

  const rise =
    fast > medium &&
    medium > slow &&
    fastSlope > 0 &&
    mediumSlope > 0;

  const fall =
    fast < medium &&
    medium < slow &&
    fastSlope < 0 &&
    mediumSlope < 0;

  const signal = rise ? "RISE" : fall ? "FALL" : "WAIT";
  const separation =
    Math.abs(fast - medium) +
    Math.abs(medium - slow);

  return layer(
    "Trend AI",
    signal,
    signal === "WAIT"
      ? 36
      : 62 + Math.min(30, separation * 12000),
    signal === "WAIT"
      ? "EMA structure is mixed."
      : `${signal} EMA stack and slopes agree.`,
    { fast, medium, slow, fastSlope, mediumSlope }
  );
}

function momentumLayer(source) {
  const short = source.slice(-6);
  const medium = source.slice(-18);

  const shortMove = short.at(-1) - short[0];
  const mediumMove = medium.at(-1) - medium[0];
  const acceleration = shortMove - mediumMove / 3;
  const currentRsi = rsi(source, 14);

  const aligned =
    Math.sign(shortMove) === Math.sign(mediumMove) &&
    Math.sign(shortMove) === Math.sign(acceleration);

  const notExtended =
    (shortMove > 0 && currentRsi < 76) ||
    (shortMove < 0 && currentRsi > 24);

  const signal =
    aligned && notExtended
      ? direction(shortMove)
      : "WAIT";

  const scale =
    Math.abs(shortMove) /
    Math.max(
      1e-9,
      std(changes(medium)) *
        Math.max(1, Math.abs(mean(medium)))
    );

  return layer(
    "Momentum AI",
    signal,
    signal === "WAIT"
      ? 38
      : 64 + Math.min(28, scale * 8),
    signal === "WAIT"
      ? "Impulse, acceleration, or RSI is not aligned."
      : `${signal} impulse and acceleration agree.`,
    { shortMove, mediumMove, acceleration, rsi: currentRsi }
  );
}

function reversalLayer(source, base) {
  const recent = source.slice(-55);
  const support = Math.min(...recent);
  const resistance = Math.max(...recent);
  const range = Math.max(1e-9, resistance - support);
  const last = recent.at(-1);
  const position = (last - support) / range;
  const candidate = base.candidate || "WAIT";
  const currentRsi = rsi(source, 14);

  const riseSafe =
    candidate === "RISE" &&
    position <= 0.82 &&
    currentRsi < 74;

  const fallSafe =
    candidate === "FALL" &&
    position >= 0.18 &&
    currentRsi > 26;

  const accepted =
    (riseSafe || fallSafe) &&
    Number(base.reversalRisk || 100) <= 52;

  return layer(
    "Reversal AI",
    accepted ? candidate : "WAIT",
    accepted
      ? 68 + Math.min(24, 52 - Number(base.reversalRisk || 52))
      : 34,
    accepted
      ? `${candidate} has room before the nearest extreme.`
      : "Price is extended or reversal risk is too high.",
    {
      support,
      resistance,
      position: position * 100,
      rsi: currentRsi,
    }
  );
}

function patternLayer(source) {
  const recent = source.slice(-24);
  const micro = source.slice(-8);

  const microSlope = slope(micro);
  const shortSlope = slope(recent);
  const last = source.at(-1);
  const previous = source.at(-2);
  const before = source.at(-3);

  const higherHigh =
    last > previous &&
    previous > before &&
    microSlope > 0;

  const lowerLow =
    last < previous &&
    previous < before &&
    microSlope < 0;

  const breakoutUp =
    last >= Math.max(...recent.slice(0, -1)) &&
    shortSlope > 0;

  const breakoutDown =
    last <= Math.min(...recent.slice(0, -1)) &&
    shortSlope < 0;

  const signal =
    higherHigh || breakoutUp
      ? "RISE"
      : lowerLow || breakoutDown
      ? "FALL"
      : "WAIT";

  const score =
    signal === "WAIT"
      ? 40
      : breakoutUp || breakoutDown
      ? 80
      : 70;

  return layer(
    "Pattern AI",
    signal,
    score,
    signal === "WAIT"
      ? "No clean continuation or breakout pattern."
      : breakoutUp || breakoutDown
      ? `${signal} breakout pattern detected.`
      : `${signal} three-step continuation detected.`,
    { microSlope, shortSlope }
  );
}

function probabilityLayer(source, base) {
  const recent = source.slice(-70);
  let upUp = 0;
  let upDown = 0;
  let downDown = 0;
  let downUp = 0;

  for (let index = 2; index < recent.length; index += 1) {
    const previous =
      Math.sign(recent[index - 1] - recent[index - 2]);
    const current =
      Math.sign(recent[index] - recent[index - 1]);

    if (previous > 0 && current > 0) upUp += 1;
    if (previous > 0 && current < 0) upDown += 1;
    if (previous < 0 && current < 0) downDown += 1;
    if (previous < 0 && current > 0) downUp += 1;
  }

  const upContinuation =
    upUp / Math.max(1, upUp + upDown);

  const downContinuation =
    downDown / Math.max(1, downDown + downUp);

  const strongest =
    Math.max(upContinuation, downContinuation);

  const transitionSignal =
    strongest >= 0.58
      ? upContinuation > downContinuation
        ? "RISE"
        : "FALL"
      : "WAIT";

  const candidate = base.candidate || "WAIT";

  const accepted =
    transitionSignal !== "WAIT" &&
    transitionSignal === candidate;

  return layer(
    "Probability AI",
    accepted ? transitionSignal : "WAIT",
    accepted ? strongest * 100 : 42,
    accepted
      ? `${transitionSignal} continuation probability ${(strongest * 100).toFixed(0)}%.`
      : "Transition probability does not confirm the candidate.",
    {
      upContinuation: upContinuation * 100,
      downContinuation: downContinuation * 100,
    }
  );
}

function chooseDuration({
  score,
  agreement,
  noise,
  reversal,
  consistency,
}) {
  if (
    agreement === 5 &&
    score >= 88 &&
    noise <= 42 &&
    reversal <= 30 &&
    consistency >= 48
  ) {
    return {
      duration: 5,
      durationUnit: "s",
      displayDuration: "5 SECONDS",
    };
  }

  if (
    agreement >= 4 &&
    score >= 80 &&
    noise <= 50 &&
    reversal <= 38
  ) {
    return {
      duration: 10,
      durationUnit: "s",
      displayDuration: "10 SECONDS",
    };
  }

  if (
    agreement >= 3 &&
    score >= 72 &&
    noise <= 60
  ) {
    return {
      duration: 15,
      durationUnit: "s",
      displayDuration: "15 SECONDS",
    };
  }

  return {
    duration: 20,
    durationUnit: "s",
    displayDuration: "20 SECONDS",
  };
}

export function analyzeQuantumFiveAI(prices = [], options = {}) {
  const source = clean(prices).slice(-260);
  const base = analyzeQuantumRiseFall(source, options);

  if (source.length < 55) {
    return {
      ...base,
      fiveAI: {
        models: [],
        agreement: 0,
        required: 3,
        signal: "WAIT",
      },
      scoreBreakdown: {
        trend: 0,
        momentum: 0,
        reversal: 0,
        pattern: 0,
        probability: 0,
        total: 0,
      },
    };
  }

  const layers = [
    trendLayer(source),
    momentumLayer(source),
    reversalLayer(source, base),
    patternLayer(source),
    probabilityLayer(source, base),
  ];

  const rise = layers.filter((item) => item.signal === "RISE");
  const fall = layers.filter((item) => item.signal === "FALL");

  const winningLayers =
    rise.length > fall.length ? rise : fall;

  const candidate =
    winningLayers === rise ? "RISE" : "FALL";

  const agreement = winningLayers.length;

  const weightedScores = {
    trend:
      layers.find((item) => item.name === "Trend AI")?.score || 0,
    momentum:
      layers.find((item) => item.name === "Momentum AI")?.score || 0,
    reversal:
      layers.find((item) => item.name === "Reversal AI")?.score || 0,
    pattern:
      layers.find((item) => item.name === "Pattern AI")?.score || 0,
    probability:
      layers.find((item) => item.name === "Probability AI")?.score || 0,
  };

  const totalScore = clamp(
    weightedScores.trend * 0.22 +
      weightedScores.momentum * 0.22 +
      weightedScores.reversal * 0.18 +
      weightedScores.pattern * 0.18 +
      weightedScores.probability * 0.2
  );

  const noise = Number(base.noiseScore || 100);
  const reversal = Number(base.reversalRisk || 100);
  const consistency = Number(base.consistency || 0);
  const voteConsensus = Number(
    base.metrics?.voteConsensus || 0
  );

  const hardSafetyGate =
    noise <= 68 &&
    reversal <= 60 &&
    consistency >= 18 &&
    voteConsensus >= 56;

  const ready =
    agreement >= 3 &&
    totalScore >= 72 &&
    hardSafetyGate;

  const durationPlan = chooseDuration({
    score: totalScore,
    agreement,
    noise,
    reversal,
    consistency,
  });

  const checks = [
    ...(base.checks || []),
    {
      label: "Five-layer agreement",
      passed: agreement >= 3,
      value: `${agreement}/5`,
    },
    {
      label: "AI total score",
      passed: totalScore >= 72,
      value: `${totalScore.toFixed(1)}/100`,
    },
    {
      label: "Hard safety gate",
      passed: hardSafetyGate,
      value: hardSafetyGate ? "PASS" : "BLOCK",
    },
  ];

  return {
    ...base,
    ready,
    decision: ready ? candidate : "WAIT",
    candidate,
    confidence: totalScore,
    duration: durationPlan.duration,
    durationUnit: durationPlan.durationUnit,
    displayDuration: durationPlan.displayDuration,
    entryMode: ready ? "SCORE-AI" : "WAIT",
    reason: ready
      ? `${agreement}/5 AI layers confirm ${candidate}. Total score ${totalScore.toFixed(1)}/100.`
      : `WAIT: ${agreement}/5 layers agree, score ${totalScore.toFixed(1)}/100, safety ${hardSafetyGate ? "PASS" : "BLOCK"}.`,
    checks,
    fiveAI: {
      models: layers.map((item) => ({
        name: item.name,
        signal: item.signal,
        confidence: item.score,
        reason: item.reason,
      })),
      agreement,
      required: 3,
      signal: ready ? candidate : "WAIT",
      candidate,
      confidence: totalScore,
      hardRiskGate: hardSafetyGate,
    },
    scoreBreakdown: {
      ...weightedScores,
      total: totalScore,
    },
    metrics: {
      ...(base.metrics || {}),
      fiveAIAgreement: agreement,
      fiveAIConfidence: totalScore,
    },
  };
}
