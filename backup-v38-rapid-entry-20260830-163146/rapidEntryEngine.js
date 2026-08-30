const DIGITS = Array.from({ length: 10 }, (_, i) => i);

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}

function cleanDigits(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
}

function digitFromPrice(value, decimals = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const text = n.toFixed(Math.max(0, decimals)).replace(/\D/g, "");
  return text ? Number(text.at(-1)) : null;
}

function pricesFromInput(input = {}) {
  return (Array.isArray(input.prices) ? input.prices : [])
    .map((item) => ({
      quote: Number(item?.quote ?? item?.price ?? item),
      epoch: Number(item?.epoch ?? item?.time ?? 0),
    }))
    .filter((item) => Number.isFinite(item.quote));
}

function windowForSeconds(prices, seconds) {
  const now = Number(prices.at(-1)?.epoch || Date.now() / 1000);
  const cutoff = now - seconds;
  const byTime = prices.filter((item) => !item.epoch || item.epoch >= cutoff);
  return byTime.length >= 8 ? byTime : prices.slice(-Math.max(8, Math.min(prices.length, seconds)));
}

function entropyPercent(digits) {
  if (!digits.length) return 100;
  const counts = Array(10).fill(0);
  digits.forEach((d) => { counts[d] += 1; });
  const n = digits.length;
  const h = counts.reduce((sum, c) => {
    if (!c) return sum;
    const p = c / n;
    return sum - p * Math.log2(p);
  }, 0);
  return clamp((h / Math.log2(10)) * 100, 0, 100);
}

function transitionStats(digits) {
  const current = digits.at(-1);
  let total = 0;
  const next = Array(10).fill(0);
  for (let i = 0; i < digits.length - 1; i += 1) {
    if (digits[i] === current) {
      total += 1;
      next[digits[i + 1]] += 1;
    }
  }
  return { total, next };
}

function directionScore(prices) {
  if (prices.length < 6) return { strength: 0, direction: "FLAT" };
  const closes = prices.map((p) => p.quote);
  const first = closes[0];
  const last = closes.at(-1);
  const moves = closes.slice(1).map((v, i) => v - closes[i]);
  const up = moves.filter((v) => v > 0).length;
  const down = moves.filter((v) => v < 0).length;
  const range = Math.max(...closes) - Math.min(...closes) || 1;
  const displacement = Math.abs(last - first) / range;
  const balance = Math.abs(up - down) / Math.max(1, moves.length);
  const strength = clamp(35 + displacement * 45 + balance * 30);
  return {
    strength,
    direction: last > first ? "UP" : last < first ? "DOWN" : "FLAT",
  };
}

function autocorrelationScore(digits) {
  if (digits.length < 8) return 0;
  let same = 0;
  for (let i = 1; i < digits.length; i += 1) {
    if (digits[i] === digits[i - 1]) same += 1;
  }
  return clamp(50 + ((same / (digits.length - 1)) - 0.1) * 100);
}

function candidateQuality({ probability, baseline, recentProbability, transitionProbability, direction, consistency, entropy, samples }) {
  const edge = probability - baseline;
  const recentEdge = recentProbability - baseline;
  const transitionEdge = transitionProbability - baseline;
  const momentumBonus = Math.min(10, Math.abs(direction) * 0.08);
  const entropyQuality = clamp(100 - Math.max(0, entropy - 97) * 12);
  return clamp(
    56 +
      edge * 0.95 +
      recentEdge * 0.55 +
      transitionEdge * 0.45 +
      consistency * 0.12 +
      entropyQuality * 0.08 +
      momentumBonus +
      Math.min(8, samples / 6)
  );
}

