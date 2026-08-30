function percentage(value) {
  return Number.isFinite(value)
    ? value * 100
    : 0;
}

function wilsonLowerBound(
  wins,
  total,
  z = 1.96
) {
  if (!total) return 0;

  const rate = wins / total;
  const zSquared = z * z;
  const denominator =
    1 + zSquared / total;
  const center =
    rate + zSquared / (2 * total);

  const margin =
    z *
    Math.sqrt(
      (
        rate * (1 - rate) +
        zSquared / (4 * total)
      ) / total
    );

  return Math.max(
    0,
    (center - margin) / denominator
  );
}

function validateResult({
  name,
  action,
  wins,
  samples,
  baseline,
  minSamples = 25,
  minEdge = 0.04,
  reason = "",
}) {
  const hitRate =
    samples ? wins / samples : 0;

  const edge = hitRate - baseline;
  const lowerBound = wilsonLowerBound(
    wins,
    samples
  );

  const approved =
    samples >= minSamples &&
    edge >= minEdge &&
    lowerBound > baseline;

  return {
    name,
    action: approved ? action : "WAIT",
    candidate: action,
    approved,
    wins,
    samples,
    hitRate: percentage(hitRate),
    baseline: percentage(baseline),
    edge: percentage(edge),
    lowerBound: percentage(lowerBound),
    reason: approved
      ? `${action} validated: ${percentage(hitRate).toFixed(1)}% over ${samples} historical setups`
      : (
          reason ||
          `WAIT: ${samples} samples, ${percentage(hitRate).toFixed(1)}% hit rate`
        ),
  };
}

function parityCandidate(digits) {
  if (!digits.length) return null;

  const even =
    digits.filter(
      (digit) => digit % 2 === 0
    ).length / digits.length;

  return even >= 0.56
    ? "EVEN"
    : even <= 0.44
    ? "ODD"
    : null;
}

function thresholdCandidate(
  digits,
  barrier = 2
) {
  if (!digits.length) return null;

  const over =
    digits.filter(
      (digit) => digit > barrier
    ).length / digits.length;

  const under =
    digits.filter(
      (digit) => digit < barrier
    ).length / digits.length;

  const overBaseline =
    (9 - barrier) / 10;

  const underBaseline =
    barrier / 10;

  return over >= overBaseline + 0.06
    ? "OVER 2"
    : under >= underBaseline + 0.06
    ? "UNDER 2"
    : null;
}

function matchDiffCandidate(digits) {
  if (!digits.length) return null;

  const counts = Array(10).fill(0);

  digits.forEach((digit) => {
    counts[digit] += 1;
  });

  const rates = counts.map(
    (count, digit) => ({
      digit,
      rate: count / digits.length,
    })
  );

  const hot = [...rates].sort(
    (a, b) =>
      b.rate - a.rate ||
      a.digit - b.digit
  )[0];

  const cold = [...rates].sort(
    (a, b) =>
      a.rate - b.rate ||
      a.digit - b.digit
  )[0];

  if (hot.rate >= 0.15) {
    return {
      type: "MATCH",
      digit: hot.digit,
    };
  }

  if (cold.rate <= 0.05) {
    return {
      type: "DIFFERS",
      digit: cold.digit,
    };
  }

  return null;
}

function slopeDirection(prices) {
  if (!prices || prices.length < 8) {
    return null;
  }

  const first = Number(prices[0]);
  const last = Number(prices.at(-1));

  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    first === 0
  ) {
    return null;
  }

  const change =
    (last - first) / Math.abs(first);

  return change >= 0.00045
    ? "RISE"
    : change <= -0.00045
    ? "FALL"
    : null;
}

function backtestParity(
  digits,
  windowSize = 60
) {
  const current = parityCandidate(
    digits.slice(-windowSize)
  );

  if (!current) {
    return validateResult({
      name: "Even / Odd",
      action: "WAIT",
      wins: 0,
      samples: 0,
      baseline: 0.5,
      reason:
        "WAIT: current parity is too balanced",
    });
  }

  let wins = 0;
  let samples = 0;

  for (
    let index = windowSize;
    index < digits.length;
    index += 1
  ) {
    const candidate = parityCandidate(
      digits.slice(
        index - windowSize,
        index
      )
    );

    if (candidate !== current) continue;

    samples += 1;

    const actual =
      digits[index] % 2 === 0
        ? "EVEN"
        : "ODD";

    if (actual === current) {
      wins += 1;
    }
  }

  return validateResult({
    name: "Even / Odd",
    action: current,
    wins,
    samples,
    baseline: 0.5,
    minSamples: 25,
    minEdge: 0.05,
    reason:
      `WAIT: ${current} has not proved an edge yet`,
  });
}

