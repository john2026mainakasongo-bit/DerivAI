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
  return Math.sqrt(mean(values.map((value) => (Number(value) - average) ** 2)));
}

function pointQuote(point) {
  const value = Number(point?.quote ?? point?.price ?? point);
  return Number.isFinite(value) ? value : null;
}

function pointTime(point, index = 0) {
  const raw = point?.epoch ?? point?.time ?? point?.timestamp ?? point?.createdAt;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 100000000000 ? numeric : numeric * 1000;
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
  const differences = values.slice(1).map((value, index) => value - values[index]);
  const positive = differences.filter((value) => value > 0).length;
  const negative = differences.filter((value) => value < 0).length;
  return clamp((Math.max(positive, negative) / Math.max(1, differences.length)) * 100);
}

function reversals(values = []) {
  if (values.length < 4) return 0;
  const signs = values.slice(1).map((value, index) => Math.sign(value - values[index]));
  let count = 0;
  for (let i = 1; i < signs.length; i += 1) {
    if (signs[i] && signs[i - 1] && signs[i] !== signs[i - 1]) count += 1;
  }
  return count;
}

function windowForMode(points, mode) {
  if (mode === '10ticks') return points.slice(-10);
  const latest = points.at(-1)?.time || 0;
  const timed = points.filter((point) => latest - point.time <= 15000);
  return timed.length >= 5 ? timed : points.slice(-15);
}

function momentumWindows(values = []) {
  const move = (count) => {
    const sample = values.slice(-Math.min(count, values.length));
    if (sample.length < 2) return 0;
    return sample.at(-1) - sample[0];
  };
  return { fast: move(3), medium: move(5), slow: move(10) };
}

export function analyzeRiseFall(prices = [], mode = '15s') {
  const points = normalizedPoints(prices);
  const sample = windowForMode(points, mode);
  const values = sample.map((point) => point.quote);

  if (values.length < 5) {
    return {
      signal: 'WAIT', confidence: 0, risk: 'WAITING', samples: values.length,
      reason: `Collecting ${mode === '10ticks' ? '10 ticks' : '15 seconds'} of live prices.`,
      points: sample,
    };
  }

  const first = values[0];
  const last = values.at(-1);
  const netMove = last - first;
  const linearSlope = slope(values);
  const changes = values.slice(1).map((value, index) => value - values[index]);
  const volatility = stdDev(changes);
  const consistency = directionConsistency(values);
  const reversalCount = reversals(values);
  const momentum = momentumWindows(values);
  const agreement = [momentum.fast, momentum.medium, momentum.slow]
    .map(Math.sign)
    .filter((value) => value !== 0);
  const riseVotes = agreement.filter((value) => value > 0).length;
  const fallVotes = agreement.filter((value) => value < 0).length;
  const dominantVotes = Math.max(riseVotes, fallVotes);
  const direction = netMove > 0 && linearSlope > 0 ? 'RISE' : netMove < 0 && linearSlope < 0 ? 'FALL' : 'WAIT';

  const normalizedMove = volatility > 0 ? Math.abs(netMove) / volatility : 0;
  const trendStrength = clamp(normalizedMove * 14);
  const reversalPenalty = clamp(reversalCount * 8, 0, 35);
  const voteScore = dominantVotes / 3 * 100;
  const confidence = clamp(
    consistency * 0.34 +
    trendStrength * 0.28 +
    voteScore * 0.25 +
    Math.min(100, values.length * 5) * 0.13 -
    reversalPenalty,
    0,
    96
  );

  const ready = direction !== 'WAIT' && confidence >= 72 && dominantVotes >= 2 && consistency >= 62;
  const signal = ready ? direction : 'WAIT';
  const risk = ready ? (confidence >= 84 && reversalCount <= 1 ? 'LOW' : 'MEDIUM') : 'HIGH';

  return {
    signal,
    rawDirection: direction,
    confidence,
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
    momentum,
    points: sample,
    ready,
    reason: ready
      ? `${direction} setup aligned across momentum, slope and direction consistency.`
      : direction === 'WAIT'
        ? 'Direction is mixed. Continue collecting fresh prices.'
        : `${direction} is forming, but confirmation is not strong enough yet.`,
  };
}

export default analyzeRiseFall;