function makeCandidates(digits, prices) {
  const n = digits.length;
  const recent = digits.slice(-Math.min(12, n));
  const ultra = digits.slice(-Math.min(5, n));
  const { total: transitionCount, next } = transitionStats(digits);
  const current = digits.at(-1);
  const direction = directionScore(prices);
  const entropy = entropyPercent(digits);
  const autocorrelation = autocorrelationScore(digits);
  const candidates = [];

  const pct = (list, predicate) => list.length ? (list.filter(predicate).length / list.length) * 100 : 0;
  const consistencyFor = (a, b) => clamp(100 - Math.abs(a - b) * 1.6);

  for (let barrier = 1; barrier <= 7; barrier += 1) {
    const over = pct(digits, (d) => d > barrier);
    const overRecent = pct(recent, (d) => d > barrier);
    const overUltra = pct(ultra, (d) => d > barrier);
    const under = pct(digits, (d) => d < barrier);
    const underRecent = pct(recent, (d) => d < barrier);
    const underUltra = pct(ultra, (d) => d < barrier);

    const overTransition = current == null || !transitionCount
      ? overRecent
      : (next.reduce((sum, c, d) => sum + (d > barrier ? c : 0), 0) / transitionCount) * 100;
    const underTransition = current == null || !transitionCount
      ? underRecent
      : (next.reduce((sum, c, d) => sum + (d < barrier ? c : 0), 0) / transitionCount) * 100;

    const overConsistency = consistencyFor(overRecent, overUltra);
    const underConsistency = consistencyFor(underRecent, underUltra);
    const overScore = candidateQuality({
      probability: over,
      baseline: (9 - barrier) * 10,
      recentProbability: overRecent,
      transitionProbability: overTransition,
      direction: direction.direction === "UP" ? direction.strength : 0,
      consistency: overConsistency,
      entropy,
      samples: n,
    });
    const underScore = candidateQuality({
      probability: under,
      baseline: barrier * 10,
      recentProbability: underRecent,
      transitionProbability: underTransition,
      direction: direction.direction === "DOWN" ? direction.strength : 0,
      consistency: underConsistency,
      entropy,
      samples: n,
    });

    candidates.push({
      setup: `OVER ${barrier}`,
      action: `OVER ${barrier}`,
      family: "OVER_UNDER",
      contractType: "DIGITOVER",
      barrier: String(barrier),
      probability: over,
      confidence: overScore,
      edge: Math.max(0, over - (9 - barrier) * 10),
      score: overScore,
      samples: n,
      transitionCount,
      passedVotes: [over >= (9 - barrier) * 10 + 2, overRecent >= (9 - barrier) * 10 + 2, overTransition >= (9 - barrier) * 10 + 1, overConsistency >= 70].filter(Boolean).length,
      requiredVotes: 2,
      entropy,
      momentumStrength: direction.strength,
      regimeStrength: overConsistency,
      autocorrelation,
      source: `RAPID_${n >= 40 ? "60S" : "30S"}`,
      fastEntry: true,
      rapidEntry: true,
      timeframeSeconds: n >= 40 ? 60 : 30,
      rowPressure: overRecent > underRecent + 5 ? "LOWER_TO_UPPER" : underRecent > overRecent + 5 ? "UPPER_TO_LOWER" : "BALANCED",
    });

    candidates.push({
      setup: `UNDER ${barrier}`,
      action: `UNDER ${barrier}`,
      family: "OVER_UNDER",
      contractType: "DIGITUNDER",
      barrier: String(barrier),
      probability: under,
      confidence: underScore,
      edge: Math.max(0, under - barrier * 10),
      score: underScore,
      samples: n,
      transitionCount,
      passedVotes: [under >= barrier * 10 + 2, underRecent >= barrier * 10 + 2, underTransition >= barrier * 10 + 1, underConsistency >= 70].filter(Boolean).length,
      requiredVotes: 2,
      entropy,
      momentumStrength: direction.strength,
      regimeStrength: underConsistency,
      autocorrelation,
      source: `RAPID_${n >= 40 ? "60S" : "30S"}`,
      fastEntry: true,
      rapidEntry: true,
      timeframeSeconds: n >= 40 ? 60 : 30,
      rowPressure: underRecent > overRecent + 5 ? "UPPER_TO_LOWER" : overRecent > underRecent + 5 ? "LOWER_TO_UPPER" : "BALANCED",
    });
  }

  const even = pct(digits, (d) => d % 2 === 0);
  const odd = 100 - even;
  const evenRecent = pct(recent, (d) => d % 2 === 0);
  const oddRecent = 100 - evenRecent;
  for (const [setup, probability, recentProbability, type] of [["EVEN", even, evenRecent, "DIGITEVEN"], ["ODD", odd, oddRecent, "DIGITODD"]]) {
    const baseline = 50;
    const consistency = consistencyFor(probability, recentProbability);
    const score = candidateQuality({ probability, baseline, recentProbability, transitionProbability: recentProbability, direction: 0, consistency, entropy, samples: n });
    candidates.push({
      setup,
      action: setup,
      family: "PARITY",
      contractType: type,
      probability,
      confidence: score,
      edge: Math.max(0, probability - baseline),
      score,
      samples: n,
      transitionCount,
      passedVotes: [probability >= 53, recentProbability >= 53, consistency >= 70].filter(Boolean).length,
      requiredVotes: 2,
      entropy,
      momentumStrength: direction.strength,
      regimeStrength: consistency,
      autocorrelation,
      source: `RAPID_${n >= 40 ? "60S" : "30S"}`,
      fastEntry: true,
      rapidEntry: true,
      timeframeSeconds: n >= 40 ? 60 : 30,
    });
  }

  return candidates.sort((a, b) => (b.score - a.score) || (b.edge - a.edge));
}