function backtestThreshold(
  digits,
  windowSize = 60
) {
  const current = thresholdCandidate(
    digits.slice(-windowSize),
    2
  );

  if (!current) {
    return validateResult({
      name: "Over / Under 2",
      action: "WAIT",
      wins: 0,
      samples: 0,
      baseline: 0.7,
      reason:
        "WAIT: current distribution is near its natural base-rate",
    });
  }

  const baseline =
    current === "OVER 2"
      ? 0.7
      : 0.2;

  let wins = 0;
  let samples = 0;

  for (
    let index = windowSize;
    index < digits.length;
    index += 1
  ) {
    const candidate = thresholdCandidate(
      digits.slice(
        index - windowSize,
        index
      ),
      2
    );

    if (candidate !== current) continue;

    samples += 1;

    const win =
      current === "OVER 2"
        ? digits[index] > 2
        : digits[index] < 2;

    if (win) wins += 1;
  }

  return validateResult({
    name: "Over / Under 2",
    action: current,
    wins,
    samples,
    baseline,
    minSamples: 25,
    minEdge:
      current === "OVER 2"
        ? 0.04
        : 0.06,
    reason:
      `WAIT: ${current} has not beaten its natural base-rate`,
  });
}

function backtestMatchDiff(
  digits,
  windowSize = 80
) {
  const current = matchDiffCandidate(
    digits.slice(-windowSize)
  );

  if (!current) {
    return validateResult({
      name: "Matches / Differs",
      action: "WAIT",
      wins: 0,
      samples: 0,
      baseline: 0.1,
      reason:
        "WAIT: no unusually hot or cold digit",
    });
  }

  const baseline =
    current.type === "MATCH"
      ? 0.1
      : 0.9;

  let wins = 0;
  let samples = 0;

  for (
    let index = windowSize;
    index < digits.length;
    index += 1
  ) {
    const candidate = matchDiffCandidate(
      digits.slice(
        index - windowSize,
        index
      )
    );

    if (
      !candidate ||
      candidate.type !== current.type ||
      candidate.digit !== current.digit
    ) {
      continue;
    }

    samples += 1;

    const win =
      current.type === "MATCH"
        ? digits[index] === current.digit
        : digits[index] !== current.digit;

    if (win) wins += 1;
  }

  const action =
    current.type === "MATCH"
      ? `MATCH ${current.digit}`
      : `DIFFERS ${current.digit}`;

  return validateResult({
    name: "Matches / Differs",
    action,
    wins,
    samples,
    baseline,
    minSamples:
      current.type === "MATCH"
        ? 20
        : 30,
    minEdge:
      current.type === "MATCH"
        ? 0.05
        : 0.025,
    reason:
      `WAIT: ${action} has not proved enough edge`,
  });
}

function backtestRiseFall(
  prices,
  lookback = 20,
  horizon = 5
) {
  if (
    !Array.isArray(prices) ||
    prices.length <
      lookback + horizon + 20
  ) {
    return validateResult({
      name: "Rise / Fall",
      action: "WAIT",
      wins: 0,
      samples: 0,
      baseline: 0.5,
      reason:
        "WAIT: not enough price history",
    });
  }

  const current = slopeDirection(
    prices.slice(-lookback)
  );

  if (!current) {
    return validateResult({
      name: "Rise / Fall",
      action: "WAIT",
      wins: 0,
      samples: 0,
      baseline: 0.5,
      reason:
        "WAIT: current price trend is too weak",
    });
  }

  let wins = 0;
  let samples = 0;

  for (
    let index = lookback;
    index + horizon < prices.length;
    index += horizon
  ) {
    const candidate = slopeDirection(
      prices.slice(
        index - lookback,
        index
      )
    );

    if (candidate !== current) continue;

    const entry = Number(prices[index]);
    const exit = Number(
      prices[index + horizon]
    );

    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(exit) ||
      entry === exit
    ) {
      continue;
    }

    samples += 1;

    const actual =
      exit > entry
        ? "RISE"
        : "FALL";

    if (actual === current) {
      wins += 1;
    }
  }

  return validateResult({
    name: "Rise / Fall",
    action: current,
    wins,
    samples,
    baseline: 0.5,
    minSamples: 20,
    minEdge: 0.07,
    reason:
      `WAIT: ${current} trend has not shown a reliable historical edge`,
  });
}

export function buildValidatedSignals(
  snapshot = {}
) {
  const digits = Array.isArray(
    snapshot.digitHistory
  )
    ? snapshot.digitHistory
        .map(Number)
        .filter(Number.isInteger)
    : [];

  const prices = Array.isArray(
    snapshot.prices
  )
    ? snapshot.prices
        .map(Number)
        .filter(Number.isFinite)
    : [];

  const signals = [
    backtestParity(digits),
    backtestThreshold(digits),
    backtestMatchDiff(digits),
    backtestRiseFall(prices),
  ];

  const approved = signals.filter(
    (signal) => signal.approved
  );

  const best =
    approved
      .slice()
      .sort(
        (a, b) =>
          b.lowerBound - a.lowerBound ||
          b.edge - a.edge ||
          b.samples - a.samples
      )[0] || null;

  return {
    signals,
    best,
    approvedCount: approved.length,
    note:
      "Validated signals use walk-forward historical testing. Past hit-rate does not guarantee the next trade.",
  };
}
