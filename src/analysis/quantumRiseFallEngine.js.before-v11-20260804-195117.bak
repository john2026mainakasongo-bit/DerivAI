const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(value) || 0));

function clean(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
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

function linearSlope(values = []) {
  const source = clean(values);
  const count = source.length;
  if (count < 3) return 0;

  const xMean = (count - 1) / 2;
  const yMean = mean(source);
  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < count; index += 1) {
    numerator += (index - xMean) * (source[index] - yMean);
    denominator += (index - xMean) ** 2;
  }

  return denominator ? numerator / denominator : 0;
}

function directionConsistency(values = []) {
  const source = clean(values);
  if (source.length < 3) return { up: 0, down: 0, score: 0 };

  let up = 0;
  let down = 0;
  for (let index = 1; index < source.length; index += 1) {
    if (source[index] > source[index - 1]) up += 1;
    if (source[index] < source[index - 1]) down += 1;
  }

  const total = Math.max(1, up + down);
  return {
    up,
    down,
    score: Math.abs(up - down) / total,
  };
}

function changes(values = []) {
  const source = clean(values);
  const output = [];
  for (let index = 1; index < source.length; index += 1) {
    const previous = source[index - 1];
    if (previous) output.push((source[index] - previous) / Math.abs(previous));
  }
  return output;
}

function selectDuration({ confidence, volatility, consistency, impulse }) {
  if (confidence >= 91 && consistency >= 0.62 && impulse >= 0.68) return 15;
  if (confidence >= 86 && consistency >= 0.52) return 20;
  if (volatility >= 70 || consistency < 0.4) return 60;
  return 30;
}

