function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function digitFromPrice(value) {
  const text = String(value ?? "").replace(/\D/g, "");
  return text ? Number(text.at(-1)) : 0;
}

function normalizePrices(prices = []) {
  return (Array.isArray(prices) ? prices : [])
    .map((item) =>
      typeof item === "number"
        ? item
        : Number(item?.quote ?? item?.price ?? item?.value ?? item?.tick ?? 0)
    )
    .filter(Number.isFinite);
}

function percent(count, total) {
  return total > 0 ? (count / total) * 100 : 0;
}

function transitionProbability(digits, side, barrier) {
  if (digits.length < 8) return 0;

  const wins = (digit) =>
    side === "OVER" ? digit > barrier : digit < barrier;

  let samples = 0;
  let winsAfter = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (!wins(digits[index - 1])) continue;
    samples += 1;
    if (wins(digits[index])) winsAfter += 1;
  }

  return percent(winsAfter, samples);
}

function exactRisk(digits, barrier) {
  return percent(
    digits.filter((digit) => digit === barrier).length,
    digits.length
  );
}

function scoreCandidate(digits, side, barrier) {
  const historical = digits.slice(-160);
  const fast = digits.slice(-24);
  const trigger = digits.slice(-6);

  const wins = (digit) =>
    side === "OVER" ? digit > barrier : digit < barrier;

  const historicalProbability = percent(
    historical.filter(wins).length,
    historical.length
  );
  const fastProbability = percent(
    fast.filter(wins).length,
    fast.length
  );
  const triggerProbability = percent(
    trigger.filter(wins).length,
    trigger.length
  );
  const transition = transitionProbability(historical.slice(-80), side, barrier);
  const risk = exactRisk(historical, barrier);

  const preferredBarrier =
    (side === "OVER" && barrier <= 2) ||
    (side === "UNDER" && barrier >= 6);

  const score = clamp(
    historicalProbability * 0.35 +
    fastProbability * 0.25 +
    triggerProbability * 0.15 +
    transition * 0.2 +
    (100 - risk) * 0.05 +
    (preferredBarrier ? 4 : 0)
  );

  return {
    side,
    barrier,
    probability: historicalProbability,
    fastProbability,
    triggerProbability,
    transition,
    exactRisk: risk,
    score,
  };
}

export function buildTargetTenDecision(prices = [], settings = {}) {
  const values = normalizePrices(prices);
  const digits = values.map(digitFromPrice);
  const currentDigit = digits.at(-1) ?? 0;

  const candidates = [];

  for (const barrier of [1, 2, 3]) {
    candidates.push(scoreCandidate(digits, "OVER", barrier));
  }

  for (const barrier of [5, 6, 7]) {
    candidates.push(scoreCandidate(digits, "UNDER", barrier));
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0] || {
    side: "WAIT",
    barrier: 1,
    probability: 0,
    fastProbability: 0,
    triggerProbability: 0,
    transition: 0,
    exactRisk: 100,
    score: 0,
  };

  const minimumSamples = Number(settings.minimumSamples ?? 70);
  const minimumScore = Number(settings.minimumScore ?? 80);
  const minimumProbability = Number(settings.minimumProbability ?? 78);
  const minimumTransition = Number(settings.minimumTransition ?? 65);
  const maximumExactRisk = Number(settings.maximumExactRisk ?? 13);

  const qualified =
    digits.length >= minimumSamples &&
    best.score >= minimumScore &&
    best.probability >= minimumProbability &&
    best.transition >= minimumTransition &&
    best.exactRisk <= maximumExactRisk;

  const winningDigits =
    best.side === "OVER"
      ? Array.from({ length: 9 - best.barrier }, (_, index) => best.barrier + 1 + index)
      : Array.from({ length: best.barrier }, (_, index) => index);

  return {
    digits,
    currentDigit,
    candidates,
    best,
    qualified,
    winningDigits,
    reason: qualified
      ? `${best.side} ${best.barrier} passed the Target 10 entry gate.`
      : `Scanning: score ${best.score.toFixed(1)}/${minimumScore}, probability ${best.probability.toFixed(1)}/${minimumProbability}, transition ${best.transition.toFixed(1)}/${minimumTransition}.`,
  };
}

export function nextTargetStage(balance, finalTarget = 10) {
  const current = Number(balance || 0);
  const stages = [2, 3, 5, 7, Number(finalTarget || 10)];

  return stages.find((stage) => stage > current + 0.0001) || Number(finalTarget || 10);
}

export default buildTargetTenDecision;
