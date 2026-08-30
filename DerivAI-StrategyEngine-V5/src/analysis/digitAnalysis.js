export function normalizeDigits(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(
      (value) =>
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 9
    );
}

export function digitDistribution(values = []) {
  const digits = normalizeDigits(values);
  const counts = Array(10).fill(0);

  digits.forEach((digit) => {
    counts[digit] += 1;
  });

  const total = Math.max(1, digits.length);

  return counts.map((count, digit) => ({
    digit,
    count,
    percent: (count / total) * 100,
  }));
}

export function parityStats(values = []) {
  const digits = normalizeDigits(values);
  const total = Math.max(1, digits.length);
  const evenCount = digits.filter((digit) => digit % 2 === 0).length;
  const oddCount = digits.length - evenCount;

  return {
    evenCount,
    oddCount,
    evenPercent: (evenCount / total) * 100,
    oddPercent: (oddCount / total) * 100,
  };
}

export function thresholdStats(values = [], barrier = 2) {
  const digits = normalizeDigits(values);
  const total = Math.max(1, digits.length);

  const under = digits.filter((digit) => digit < barrier).length;
  const equal = digits.filter((digit) => digit === barrier).length;
  const over = digits.filter((digit) => digit > barrier).length;

  return {
    barrier,
    under,
    equal,
    over,
    underPercent: (under / total) * 100,
    equalPercent: (equal / total) * 100,
    overPercent: (over / total) * 100,
  };
}

export function lastDigitStreak(values = []) {
  const digits = normalizeDigits(values);

  if (!digits.length) {
    return { digit: null, length: 0 };
  }

  const last = digits.at(-1);
  let length = 0;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== last) break;
    length += 1;
  }

  return { digit: last, length };
}

export function digitEntropy(values = []) {
  const distribution = digitDistribution(values);
  let entropy = 0;

  distribution.forEach(({ percent }) => {
    const probability = percent / 100;

    if (probability > 0) {
      entropy -= probability * Math.log2(probability);
    }
  });

  return {
    value: entropy,
    normalized: entropy / Math.log2(10),
  };
}

export function recentVsBaseline(values = [], recentSize = 20) {
  const digits = normalizeDigits(values);
  const recent = digits.slice(-Math.max(5, recentSize));
  const baseline = digits.slice(
    0,
    Math.max(0, digits.length - recent.length)
  );

  const recentDistribution = digitDistribution(recent);
  const baselineDistribution = digitDistribution(
    baseline.length ? baseline : digits
  );

  return recentDistribution.map((item) => ({
    digit: item.digit,
    recentPercent: item.percent,
    baselinePercent:
      baselineDistribution[item.digit]?.percent || 0,
    delta:
      item.percent -
      (baselineDistribution[item.digit]?.percent || 0),
  }));
}