export function analyzeQuantumRiseFall(prices = [], options = {}) {
  const source = clean(prices).slice(-240);
  const minimumSamples = Math.max(30, Number(options.minimumSamples) || 55);

  if (source.length < minimumSamples) {
    return {
      decision: "WAIT",
      ready: false,
      confidence: 0,
      duration: 30,
      reason: `Collecting ticks (${source.length}/${minimumSamples})`,
      regime: "LEARNING",
      trend: "NEUTRAL",
      momentum: "LOW",
      noise: "HIGH",
      volatility: 0,
      consistency: 0,
      reversalRisk: 100,
      votes: { rise: 0, fall: 0 },
      metrics: {},
    };
  }

  const fastWindow = source.slice(-18);
  const mediumWindow = source.slice(-42);
  const slowWindow = source.slice(-90);
  const last = source.at(-1);
  const fastEma = ema(source, 6);
  const mediumEma = ema(source, 14);
  const slowEma = ema(source, 30);
  const fastSlope = linearSlope(fastWindow);
  const mediumSlope = linearSlope(mediumWindow);
  const slowSlope = linearSlope(slowWindow);
  const consistencyData = directionConsistency(fastWindow);
  const returns = changes(mediumWindow);
  const volatilityRaw = std(returns);
  const volatility = clamp(volatilityRaw * 160000);
  const noise = clamp(
    100 - consistencyData.score * 80 + (volatility > 82 ? 15 : 0)
  );
  const currentRsi = rsi(source, 14);
  const recentMove = fastWindow.at(-1) - fastWindow[0];
  const baselineMove = Math.abs(mediumWindow.at(-1) - mediumWindow[0]) || 1e-9;
  const impulse = clamp(Math.abs(recentMove) / baselineMove * 100) / 100;

  let riseVotes = 0;
  let fallVotes = 0;
  const vote = (condition, riseWeight = 1, fallWeight = 1) => {
    if (condition > 0) riseVotes += riseWeight;
    if (condition < 0) fallVotes += fallWeight;
  };

  vote(fastEma - mediumEma, 1.25, 1.25);
  vote(mediumEma - slowEma, 1.1, 1.1);
  vote(fastSlope, 1.3, 1.3);
  vote(mediumSlope, 1.15, 1.15);
  vote(slowSlope, 0.8, 0.8);
  vote(recentMove, 1.15, 1.15);
  vote(last - fastEma, 0.75, 0.75);
  vote(consistencyData.up - consistencyData.down, 1.1, 1.1);

  if (currentRsi > 54 && currentRsi < 78) riseVotes += 0.75;
  if (currentRsi < 46 && currentRsi > 22) fallVotes += 0.75;

  const totalVotes = Math.max(1, riseVotes + fallVotes);
  const winningVotes = Math.max(riseVotes, fallVotes);
  const voteConsensus = winningVotes / totalVotes;
  const direction = riseVotes > fallVotes ? "RISE" : "FALL";

  const extendedRise = currentRsi >= 78 && direction === "RISE";
  const extendedFall = currentRsi <= 22 && direction === "FALL";
  const slopeConflict =
    Math.sign(fastSlope) !== Math.sign(mediumSlope) ||
    Math.sign(mediumSlope) !== Math.sign(slowSlope);
  const reversalRisk = clamp(
    (extendedRise || extendedFall ? 45 : 0) +
      (slopeConflict ? 32 : 0) +
      noise * 0.28
  );

  const trendStrength = clamp(
    consistencyData.score * 55 + voteConsensus * 35 + impulse * 15
  );
  const confidence = clamp(
    35 +
      voteConsensus * 36 +
      consistencyData.score * 24 +
      Math.min(1, impulse) * 12 -
      noise * 0.2 -
      reversalRisk * 0.18
  );

  const minConfidence = clamp(options.minConfidence || 82, 55, 98);
  const maxNoise = clamp(options.maxNoise || 58, 20, 90);
  const maxReversalRisk = clamp(options.maxReversalRisk || 52, 15, 90);
  const fastMediumAgree = Math.sign(fastSlope) === Math.sign(mediumSlope);
  const strictReady =
    confidence >= minConfidence &&
    noise <= maxNoise &&
    reversalRisk <= maxReversalRisk &&
    voteConsensus >= 0.64 &&
    consistencyData.score >= 0.34 &&
    !slopeConflict;

  // Fast lane keeps the bot responsive without buying on a single indicator.
  // It still requires aligned fast/medium trend, majority votes and acceptable risk.
  const fastReady =
    confidence >= Math.max(62, minConfidence - 10) &&
    noise <= Math.min(78, maxNoise + 10) &&
    reversalRisk <= Math.min(72, maxReversalRisk + 10) &&
    voteConsensus >= 0.58 &&
    consistencyData.score >= 0.24 &&
    fastMediumAgree;

  const ready = strictReady || fastReady;

  const regime =
    noise >= 72
      ? "CHAOTIC"
      : volatility >= 72
      ? "HIGH VOLATILITY"
      : trendStrength >= 68
      ? "TREND"
      : "RANGE";

  const duration = selectDuration({
    confidence,
    volatility,
    consistency: consistencyData.score,
    impulse,
  });

  const reason = ready
    ? `${strictReady ? "STRONG" : "FAST"} ${direction} entry: ${winningVotes.toFixed(1)} weighted votes, ${(voteConsensus * 100).toFixed(0)}% consensus.`
    : slopeConflict
    ? "WAIT: fast, medium and slow trends disagree."
    : noise > maxNoise
    ? `WAIT: market noise is ${noise.toFixed(0)}%.`
    : reversalRisk > maxReversalRisk
    ? `WAIT: reversal risk is ${reversalRisk.toFixed(0)}%.`
    : `WAIT: confidence ${confidence.toFixed(1)}% is below ${minConfidence}%.`;

  return {
    decision: ready ? direction : "WAIT",
    candidate: direction,
    ready,
    confidence,
    duration,
    reason,
    regime,
    trend:
      trendStrength >= 72
        ? direction === "RISE"
          ? "STRONG UP"
          : "STRONG DOWN"
        : direction === "RISE"
        ? "UP"
        : "DOWN",
    momentum: impulse >= 0.72 ? "STRONG" : impulse >= 0.4 ? "MEDIUM" : "LOW",
    noise: noise >= 70 ? "HIGH" : noise >= 48 ? "MEDIUM" : "LOW",
    noiseScore: noise,
    volatility,
    consistency: consistencyData.score * 100,
    reversalRisk,
    entryMode: strictReady ? "STRONG" : fastReady ? "FAST" : "WAIT",
    thresholds: { minConfidence, maxNoise, maxReversalRisk },
    checks: [
      { label: "Confidence", passed: confidence >= Math.max(62, minConfidence - 10), value: `${confidence.toFixed(1)}%` },
      { label: "Noise", passed: noise <= Math.min(78, maxNoise + 10), value: `${noise.toFixed(0)}%` },
      { label: "Reversal", passed: reversalRisk <= Math.min(72, maxReversalRisk + 10), value: `${reversalRisk.toFixed(0)}%` },
      { label: "Vote consensus", passed: voteConsensus >= 0.58, value: `${(voteConsensus * 100).toFixed(0)}%` },
      { label: "Tick consistency", passed: consistencyData.score >= 0.24, value: `${(consistencyData.score * 100).toFixed(0)}%` },
      { label: "Fast/medium trend", passed: fastMediumAgree, value: fastMediumAgree ? "AGREE" : "CONFLICT" },
      { label: "Full timeframe", passed: !slopeConflict, value: slopeConflict ? "MIXED" : "AGREE" },
    ],
    votes: { rise: riseVotes, fall: fallVotes },
    metrics: {
      rsi: currentRsi,
      fastEma,
      mediumEma,
      slowEma,
      fastSlope,
      mediumSlope,
      slowSlope,
      impulse: impulse * 100,
      trendStrength,
      voteConsensus: voteConsensus * 100,
    },
  };
}

export function rankQuantumMarket(snapshot = {}) {
  const analysis = analyzeQuantumRiseFall(snapshot.prices || [], snapshot.options);
  return {
    symbol: snapshot.symbol || "",
    label: snapshot.label || snapshot.symbol || "Unknown market",
    score: analysis.ready
      ? clamp(analysis.confidence + (100 - analysis.noiseScore) * 0.08)
      : clamp(analysis.confidence - analysis.reversalRisk * 0.12),
    analysis,
    updatedAt: Date.now(),
  };
}