export function analyzeRapidEntry(input = {}, timeframeSeconds = 30) {
  const safeTimeframe = Number(timeframeSeconds) === 60 ? 60 : 30;
  const rawDigits = Array.isArray(input?.digits)
    ? input.digits
    : Array.isArray(input?.history)
      ? input.history
      : [];
  const digits = rawDigits
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 9);

  if (digits.length < (safeTimeframe === 60 ? 28 : 18)) {
    return {
      ok: false,
      executable: false,
      reason: `Insufficient digit history for RAPID_${safeTimeframe === 60 ? "60S" : "30S"} analysis.`,
      timeframeSeconds: safeTimeframe,
      sampleSize: digits.length,
      minimumSamples: safeTimeframe === 60 ? 28 : 18,
      candidates: [],
      best: null,
      confidence: 0,
      probability: 0,
      edge: 0,
      transitionCount: 0,
      confirmations: 0,
      requiredConfirmations: 2,
    };
  }

  const normalizedInput = {
    ...input,
    digits,
  };
  const prices = pricesFromInput(input);
  const window = windowForSeconds(prices, Number(timeframeSeconds) === 60 ? 60 : 30);
  // Timeframe means real elapsed time, not "last N digits". Deriv 1s indices
  // can have a long history buffer, so always derive the rapid window from
  // the timestamps of the price ticks.
  const digits = window
    .map((p) => digitFromPrice(p.quote, Number(input.decimals ?? 3)))
    .filter(Number.isInteger);

  const minSamples = Number(timeframeSeconds) === 60 ? 28 : 18;
  const candidates = makeCandidates(digits, window);
  const best = candidates[0] || null;
  const executable = Boolean(
    best &&
    digits.length >= minSamples &&
    best.edge >= 2 &&
    best.confidence >= 68 &&
    best.passedVotes >= 2 &&
    best.transitionCount >= 2
  );

  return {
    timeframeSeconds: Number(timeframeSeconds) === 60 ? 60 : 30,
    sampleSize: digits.length,
    minimumSamples: minSamples,
    candidates,
    best: executable ? best : null,
    executable,
    confidence: best?.confidence || 0,
    probability: best?.probability || 0,
    edge: best?.edge || 0,
    transitionCount: best?.transitionCount || 0,
    momentum: {
      direction: directionScore(window).direction,
      strength: directionScore(window).strength,
    },
    regime: {
      label: entropyPercent(digits) > 98.8 ? "HIGH_ENTROPY" : "STRUCTURED",
      stability: best?.regimeStrength || 0,
    },
    entropy: { percentage: entropyPercent(digits) },
    autocorrelation: { strength: autocorrelationScore(digits) },
    reason: executable
      ? `Rapid ${Number(timeframeSeconds) === 60 ? "1-minute" : "30-second"} edge ready: ${best.setup} Â· ${best.confidence.toFixed(1)}% confidence Â· +${best.edge.toFixed(1)}pp edge.`
      : `Scanning ${Number(timeframeSeconds) === 60 ? "1-minute" : "30-second"} window: ${digits.length}/${minSamples} samples, best edge +${(best?.edge || 0).toFixed(1)}pp.`,
  };
}

export default analyzeRapidEntry;

