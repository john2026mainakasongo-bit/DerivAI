import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeOverUnder } from "../analysis/overUnderAnalysisEngine";
import "../styles/OverUnderLearningBot.css";

const MEMORY_KEY = "edgepilot:over-under-learning:v19";
const MARKET_BROWSER_CACHE_KEY = "edgepilot:over-under-market-cache:v19";

const clamp = (value, minimum, maximum) =>
  Math.min(
    maximum,
    Math.max(minimum, Number(value || 0))
  );

const pct = (value) =>
  `${Number(value || 0).toFixed(1)}%`;




function contractIdOf(item = {}) {
  return String(
    item?.contract_id ||
      item?.id ||
      item?.contractId ||
      ""
  );
}

function contractStatus(item = {}) {
  const rawStatus = String(
    item?.status || ""
  ).toUpperCase();

  const profit = profitOf(item);

  if (
    item?.is_sold ||
    item?.is_expired ||
    ["WON", "LOST", "SOLD", "EXPIRED"].includes(
      rawStatus
    )
  ) {
    if (rawStatus === "WON") return "WON";
    if (rawStatus === "LOST") return "LOST";

    if (profit > 0) return "WON";
    if (profit < 0) return "LOST";

    return rawStatus || "CLOSED";
  }

  return rawStatus || "OPEN";
}

function profitOf(item = {}) {
  const value = Number(
    item?.profit ??
      item?.profit_loss ??
      item?.pnl ??
      (
        Number(item?.sell_price || 0) -
        Number(item?.buy_price || 0)
      )
  );

  return Number.isFinite(value) ? value : 0;
}


function loadMarketBrowserCache() {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(
        MARKET_BROWSER_CACHE_KEY
      ) || "{}"
    );

    return parsed && typeof parsed === "object"
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizePriceKey(item, index) {
  if (item && typeof item === "object") {
    return String(
      item.epoch ??
        item.time ??
        item.timestamp ??
        item.id ??
        `${item.quote ?? item.price ?? ""}:${index}`
    );
  }

  return `${String(item)}:${index}`;
}

function mergeMarketPrices(
  cachedPrices,
  livePrices,
  limit = 320
) {
  const merged = [
    ...(Array.isArray(cachedPrices) ? cachedPrices : []),
    ...(Array.isArray(livePrices) ? livePrices : []),
  ];

  const seen = new Set();
  const output = [];

  for (
    let index = merged.length - 1;
    index >= 0;
    index -= 1
  ) {
    const item = merged[index];
    const key = normalizePriceKey(item, index);

    if (seen.has(key)) continue;

    seen.add(key);
    output.push(item);

    if (output.length >= limit) break;
  }

  return output.reverse();
}

function cacheIsFresh(row, freshnessSeconds) {
  return Boolean(
    row &&
      Date.now() - Number(row.updatedAt || 0) <=
        Math.max(5, Number(freshnessSeconds || 90)) * 1000
  );
}

function safeAnalysis(value) {
  const best = value?.best || {};

  return {
    total: Number(value?.total || 0),
    recentDigits: Array.isArray(value?.recentDigits)
      ? value.recentDigits
      : [],
    counts: Array.isArray(value?.counts)
      ? value.counts
      : Array.from({ length: 10 }, () => 0),
    confidence: Number(value?.confidence || 0),
    quality: Number(value?.quality || 0),
    risk: String(value?.risk || "HIGH"),
    tradeNow: Boolean(value?.tradeNow),
    decision: String(
      value?.decision ||
        "SCANNING OVER + UNDER"
    ),
    reason: String(
      value?.reason ||
        "Comparing all barriers from live ticks."
    ),
    rows: Array.isArray(value?.rows)
      ? value.rows
      : [],
    candidates: Array.isArray(value?.candidates)
      ? value.candidates
      : [],
    best: {
      side: String(best?.side || "WAIT"),
      barrier: Number(best?.barrier ?? 2),
      probability: Number(
        best?.probability || 0
      ),
      probabilityEdge: Number(
        best?.probabilityEdge || 0
      ),
      transitionEdge: Number(
        best?.transitionEdge || 0
      ),
      consistency: Number(
        best?.consistency || 0
      ),
      score: Number(best?.score || 0),
    },
  };
}

function memoryKey(symbol, side, barrier) {
  return `${symbol}|${side}|${barrier}`;
}

function defaultProfitRatio(side, barrier) {
  const numericBarrier = Number(barrier);

  const winDigits =
    side === "OVER"
      ? Math.max(1, 9 - numericBarrier)
      : Math.max(1, numericBarrier);

  const fairProbability = winDigits / 10;

  // Conservative payout estimate after house edge.
  return Math.max(
    0.05,
    0.94 / Math.max(0.1, fairProbability) - 1
  );
}

function breakEvenProbability(profitRatio) {
  return 100 / (1 + Math.max(0.01, profitRatio));
}


function digitEntropy(digits) {
  if (!Array.isArray(digits) || !digits.length) {
    return 100;
  }

  const counts = Array.from(
    { length: 10 },
    () => 0
  );

  for (const digit of digits) {
    const value = Number(digit);

    if (value >= 0 && value <= 9) {
      counts[value] += 1;
    }
  }

  let entropy = 0;

  for (const count of counts) {
    if (!count) continue;

    const probability = count / digits.length;
    entropy -= probability * Math.log2(probability);
  }

  return clamp(
    (entropy / Math.log2(10)) * 100,
    0,
    100
  );
}

function digitRegimeAnalysis(recentDigits) {
  const digits = Array.isArray(recentDigits)
    ? recentDigits
        .map(Number)
        .filter(
          (digit) =>
            Number.isFinite(digit) &&
            digit >= 0 &&
            digit <= 9
        )
        .slice(-80)
    : [];

  if (digits.length < 12) {
    return {
      sample: digits.length,
      entropy: 100,
      concentration: 0,
      persistence: 0,
      transitionQuality: 0,
      lowShare: 50,
      highShare: 50,
      regime: "WARMING",
      riskPenalty: 20,
      qualityBonus: 0,
    };
  }

  const counts = Array.from(
    { length: 10 },
    () => 0
  );

  for (const digit of digits) {
    counts[digit] += 1;
  }

  const maximumCount = Math.max(...counts);
  const concentration =
    (maximumCount / digits.length) * 100;

  let repeats = 0;
  let directionalTransitions = 0;
  let stableTransitions = 0;

  for (let index = 1; index < digits.length; index++) {
    if (digits[index] === digits[index - 1]) {
      repeats += 1;
    }

    const difference =
      digits[index] - digits[index - 1];

    if (difference !== 0) {
      directionalTransitions += 1;
    }

    if (Math.abs(difference) <= 4) {
      stableTransitions += 1;
    }
  }

  const persistence =
    (repeats / Math.max(1, digits.length - 1)) *
    100;

  const transitionQuality =
    (stableTransitions /
      Math.max(1, digits.length - 1)) *
    100;

  const lowShare =
    (digits.filter((digit) => digit <= 4).length /
      digits.length) *
    100;

  const highShare = 100 - lowShare;
  const entropy = digitEntropy(digits);

  const regime =
    entropy >= 92
      ? "RANDOM"
      : concentration >= 24 || persistence >= 24
      ? "CLUSTERED"
      : transitionQuality >= 72
      ? "ORDERLY"
      : "MIXED";

  const riskPenalty = clamp(
    (entropy >= 94 ? 13 : 0) +
      (concentration >= 30 ? 14 : 0) +
      (persistence >= 30 ? 12 : 0) +
      (transitionQuality < 52 ? 10 : 0),
    0,
    35
  );

  const qualityBonus = clamp(
    (entropy >= 82 && entropy <= 92 ? 6 : 0) +
      (transitionQuality >= 68 ? 8 : 0) +
      (concentration >= 14 &&
      concentration <= 24
        ? 5
        : 0),
    0,
    18
  );

  return {
    sample: digits.length,
    entropy,
    concentration,
    persistence,
    transitionQuality,
    lowShare,
    highShare,
    regime,
    riskPenalty,
    qualityBonus,
  };
}

function barrierSafetyScore(side, barrier) {
  const numericBarrier = Number(barrier);

  const theoreticalWinRate =
    side === "OVER"
      ? ((9 - numericBarrier) / 10) * 100
      : (numericBarrier / 10) * 100;

  return clamp(theoreticalWinRate, 0, 100);
}


function barrierLaneScore(side, barrier, recoveryActive) {
  const value = Number(barrier);

  if (recoveryActive) {
    if (side === "OVER" && value === 4) return 100;
    if (side === "UNDER" && value === 5) return 100;
    if (side === "OVER" && value === 3) return 86;
    if (side === "UNDER" && value === 6) return 86;
    return 35;
  }

  if (side === "OVER" && [1, 2, 3].includes(value)) {
    return 100 - (value - 1) * 8;
  }

  if (side === "UNDER" && [6, 7, 8].includes(value)) {
    return 100 - (8 - value) * 8;
  }

  return 30;
}

function recentResultRisk(trades, symbol) {
  const recent = (Array.isArray(trades) ? trades : [])
    .filter(
      (trade) =>
        String(trade.symbol || "") === String(symbol || "") &&
        ["WON", "LOST"].includes(
          String(trade.status || "").toUpperCase()
        )
    )
    .slice(0, 12);

  if (!recent.length) {
    return {
      sample: 0,
      lossRate: 0,
      lossStreak: 0,
      winStreak: 0,
      decay: 0,
      risk: 0,
    };
  }

  const losses = recent.filter(
    (trade) =>
      String(trade.status || "").toUpperCase() === "LOST"
  ).length;

  let lossStreak = 0;
  let winStreak = 0;

  for (const trade of recent) {
    const status = String(trade.status || "").toUpperCase();

    if (status === "LOST" && winStreak === 0) {
      lossStreak += 1;
    } else if (status === "WON" && lossStreak === 0) {
      winStreak += 1;
    } else {
      break;
    }
  }

  const split = Math.ceil(recent.length / 2);
  const newestHalf = recent.slice(0, split);
  const oldestHalf = recent.slice(split);

  const winRateOf = (rows) =>
    rows.length
      ? rows.filter(
          (trade) =>
            String(trade.status || "").toUpperCase() === "WON"
        ).length / rows.length
      : 0.5;

  const newestRate = winRateOf(newestHalf);
  const oldestRate = oldestHalf.length
    ? winRateOf(oldestHalf)
    : newestRate;

  const decay = clamp(
    (oldestRate - newestRate) * 100,
    0,
    100
  );

  const lossRate = (losses / recent.length) * 100;

  const risk = clamp(
    lossRate * 0.35 +
      lossStreak * 18 +
      decay * 0.45 +
      (winStreak >= 5 ? 14 : 0),
    0,
    100
  );

  return {
    sample: recent.length,
    lossRate,
    lossStreak,
    winStreak,
    decay,
    risk,
  };
}

function predictiveGuard({
  regime,
  resultRisk,
  candidate,
  tradesOnCurrentMarket,
  proactiveRotationTrades,
}) {
  const score = Number(candidate?.adaptiveScore || 0);
  const probability = Number(candidate?.probability || 0);
  const edge = Number(candidate?.payoutEdge || 0);
  const consistency = Number(candidate?.consistency || 0);
  const regimeRisk = Number(regime?.riskPenalty || 0);

  const marketFatigue = clamp(
    (
      Number(tradesOnCurrentMarket || 0) /
      Math.max(1, Number(proactiveRotationTrades || 5))
    ) * 100,
    0,
    140
  );

  const risk = clamp(
    regimeRisk * 1.15 +
      Number(resultRisk?.risk || 0) * 0.85 +
      Math.max(0, 72 - score) * 0.7 +
      Math.max(0, 80 - probability) * 0.45 +
      Math.max(0, 2 - edge) * 4 +
      Math.max(0, 72 - consistency) * 0.25 +
      Math.max(0, marketFatigue - 85) * 0.35,
    0,
    100
  );

  return {
    risk,
    state:
      risk >= 72
        ? "BLOCK"
        : risk >= 52
        ? "CAUTION"
        : "CLEAR",
    marketFatigue,
  };
}

function frequencyWindow(digits, size) {
  const sample = (Array.isArray(digits) ? digits : [])
    .map(Number)
    .filter(
      (digit) =>
        Number.isFinite(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-Math.max(1, Number(size || 1)));

  const counts = Array.from(
    { length: 10 },
    () => 0
  );

  for (const digit of sample) {
    counts[digit] += 1;
  }

  const percentages = counts.map(
    (count) =>
      sample.length
        ? (count / sample.length) * 100
        : 0
  );

  return {
    size: sample.length,
    counts,
    percentages,
    hottestDigit:
      percentages.indexOf(
        Math.max(...percentages)
      ),
    coldestDigit:
      percentages.indexOf(
        Math.min(...percentages)
      ),
  };
}

function transitionMatrixAnalysis(digits) {
  const sample = (Array.isArray(digits) ? digits : [])
    .map(Number)
    .filter(
      (digit) =>
        Number.isFinite(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-220);

  const matrix = Array.from(
    { length: 10 },
    () =>
      Array.from(
        { length: 10 },
        () => 0
      )
  );

  for (
    let index = 1;
    index < sample.length;
    index += 1
  ) {
    matrix[sample[index - 1]][sample[index]] += 1;
  }

  const lastDigit =
    sample.length > 0
      ? sample[sample.length - 1]
      : null;

  const row =
    lastDigit === null
      ? Array.from({ length: 10 }, () => 0)
      : matrix[lastDigit];

  const rowTotal = row.reduce(
    (total, value) => total + value,
    0
  );

  const nextProbabilities = row.map(
    (value) =>
      rowTotal
        ? (value / rowTotal) * 100
        : 10
  );

  const predictedDigit =
    nextProbabilities.indexOf(
      Math.max(...nextProbabilities)
    );

  const confidence = clamp(
    Math.max(...nextProbabilities) - 10,
    0,
    90
  );

  return {
    lastDigit,
    predictedDigit,
    confidence,
    nextProbabilities,
  };
}

function cycleAnalysis(digits) {
  const sample = (Array.isArray(digits) ? digits : [])
    .map(Number)
    .filter(Number.isFinite)
    .slice(-160);

  let bestLength = 0;
  let bestScore = 0;

  for (let length = 2; length <= 14; length += 1) {
    if (sample.length < length * 3) continue;

    let matches = 0;
    let comparisons = 0;

    for (
      let index = sample.length - length;
      index < sample.length;
      index += 1
    ) {
      const current = sample[index];
      const previous = sample[index - length];

      if (
        Number.isFinite(current) &&
        Number.isFinite(previous)
      ) {
        comparisons += 1;

        if (current === previous) {
          matches += 1;
        }
      }
    }

    const score = comparisons
      ? (matches / comparisons) * 100
      : 0;

    if (score > bestScore) {
      bestScore = score;
      bestLength = length;
    }
  }

  return {
    length: bestLength,
    strength: bestScore,
  };
}

function bayesianBarrierProbability({
  digits,
  side,
  barrier,
  prior = 0.5,
}) {
  const sample = (Array.isArray(digits) ? digits : [])
    .map(Number)
    .filter(
      (digit) =>
        Number.isFinite(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-160);

  const wins = sample.filter((digit) =>
    side === "OVER"
      ? digit > Number(barrier)
      : digit < Number(barrier)
  ).length;

  const losses = sample.length - wins;
  const priorStrength = 10;
  const alpha =
    prior * priorStrength + wins;
  const beta =
    (1 - prior) * priorStrength + losses;

  return {
    posterior:
      (alpha / Math.max(1, alpha + beta)) *
      100,
    sample: sample.length,
  };
}

function meanReversionAnalysis(digits) {
  const sample = (Array.isArray(digits) ? digits : [])
    .map(Number)
    .filter(Number.isFinite)
    .slice(-80);

  if (sample.length < 10) {
    return {
      average: 4.5,
      deviation: 0,
      probability: 50,
      direction: "NEUTRAL",
    };
  }

  const average =
    sample.reduce(
      (total, value) => total + value,
      0
    ) / sample.length;

  const latest = sample[sample.length - 1];
  const deviation = latest - average;

  return {
    average,
    deviation,
    probability: clamp(
      50 + Math.abs(deviation) * 7,
      50,
      88
    ),
    direction:
      deviation > 1.2
        ? "DOWN"
        : deviation < -1.2
        ? "UP"
        : "NEUTRAL",
  };
}

function barrierProfitRatio(side, barrier) {
  const value = Number(barrier);

  const theoreticalProbability =
    side === "OVER"
      ? (9 - value) / 10
      : value / 10;

  if (theoreticalProbability <= 0) {
    return 0;
  }

  return Math.max(
    0.01,
    0.93 / theoreticalProbability - 1
  );
}

function simulateBarrierEV({
  probability,
  profitRatio,
  trials = 1000,
}) {
  const winProbability = clamp(
    Number(probability || 0) / 100,
    0,
    1
  );

  const expectedValue =
    winProbability * Number(profitRatio || 0) -
    (1 - winProbability);

  const variance =
    winProbability *
      Math.pow(
        Number(profitRatio || 0) -
          expectedValue,
        2
      ) +
    (1 - winProbability) *
      Math.pow(-1 - expectedValue, 2);

  const standardError = Math.sqrt(
    Math.max(0, variance) /
      Math.max(1, Number(trials || 1000))
  );

  return {
    expectedValue,
    expectedProfitPerDollar: expectedValue,
    confidenceLow:
      expectedValue - 1.96 * standardError,
    confidenceHigh:
      expectedValue + 1.96 * standardError,
    trials,
  };
}

function multiLayerCandidateScore({
  candidate,
  frequencies,
  transition,
  cycle,
  meanReversion,
  bayesian,
  regime,
  resultRisk,
  recoveryActive,
}) {
  const side = String(candidate.side || "");
  const barrier = Number(candidate.barrier);

  const shortFrequency =
    frequencies.short.percentages.filter(
      (_, digit) =>
        side === "OVER"
          ? digit > barrier
          : digit < barrier
    ).reduce((a, b) => a + b, 0);

  const mediumFrequency =
    frequencies.medium.percentages.filter(
      (_, digit) =>
        side === "OVER"
          ? digit > barrier
          : digit < barrier
    ).reduce((a, b) => a + b, 0);

  const longFrequency =
    frequencies.long.percentages.filter(
      (_, digit) =>
        side === "OVER"
          ? digit > barrier
          : digit < barrier
    ).reduce((a, b) => a + b, 0);

  const transitionProbability =
    transition.nextProbabilities.filter(
      (_, digit) =>
        side === "OVER"
          ? digit > barrier
          : digit < barrier
    ).reduce((a, b) => a + b, 0);

  const cycleCompatibility =
    cycle.length > 0
      ? cycle.strength
      : 50;

  const reversionCompatibility =
    meanReversion.direction === "NEUTRAL"
      ? 55
      : side === "OVER"
      ? meanReversion.direction === "UP"
        ? meanReversion.probability
        : 100 - meanReversion.probability
      : meanReversion.direction === "DOWN"
      ? meanReversion.probability
      : 100 - meanReversion.probability;

  const weightedProbability = clamp(
    shortFrequency * 0.24 +
      mediumFrequency * 0.18 +
      longFrequency * 0.12 +
      transitionProbability * 0.18 +
      bayesian.posterior * 0.20 +
      reversionCompatibility * 0.05 +
      cycleCompatibility * 0.03,
    0,
    100
  );

  const profitRatio = barrierProfitRatio(
    side,
    barrier
  );

  const simulation = simulateBarrierEV({
    probability: weightedProbability,
    profitRatio,
    trials: 1000,
  });

  const riskPenalty =
    Number(regime.riskPenalty || 0) * 0.45 +
    Number(resultRisk.risk || 0) * 0.35 +
    (simulation.confidenceLow < 0 ? 16 : 0);

  const lanePreference = barrierLaneScore(
    side,
    barrier,
    recoveryActive
  );

  const finalScore = clamp(
    weightedProbability * 0.54 +
      lanePreference * 0.16 +
      Math.max(
        -20,
        simulation.expectedValue * 100
      ) *
        0.18 +
      Number(candidate.consistency || 0) *
        0.12 -
      riskPenalty,
    0,
    100
  );

  return {
    weightedProbability,
    transitionProbability,
    shortFrequency,
    mediumFrequency,
    longFrequency,
    cycleCompatibility,
    reversionCompatibility,
    bayesianPosterior:
      bayesian.posterior,
    profitRatio,
    simulation,
    finalScore,
  };
}

function sessionProtectionAnalysis(trades, sampleSize = 20) {
  const settled = (Array.isArray(trades) ? trades : [])
    .filter((trade) =>
      ["WON", "LOST"].includes(
        String(trade.status || "").toUpperCase()
      )
    )
    .slice(0, Math.max(5, Number(sampleSize || 20)));

  const wins = settled.filter(
    (trade) =>
      String(trade.status || "").toUpperCase() === "WON"
  ).length;

  const losses = settled.length - wins;

  let lossStreak = 0;
  let winStreak = 0;

  for (const trade of settled) {
    const status = String(trade.status || "").toUpperCase();

    if (status === "LOST" && winStreak === 0) {
      lossStreak += 1;
    } else if (status === "WON" && lossStreak === 0) {
      winStreak += 1;
    } else {
      break;
    }
  }

  const netProfit = settled.reduce(
    (total, trade) =>
      total + Number(trade.profit || 0),
    0
  );

  const winRate = settled.length
    ? (wins / settled.length) * 100
    : 100;

  const averageWin = wins
    ? settled
        .filter(
          (trade) =>
            String(trade.status || "").toUpperCase() === "WON"
        )
        .reduce(
          (total, trade) =>
            total + Math.max(0, Number(trade.profit || 0)),
          0
        ) / wins
    : 0;

  const averageLoss = losses
    ? settled
        .filter(
          (trade) =>
            String(trade.status || "").toUpperCase() === "LOST"
        )
        .reduce(
          (total, trade) =>
            total + Math.abs(Math.min(0, Number(trade.profit || 0))),
          0
        ) / losses
    : 0;

  const payoffPressure =
    averageLoss > 0
      ? averageWin / averageLoss
      : 1;

  return {
    sample: settled.length,
    wins,
    losses,
    winRate,
    lossStreak,
    winStreak,
    netProfit,
    averageWin,
    averageLoss,
    payoffPressure,
  };
}

function marketHealthMap(trades, minimumSample = 3) {
  const groups = {};

  for (const trade of Array.isArray(trades) ? trades : []) {
    const status = String(trade.status || "").toUpperCase();

    if (!["WON", "LOST"].includes(status)) continue;

    const market = String(trade.symbol || "");

    if (!market) continue;

    if (!groups[market]) {
      groups[market] = {
        market,
        trades: 0,
        wins: 0,
        losses: 0,
        profit: 0,
        lossStreak: 0,
      };
    }

    const row = groups[market];
    row.trades += 1;
    row.profit += Number(trade.profit || 0);

    if (status === "WON") {
      row.wins += 1;
    } else {
      row.losses += 1;
    }
  }

  for (const market of Object.keys(groups)) {
    const row = groups[market];

    const latest = (Array.isArray(trades) ? trades : [])
      .filter(
        (trade) =>
          String(trade.symbol || "") === market &&
          ["WON", "LOST"].includes(
            String(trade.status || "").toUpperCase()
          )
      )
      .slice(0, 6);

    let streak = 0;

    for (const trade of latest) {
      if (
        String(trade.status || "").toUpperCase() === "LOST"
      ) {
        streak += 1;
      } else {
        break;
      }
    }

    row.lossStreak = streak;
    row.winRate = row.trades
      ? (row.wins / row.trades) * 100
      : 0;

    row.weak =
      row.trades >= Number(minimumSample || 3) &&
      (
        row.lossStreak >= 2 ||
        row.winRate < 48 ||
        row.profit < -0.5
      );
  }

  return groups;
}




function universalCandidateDecision({
  rankedCandidates,
  blockedSetups,
  minimumProbability,
  minimumEV,
  minimumVotes,
  maximumRisk,
}) {
  const evaluated = (
    Array.isArray(rankedCandidates)
      ? rankedCandidates
      : []
  ).map((candidate) => {
    const probability = Number(
      candidate?.layered?.weightedProbability ??
        candidate?.probability ??
        0
    );
    const expectedValue = Number(
      candidate?.layered?.simulation?.expectedValue ??
        candidate?.payoutEdge ??
        -1
    );
    const votes = Number(
      candidate?.agreementVotes || 0
    );
    const risk = Number(
      candidate?.guardRisk ??
        candidate?.risk ??
        100
    );
    const setupKey = [
      String(candidate?.side || ""),
      String(candidate?.barrier ?? ""),
    ].join(":");
    const blocked =
      Number(blockedSetups?.[setupKey] || 0) >
      Date.now();
    const qualified =
      !blocked &&
      probability >= Number(minimumProbability || 86) &&
      expectedValue > Number(minimumEV || 0) &&
      votes >= Number(minimumVotes || 6) &&
      risk <= Number(maximumRisk || 25) &&
      !candidate?.learned?.blocked;
    const universalScore =
      Number(candidate?.adaptiveScore || 0) * 0.40 +
      probability * 0.30 +
      votes * 3.5 +
      Math.max(
        -20,
        Math.min(20, expectedValue * 100)
      ) -
      risk * 0.20;

    return {
      candidate,
      qualified,
      blocked,
      probability,
      expectedValue,
      votes,
      risk,
      universalScore,
      setupKey,
    };
  });

  const sorted = evaluated.sort(
    (a, b) =>
      b.universalScore -
      a.universalScore
  );
  const selected =
    sorted.find((item) => item.qualified) ||
    null;

  return {
    selected: selected?.candidate || null,
    selectedMeta: selected,
    ranked: sorted,
    rejectedTop: sorted[0] || null,
  };
}

function balancedLaneDecision({
  overCandidate,
  underCandidate,
  sidePreference,
  minimumSideLead,
}) {
  const over = overCandidate || null;
  const under = underCandidate || null;

  if (!over && !under) {
    return {
      selected: null,
      side: "WAIT",
      reason: "NO_OVER_OR_UNDER_CANDIDATE",
      overScore: 0,
      underScore: 0,
    };
  }

  if (!over) {
    return {
      selected: under,
      side: "UNDER",
      reason: "UNDER_ONLY",
      overScore: 0,
      underScore: Number(under.adaptiveScore || 0),
    };
  }

  if (!under) {
    return {
      selected: over,
      side: "OVER",
      reason: "OVER_ONLY",
      overScore: Number(over.adaptiveScore || 0),
      underScore: 0,
    };
  }

  const score = (candidate) =>
    Number(candidate?.adaptiveScore || 0) * 0.42 +
    Number(
      candidate?.layered?.weightedProbability ??
        candidate?.probability ??
        0
    ) * 0.28 +
    Number(candidate?.agreementVotes || 0) * 3.2 +
    Math.max(
      -15,
      Math.min(
        15,
        Number(
          candidate?.layered?.simulation?.expectedValue ??
            candidate?.payoutEdge ??
            0
        ) * 100
      )
    ) -
    Number(candidate?.guardRisk || 0) * 0.16;

  let overScore = score(over);
  let underScore = score(under);

  if (sidePreference === "OVER") overScore += 1.5;
  if (sidePreference === "UNDER") underScore += 1.5;

  if (
    Math.abs(overScore - underScore) <
    Math.max(0, Number(minimumSideLead || 0))
  ) {
    const selected =
      Number(over.guardRisk || 0) <=
      Number(under.guardRisk || 0)
        ? over
        : under;

    return {
      selected,
      side: String(selected.side || "WAIT"),
      overScore,
      underScore,
      reason: "CLOSE_SCORES_SELECTED_LOWER_RISK",
    };
  }

  const selected =
    underScore > overScore ? under : over;

  return {
    selected,
    side: String(selected.side || "WAIT"),
    overScore,
    underScore,
    reason:
      underScore > overScore
        ? "UNDER_SCORE_HIGHER"
        : "OVER_SCORE_HIGHER",
  };
}

function qualifiedMarketDecision({
  market,
  candidate,
  protectionActive,
  blacklisted,
  weakMarket,
  minimumProbability,
  minimumEV,
  minimumVotes,
  maximumRisk,
}) {
  const probability = Number(
    candidate?.layered?.weightedProbability ??
      candidate?.probability ??
      0
  );

  const expectedValue = Number(
    candidate?.layered?.simulation?.expectedValue ??
      candidate?.payoutEdge ??
      -1
  );

  const votes = Number(
    candidate?.agreementVotes || 0
  );

  const risk = Number(
    candidate?.guardRisk ??
      candidate?.risk ??
      100
  );

  const qualified =
    Boolean(market) &&
    !protectionActive &&
    !blacklisted &&
    !weakMarket &&
    probability >= Number(minimumProbability || 88) &&
    expectedValue >= Number(minimumEV || 0.015) &&
    votes >= Number(minimumVotes || 6) &&
    risk <= Number(maximumRisk || 45) &&
    !candidate?.learned?.blocked;

  const reasons = [];

  if (!market) reasons.push("NO_MARKET");
  if (protectionActive) reasons.push("PROTECTION_ACTIVE");
  if (blacklisted) reasons.push("BLACKLISTED");
  if (weakMarket) reasons.push("WEAK_MARKET");
  if (probability < Number(minimumProbability || 88)) {
    reasons.push("PROBABILITY_LOW");
  }
  if (expectedValue < Number(minimumEV || 0.015)) {
    reasons.push("EV_LOW");
  }
  if (votes < Number(minimumVotes || 6)) {
    reasons.push("LAYERS_LOW");
  }
  if (risk > Number(maximumRisk || 45)) {
    reasons.push("RISK_HIGH");
  }
  if (candidate?.learned?.blocked) {
    reasons.push("SETUP_BLOCKED");
  }

  return {
    market,
    candidate,
    probability,
    expectedValue,
    votes,
    risk,
    qualified,
    reasons,
  };
}


function freshSetupKey({
  market,
  side,
  barrier,
  digits,
}) {
  const recent = (Array.isArray(digits) ? digits : [])
    .slice(-12)
    .join("");

  return [
    String(market || ""),
    String(side || ""),
    String(barrier ?? ""),
    recent,
  ].join(":");
}

function setupCooldownRemaining(row) {
  const blockedUntil = Number(row?.blockedUntil || 0);
  return Math.max(0, blockedUntil - Date.now());
}

function marketBlockRemaining(marketBlocks, symbol) {
  return Math.max(
    0,
    Number(marketBlocks?.[symbol] || 0) -
      Date.now()
  );
}

function recoveryStakeAmount(
  baseStake,
  recovery,
  maximumStake,
  recoveryTarget = 0,
  expectedProfitRatio = 0.34,
  recoveryMultiplier = 1.5
) {
  const base = Math.max(
    0.35,
    Number(baseStake || 0.35)
  );

  if (!recovery?.active) {
    return base;
  }

  const attempt = Math.max(
    1,
    Number(recovery.attempts || 1)
  );

  const cappedMultiplier = clamp(
    Number(recoveryMultiplier || 1.5),
    1,
    2
  );

  const progressiveStake =
    base * Math.pow(cappedMultiplier, attempt);

  const targetStake =
    Number(recoveryTarget || 0) > 0
      ? Number(recoveryTarget || 0) /
        Math.max(
          0.05,
          Number(expectedProfitRatio || 0.34)
        )
      : progressiveStake;

  return Math.min(
    Math.max(0.35, Number(maximumStake || 1.4)),
    Math.max(progressiveStake, targetStake)
  );
}

function loadMemory() {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(MEMORY_KEY) ||
        "{}"
    );

    return parsed && typeof parsed === "object"
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function memoryStats(memory, symbol, side, barrier) {
  const row =
    memory[memoryKey(symbol, side, barrier)] ||
    {};

  const trades = Number(row.trades || 0);
  const wins = Number(row.wins || 0);
  const losses = Number(row.losses || 0);

  const probability =
    (wins + 2) / (trades + 4);

  const observedProfitRatio =
    wins > 0
      ? Number(row.totalWinProfit || 0) /
        Math.max(
          0.01,
          Number(row.totalWinningStake || 0)
        )
      : 0;

  const profitRatio =
    observedProfitRatio > 0
      ? observedProfitRatio
      : defaultProfitRatio(side, barrier);

  const breakEven =
    breakEvenProbability(profitRatio);

  const adjustment =
    trades >= 3
      ? clamp(
          (probability * 100 - breakEven) * 0.45,
          -10,
          10
        )
      : 0;

  return {
    trades,
    wins,
    losses,
    probability,
    adjustment,
    profitRatio,
    breakEven,
    requiredProbability: breakEven + 4,
    blocked:
      setupCooldownRemaining(row) > 0,
    cooldownMs:
      setupCooldownRemaining(row),
    recentResults: Array.isArray(row.recentResults)
      ? row.recentResults
      : [],
    recentWinRate:
      Array.isArray(row.recentResults) &&
      row.recentResults.length
        ? (
            row.recentResults.filter(
              (item) => item === "WON"
            ).length /
            row.recentResults.length
          ) *
          100
        : 50,
    rollingScore: Number(row.rollingScore || 50),
    rollingConfidence: Number(
      row.rollingConfidence || 50
    ),
    lastResult: row.lastResult || "—",
  };
}

function updateMemory(
  memory,
  {
    symbol,
    side,
    barrier,
    result,
    profit,
    stake,
    confidence,
    score,
  }
) {
  const key = memoryKey(
    symbol,
    side,
    barrier
  );
  const previous = memory[key] || {};
  const won = result === "WON";
  const lost = result === "LOST";
  const consecutiveLosses =
    lost
      ? Number(previous.consecutiveLosses || 0) + 1
      : 0;

  return {
    ...memory,
    [key]: {
      symbol,
      side,
      barrier,
      trades: Number(previous.trades || 0) + 1,
      wins:
        Number(previous.wins || 0) +
        (won ? 1 : 0),
      losses:
        Number(previous.losses || 0) +
        (lost ? 1 : 0),
      totalProfit:
        Number(previous.totalProfit || 0) +
        Number(profit || 0),
      totalWinProfit:
        Number(previous.totalWinProfit || 0) +
        (won ? Math.max(0, Number(profit || 0)) : 0),
      totalWinningStake:
        Number(previous.totalWinningStake || 0) +
        (won ? Math.max(0.01, Number(stake || 0)) : 0),
      consecutiveLosses,
      blockedUntil:
        lost
          ? Date.now() +
            Math.min(
              180000,
              45000 * consecutiveLosses
            )
          : 0,
      lastResult: result,
      lastConfidence: Number(confidence || 0),
      lastScore: Number(score || 0),
      rollingScore:
        Number(previous.rollingScore || 50) * 0.7 +
        Number(score || 0) * 0.3,
      rollingConfidence:
        Number(previous.rollingConfidence || 50) * 0.7 +
        Number(confidence || 0) * 0.3,
      recentResults: [
        ...(Array.isArray(previous.recentResults)
          ? previous.recentResults
          : []),
        result,
      ].slice(-20),
      updatedAt: Date.now(),
    },
  };
}

function candidateScore(candidate, memoryRow) {
  const probability = Number(
    candidate?.probability || 0
  );

  const edge =
    probability -
    Number(memoryRow.requiredProbability || 100);

  const evScore = clamp(
    50 + edge * 2.5,
    0,
    100
  );

  const recentScore = clamp(
    Number(memoryRow.recentWinRate || 50),
    0,
    100
  );

  return clamp(
    Number(candidate?.score || 0) * 0.30 +
      probability * 0.16 +
      Number(candidate?.probabilityEdge || 0) *
        0.08 +
      Number(candidate?.transitionEdge || 0) *
        0.06 +
      Number(candidate?.consistency || 0) *
        0.06 +
      evScore * 0.18 +
      recentScore * 0.08 +
      Number(memoryRow.rollingScore || 50) * 0.04 +
      Number(memoryRow.rollingConfidence || 50) *
        0.04 +
      Number(memoryRow.adjustment || 0),
    0,
    100
  );
}

export default function OverUnderLearningBot() {
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    prices = [],
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [running, setRunning] =
    useState(false);
  const [stake, setStake] =
    useState(0.35);
  const [durationTicks, setDurationTicks] =
    useState(1);
  const [switchSeconds, setSwitchSeconds] =
    useState(8);
  const [minimumScore, setMinimumScore] =
    useState(62);
  const [minimumConfidence, setMinimumConfidence] =
    useState(58);
  const [allowReal, setAllowReal] =
    useState(false);
  const [memory, setMemory] =
    useState(() => loadMemory());
  const [trades, setTrades] =
    useState([]);
  const [lastSettledTrade, setLastSettledTrade] =
    useState(null);
  const [stats, setStats] = useState({
    runs: 0,
    wins: 0,
    losses: 0,
    profit: 0,
    switches: 0,
  });
  const [message, setMessage] =
    useState(
      "Adaptive Over/Under bot is ready."
    );
  const [consecutiveLosses, setConsecutiveLosses] =
    useState(0);
  const [recovery, setRecovery] = useState({
    active: false,
    attempts: 0,
    previousLossKey: "",
    previousLossAmount: 0,
  });
  const [maximumRecoveryStake, setMaximumRecoveryStake] =
    useState(1.4);
  const [marketBlocks, setMarketBlocks] = useState({});
  const [recoveryTarget, setRecoveryTarget] = useState(0);
  const [journalFilter, setJournalFilter] =
    useState("ALL");
  const [expandedTradeId, setExpandedTradeId] =
    useState("");
  const [soundEnabled, setSoundEnabled] =
    useState(true);
  const [journalSearch, setJournalSearch] =
    useState("");
  const [lastSoundEvent, setLastSoundEvent] =
    useState("NONE");
  const [recoveryMode, setRecoveryMode] =
    useState("SMART");
  const [recoveryMultiplier, setRecoveryMultiplier] =
    useState(1.5);
  const [maximumRecoveryAttempts, setMaximumRecoveryAttempts] =
    useState(2);
  const [tradesOnCurrentMarket, setTradesOnCurrentMarket] =
    useState(0);
  const [proactiveRotationTrades, setProactiveRotationTrades] =
    useState(5);
  const [recoveryDebt, setRecoveryDebt] =
    useState(0);
  const [predictiveGuardEnabled, setPredictiveGuardEnabled] =
    useState(true);
  const [guardThreshold, setGuardThreshold] =
    useState(58);
  const [multiLayerEnabled, setMultiLayerEnabled] =
    useState(true);
  const [minimumLayerAgreement, setMinimumLayerAgreement] =
    useState(5);
  const [evFloor, setEvFloor] =
    useState(0.015);
  const [adaptiveCooldownSeconds, setAdaptiveCooldownSeconds] =
    useState(3);
  const [protectionEnabled, setProtectionEnabled] =
    useState(true);
  const [minimumRecentWinRate, setMinimumRecentWinRate] =
    useState(58);
  const [maximumLossCascade, setMaximumLossCascade] =
    useState(2);
  const [protectionPauseSeconds, setProtectionPauseSeconds] =
    useState(18);
  const [protectionUntil, setProtectionUntil] =
    useState(0);
  const [dynamicMarketBlacklist, setDynamicMarketBlacklist] =
    useState({});
  const [globalSelectionEnabled, setGlobalSelectionEnabled] =
    useState(true);
  const [minimumQualifiedProbability, setMinimumQualifiedProbability] =
    useState(88);
  const [minimumQualifiedVotes, setMinimumQualifiedVotes] =
    useState(6);
  const [maximumQualifiedRisk, setMaximumQualifiedRisk] =
    useState(45);
  const [globalMarketScores, setGlobalMarketScores] =
    useState({});
  const [selectedGlobalSetup, setSelectedGlobalSetup] =
    useState(null);
  const [lastSkipReason, setLastSkipReason] =
    useState("WAITING_FOR_MARKET_DATA");
  const [oneRunPerMarket, setOneRunPerMarket] =
    useState(true);
  const [rotateAfterEverySettlement, setRotateAfterEverySettlement] =
    useState(true);
  const [freshTicksRequired, setFreshTicksRequired] =
    useState(12);
  const [lastTradeByMarket, setLastTradeByMarket] =
    useState({});
  const [lastSetupKeyByMarket, setLastSetupKeyByMarket] =
    useState({});
  const [marketBrowserCache, setMarketBrowserCache] =
    useState(() => loadMarketBrowserCache());
  const [cacheFreshnessSeconds, setCacheFreshnessSeconds] =
    useState(90);
  const [fastScanMilliseconds, setFastScanMilliseconds] =
    useState(650);
  const [minimumLiveTicksAfterSwitch, setMinimumLiveTicksAfterSwitch] =
    useState(4);
  const [balancedSidesEnabled, setBalancedSidesEnabled] =
    useState(true);
  const [sidePreference, setSidePreference] =
    useState("AUTO");
  const [minimumSideLead, setMinimumSideLead] =
    useState(1.5);
  const [universalPoolEnabled, setUniversalPoolEnabled] =
    useState(true);
  const [universalMinimumProbability, setUniversalMinimumProbability] =
    useState(86);
  const [universalMinimumVotes, setUniversalMinimumVotes] =
    useState(6);
  const [universalMaximumRisk, setUniversalMaximumRisk] =
    useState(25);
  const [setupBlacklistSeconds, setSetupBlacklistSeconds] =
    useState(90);
  const [dynamicSetupBlacklist, setDynamicSetupBlacklist] =
    useState({});

  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const nextEntryAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const lastSwitchAtRef = useRef(0);
  const switchBusyRef = useRef(false);
  const cacheWriteTimerRef = useRef(null);
  const marketEnteredAtRef = useRef(Date.now());
  const lastRawCacheSignatureRef = useRef("");
  const lastDecisionCacheSignatureRef = useRef("");
  const lastLossKeyRef = useRef("");
  const confirmationRef = useRef({
    key: "",
    ticks: 0,
  });
  const audioContextRef = useRef(null);
  const soundUnlockedRef = useRef(false);
  const soundedTradeIdsRef = useRef(new Set());
  const previousTradeStatusRef = useRef(new Map());

  function getAudioContext() {
    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioContextClass) return null;

    if (!audioContextRef.current) {
      audioContextRef.current =
        new AudioContextClass();
    }

    return audioContextRef.current;
  }

  async function unlockSounds() {
    if (!soundEnabled) return false;

    try {
      const context = getAudioContext();

      if (!context) return false;

      if (context.state === "suspended") {
        await context.resume();
      }

      soundUnlockedRef.current =
        context.state === "running";

      return soundUnlockedRef.current;
    } catch {
      return false;
    }
  }

  function playBellTone({
    start = 0,
    frequency,
    duration,
    volume = 0.08,
    harmonic = 2,
  }) {
    const context = audioContextRef.current;

    if (
      !context ||
      context.state !== "running" ||
      !soundEnabled
    ) {
      return;
    }

    const now = context.currentTime + start;
    const fundamental =
      context.createOscillator();
    const overtone =
      context.createOscillator();
    const fundamentalGain =
      context.createGain();
    const overtoneGain =
      context.createGain();

    fundamental.type = "sine";
    overtone.type = "sine";

    fundamental.frequency.setValueAtTime(
      frequency,
      now
    );
    overtone.frequency.setValueAtTime(
      frequency * harmonic,
      now
    );

    fundamentalGain.gain.setValueAtTime(
      0.0001,
      now
    );
    fundamentalGain.gain.exponentialRampToValueAtTime(
      volume,
      now + 0.012
    );
    fundamentalGain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + duration
    );

    overtoneGain.gain.setValueAtTime(
      0.0001,
      now
    );
    overtoneGain.gain.exponentialRampToValueAtTime(
      volume * 0.24,
      now + 0.008
    );
    overtoneGain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + duration * 0.68
    );

    fundamental.connect(fundamentalGain);
    overtone.connect(overtoneGain);
    fundamentalGain.connect(
      context.destination
    );
    overtoneGain.connect(
      context.destination
    );

    fundamental.start(now);
    overtone.start(now);
    fundamental.stop(now + duration);
    overtone.stop(now + duration);
  }

  function playTradeSound(type) {
    if (
      !soundEnabled ||
      !soundUnlockedRef.current
    ) {
      return;
    }

    const context = audioContextRef.current;

    if (
      !context ||
      context.state !== "running"
    ) {
      return;
    }

    if (type === "WON") {
      // Clean sale-style bell: bright double ting plus a soft finish.
      playBellTone({
        start: 0,
        frequency: 987.77,
        duration: 0.42,
        volume: 0.085,
        harmonic: 2.01,
      });
      playBellTone({
        start: 0.13,
        frequency: 1318.51,
        duration: 0.50,
        volume: 0.09,
        harmonic: 1.99,
      });
      playBellTone({
        start: 0.31,
        frequency: 1567.98,
        duration: 0.58,
        volume: 0.055,
        harmonic: 2.02,
      });
      return;
    }

    if (type === "LOST") {
      const oscillator =
        context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;

      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(
        294,
        now
      );
      oscillator.frequency.exponentialRampToValueAtTime(
        130,
        now + 0.46
      );

      gain.gain.setValueAtTime(
        0.0001,
        now
      );
      gain.gain.exponentialRampToValueAtTime(
        0.095,
        now + 0.02
      );
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + 0.48
      );

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.49);
      return;
    }

    if (type === "RECOVERY") {
      playBellTone({
        start: 0,
        frequency: 440,
        duration: 0.16,
        volume: 0.06,
      });
      playBellTone({
        start: 0.18,
        frequency: 440,
        duration: 0.16,
        volume: 0.06,
      });
      return;
    }

    if (type === "SWITCH") {
      playBellTone({
        frequency: 620,
        duration: 0.07,
        volume: 0.035,
      });
      return;
    }

    playBellTone({
      frequency: 523.25,
      duration: 0.11,
      volume: 0.045,
    });
  }


  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(
    () => () => {
      if (audioContextRef.current) {
        audioContextRef.current
          .close()
          .catch(() => {});
      }
    },
    []
  );


  useEffect(() => {
    if (!Array.isArray(trades) || !trades.length) {
      return;
    }

    for (const trade of trades) {
      const tradeId = String(
        trade.contractId || trade.id || ""
      );

      if (!tradeId) continue;

      const status = String(
        trade.status || ""
      ).toUpperCase();

      const previousStatus =
        previousTradeStatusRef.current.get(
          tradeId
        ) || "";

      previousTradeStatusRef.current.set(
        tradeId,
        status
      );

      const settledNow =
        ["WON", "LOST"].includes(status) &&
        previousStatus !== status;

      if (
        !settledNow ||
        soundedTradeIdsRef.current.has(tradeId)
      ) {
        continue;
      }

      soundedTradeIdsRef.current.add(tradeId);

      setLastSoundEvent(
        `${status} · ${trade.symbol} · ${trade.contract}`
      );

      if (
        soundEnabled &&
        soundUnlockedRef.current
      ) {
        playTradeSound(status);
      }
    }
  }, [trades, soundEnabled]);


  useEffect(() => {
    try {
      window.localStorage.setItem(
        MEMORY_KEY,
        JSON.stringify(memory)
      );
    } catch {
      // Browser storage may be unavailable.
    }
  }, [memory]);

  useEffect(() => {
    if (cacheWriteTimerRef.current) {
      window.clearTimeout(cacheWriteTimerRef.current);
    }

    cacheWriteTimerRef.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          MARKET_BROWSER_CACHE_KEY,
          JSON.stringify(marketBrowserCache)
        );
      } catch {
        // Browser storage may be unavailable.
      }
    }, 180);

    return () => {
      if (cacheWriteTimerRef.current) {
        window.clearTimeout(cacheWriteTimerRef.current);
      }
    };
  }, [marketBrowserCache]);

  useEffect(() => {
    if (
      !connected &&
      typeof connect === "function"
    ) {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  const cachedMarketRow =
    marketBrowserCache?.[symbol] || null;

  const cachedMarketUsable =
    cacheIsFresh(
      cachedMarketRow,
      cacheFreshnessSeconds
    );

  const effectivePrices = useMemo(
    () =>
      mergeMarketPrices(
        cachedMarketUsable
          ? cachedMarketRow?.prices
          : [],
        prices,
        320
      ),
    [
      cachedMarketUsable,
      cachedMarketRow,
      prices,
    ]
  );

  const analysis = useMemo(
    () =>
      safeAnalysis(
        analyzeOverUnder(effectivePrices)
      ),
    [effectivePrices]
  );

  const liveTicksAfterSwitch =
    Array.isArray(prices)
      ? prices.length
      : 0;

  const marketWarmReady =
    analysis.total >= 30 &&
    (
      !cachedMarketUsable ||
      liveTicksAfterSwitch >=
        Number(minimumLiveTicksAfterSwitch || 4)
    );

  const regimeAnalysis = useMemo(
    () =>
      digitRegimeAnalysis(
        analysis.recentDigits
      ),
    [analysis.recentDigits]
  );

  const resultRisk = useMemo(
    () => recentResultRisk(trades, symbol),
    [trades, symbol]
  );

  const protectionStats = useMemo(
    () => sessionProtectionAnalysis(trades, 20),
    [trades]
  );

  const marketHealth = useMemo(
    () => marketHealthMap(trades, 3),
    [trades]
  );

  const protectionActive =
    protectionEnabled &&
    Number(protectionUntil || 0) > Date.now();

  const multiWindowFrequency = useMemo(
    () => ({
      short: frequencyWindow(
        analysis.recentDigits,
        40
      ),
      medium: frequencyWindow(
        analysis.recentDigits,
        100
      ),
      long: frequencyWindow(
        analysis.recentDigits,
        250
      ),
    }),
    [analysis.recentDigits]
  );

  const transitionAnalysis = useMemo(
    () =>
      transitionMatrixAnalysis(
        analysis.recentDigits
      ),
    [analysis.recentDigits]
  );

  const observedCycle = useMemo(
    () =>
      cycleAnalysis(
        analysis.recentDigits
      ),
    [analysis.recentDigits]
  );

  const meanReversion = useMemo(
    () =>
      meanReversionAnalysis(
        analysis.recentDigits
      ),
    [analysis.recentDigits]
  );

  const marketSymbols = useMemo(
    () =>
      (Array.isArray(markets)
        ? markets
        : []
      )
        .map((item) =>
          String(
            item?.symbol ??
              item?.value ??
              item?.id ??
              ""
          )
        )
        .filter(Boolean),
    [markets]
  );

  const smartRecoveryActive =
    recovery.active &&
    recoveryMode === "SMART";

  const rankedCandidates = useMemo(
    () =>
      analysis.candidates
        .map((candidate) => {
          const side = String(
            candidate?.side || "WAIT"
          ).toUpperCase();
          const barrier = Number(
            candidate?.barrier ?? 2
          );
          const learned = memoryStats(
            memory,
            symbol,
            side,
            barrier
          );

          const safetyScore =
            barrierSafetyScore(
              side,
              barrier
            );

          const payoutEdge =
            Number(candidate.probability || 0) -
            Number(
              learned.requiredProbability || 100
            );

          const laneScore =
            barrierLaneScore(
              side,
              barrier,
              smartRecoveryActive
            );

          const theoreticalPrior =
            barrierSafetyScore(
              side,
              barrier
            ) / 100;

          const bayesian =
            bayesianBarrierProbability({
              digits:
                analysis.recentDigits,
              side,
              barrier,
              prior: theoreticalPrior,
            });

          const layered =
            multiLayerCandidateScore({
              candidate: {
                ...candidate,
                side,
                barrier,
              },
              frequencies:
                multiWindowFrequency,
              transition:
                transitionAnalysis,
              cycle: observedCycle,
              meanReversion,
              bayesian,
              regime: regimeAnalysis,
              resultRisk,
              recoveryActive:
                smartRecoveryActive,
            });

          const agreementVotes = [
            layered.shortFrequency >=
              Number(candidate.probability || 0) -
                8,
            layered.mediumFrequency >=
              Number(candidate.probability || 0) -
                10,
            layered.transitionProbability >=
              55,
            layered.bayesianPosterior >=
              Number(
                learned.requiredProbability || 100
              ),
            layered.reversionCompatibility >=
              55,
            layered.simulation.expectedValue >=
              Number(evFloor || 0.015),
            layered.simulation.confidenceLow >=
              -0.02,
          ].filter(Boolean).length;

          const regimeAdjustedScore = clamp(
            multiLayerEnabled
              ? layered.finalScore
              : candidateScore(
                  candidate,
                  learned
                ) +
                  regimeAnalysis.qualityBonus -
                  regimeAnalysis.riskPenalty -
                  Number(resultRisk.risk || 0) *
                    0.18,
            0,
            100
          );

          return {
            ...candidate,
            side,
            barrier,
            learned,
            safetyScore,
            payoutEdge,
            laneScore,
            bayesian,
            layered,
            agreementVotes,
            guardRisk:
              Number(resultRisk.risk || 0) +
              Number(regimeAnalysis.riskPenalty || 0),
            regimeAdjustedScore,
            adaptiveScore:
              regimeAdjustedScore,
          };
        })
        .filter(
          (item) =>
            ["OVER", "UNDER"].includes(
              item.side
            ) &&
            marketBlockRemaining(
              marketBlocks,
              symbol
            ) <= 0 &&
            !item.learned.blocked &&
            Number(item.probability || 0) >=
              Number(item.learned.requiredProbability || 100)
        )
        .sort((a, b) => {
          if (smartRecoveryActive) {
            const recoveryA =
              Number(a.adaptiveScore || 0) * 0.65 +
              Number(a.safetyScore || 0) * 0.25 +
              Number(a.payoutEdge || 0) * 0.08 +
              Number(a.laneScore || 0) * 0.12;

            const recoveryB =
              Number(b.adaptiveScore || 0) * 0.65 +
              Number(b.safetyScore || 0) * 0.25 +
              Number(b.payoutEdge || 0) * 0.08 +
              Number(b.laneScore || 0) * 0.12;

            return recoveryB - recoveryA;
          }

          return (
            Number(b.adaptiveScore || 0) -
            Number(a.adaptiveScore || 0)
          );
        }),
    [
      analysis.candidates,
      memory,
      symbol,
      marketBlocks,
      regimeAnalysis,
      resultRisk,
      multiWindowFrequency,
      transitionAnalysis,
      observedCycle,
      meanReversion,
      multiLayerEnabled,
      minimumLayerAgreement,
      evFloor,
      recovery.active,
      recoveryMode,
      smartRecoveryActive,
    ]
  );

  const bestOver = useMemo(
    () =>
      rankedCandidates.find(
        (candidate) =>
          String(candidate.side || "") === "OVER"
      ) || null,
    [rankedCandidates]
  );

  const bestUnder = useMemo(
    () =>
      rankedCandidates.find(
        (candidate) =>
          String(candidate.side || "") === "UNDER"
      ) || null,
    [rankedCandidates]
  );

  const balancedDecision = useMemo(
    () =>
      balancedLaneDecision({
        overCandidate: bestOver,
        underCandidate: bestUnder,
        sidePreference:
          balancedSidesEnabled
            ? sidePreference
            : "AUTO",
        minimumSideLead,
      }),
    [
      bestOver,
      bestUnder,
      balancedSidesEnabled,
      sidePreference,
      minimumSideLead,
    ]
  );

  const universalDecision = useMemo(
    () =>
      universalCandidateDecision({
        rankedCandidates,
        blockedSetups:
          dynamicSetupBlacklist?.[symbol] || {},
        minimumProbability:
          universalMinimumProbability,
        minimumEV: evFloor,
        minimumVotes:
          universalMinimumVotes,
        maximumRisk:
          universalMaximumRisk,
      }),
    [
      rankedCandidates,
      dynamicSetupBlacklist,
      symbol,
      universalMinimumProbability,
      evFloor,
      universalMinimumVotes,
      universalMaximumRisk,
    ]
  );

  const best =
    (
      universalPoolEnabled
        ? universalDecision.selected
        : balancedDecision.selected
    ) || {
      side: "WAIT",
      barrier: 2,
      adaptiveScore: 0,
      probability: 0,
      learned: memoryStats(
        memory,
        symbol,
        "WAIT",
        2
      ),
    };

  const activeGuard = useMemo(
    () =>
      predictiveGuard({
        regime: regimeAnalysis,
        resultRisk,
        candidate: best,
        tradesOnCurrentMarket,
        proactiveRotationTrades,
      }),
    [
      regimeAnalysis,
      resultRisk,
      best,
      tradesOnCurrentMarket,
      proactiveRotationTrades,
    ]
  );

  const currentMarketDecision = useMemo(() => {
    const blacklistRemaining =
      Math.max(
        0,
        Number(
          dynamicMarketBlacklist?.[symbol] || 0
        ) - Date.now()
      );

    return qualifiedMarketDecision({
      market: symbol,
      candidate: {
        ...best,
        guardRisk: Number(activeGuard.risk || 0),
      },
      protectionActive,
      blacklisted: blacklistRemaining > 0,
      weakMarket:
        Boolean(marketHealth?.[symbol]?.weak),
      minimumProbability:
        minimumQualifiedProbability,
      minimumEV: evFloor,
      minimumVotes:
        minimumQualifiedVotes,
      maximumRisk:
        maximumQualifiedRisk,
    });
  }, [
    symbol,
    best,
    activeGuard.risk,
    dynamicMarketBlacklist,
    protectionActive,
    marketHealth,
    minimumQualifiedProbability,
    evFloor,
    minimumQualifiedVotes,
    maximumQualifiedRisk,
  ]);



  const bestKey = memoryKey(
    symbol,
    best.side,
    best.barrier
  );

  useEffect(() => {
    if (
      !symbol ||
      !Array.isArray(effectivePrices) ||
      effectivePrices.length < 8
    ) {
      return;
    }

    const lastLiveItem =
      Array.isArray(prices) && prices.length
        ? prices[prices.length - 1]
        : null;

    const signature = [
      symbol,
      prices.length,
      normalizePriceKey(
        lastLiveItem,
        Math.max(0, prices.length - 1)
      ),
      effectivePrices.length,
    ].join(":");

    if (
      lastRawCacheSignatureRef.current ===
      signature
    ) {
      return;
    }

    lastRawCacheSignatureRef.current =
      signature;

    setMarketBrowserCache((current) => ({
      ...current,
      [symbol]: {
        ...(current?.[symbol] || {}),
        symbol,
        prices: effectivePrices.slice(-320),
        recentDigits:
          analysis.recentDigits.slice(-250),
        analysisTotal:
          Number(analysis.total || 0),
        updatedAt: Date.now(),
      },
    }));
  }, [
    symbol,
    prices,
    effectivePrices,
    analysis.recentDigits,
    analysis.total,
  ]);

  useEffect(() => {
    if (!symbol || !best) return;

    const snapshot = {
      market: symbol,
      contract:
        best.contract ||
        `${best.side || ""} ${best.barrier ?? ""}`.trim(),
      side: String(best.side || "WAIT"),
      barrier: Number(best.barrier ?? 2),
      overScore:
        Number(balancedDecision.overScore || 0),
      underScore:
        Number(balancedDecision.underScore || 0),
      laneReason:
        balancedDecision.reason,
      probability:
        Number(currentMarketDecision.probability || 0),
      expectedValue:
        Number(currentMarketDecision.expectedValue || 0),
      votes:
        Number(currentMarketDecision.votes || 0),
      risk:
        Number(currentMarketDecision.risk || 0),
      qualified:
        Boolean(currentMarketDecision.qualified),
      reasons:
        currentMarketDecision.reasons || [],
      updatedAt: Date.now(),
    };

    const decisionSignature = [
      symbol,
      snapshot.contract,
      snapshot.probability.toFixed(3),
      snapshot.expectedValue.toFixed(4),
      snapshot.votes,
      snapshot.risk.toFixed(3),
      snapshot.qualified ? "1" : "0",
      snapshot.reasons.join("|"),
    ].join(":");

    if (
      lastDecisionCacheSignatureRef.current ===
      decisionSignature
    ) {
      return;
    }

    lastDecisionCacheSignatureRef.current =
      decisionSignature;

    setMarketBrowserCache((current) => ({
      ...current,
      [symbol]: {
        ...(current?.[symbol] || {}),
        ...snapshot,
      },
    }));

    setGlobalMarketScores((current) => ({
      ...current,
      [symbol]: snapshot,
    }));
  }, [
    symbol,
    best,
    currentMarketDecision,
  ]);

  useEffect(() => {
    const hydrated = {};

    for (
      const [marketName, row]
      of Object.entries(marketBrowserCache || {})
    ) {
      if (cacheIsFresh(row, cacheFreshnessSeconds)) {
        hydrated[marketName] = {
          market: marketName,
          contract: row.contract || "CACHED",
          probability: Number(row.probability || 0),
          expectedValue: Number(row.expectedValue || 0),
          votes: Number(row.votes || 0),
          risk: Number(row.risk || 0),
          qualified: Boolean(row.qualified),
          reasons: row.reasons || [],
          updatedAt: Number(row.updatedAt || 0),
          cached: true,
        };
      }
    }

    setGlobalMarketScores((current) => ({
      ...hydrated,
      ...current,
    }));
  }, [
    marketBrowserCache,
    cacheFreshnessSeconds,
  ]);

  const currentFreshSetupKey = useMemo(
    () =>
      freshSetupKey({
        market: symbol,
        side: best.side,
        barrier: best.barrier,
        digits: analysis.recentDigits,
      }),
    [
      symbol,
      best.side,
      best.barrier,
      analysis.recentDigits,
    ]
  );

  const marketRunLocked = Boolean(
    oneRunPerMarket &&
    lastTradeByMarket?.[symbol]
  );

  const setupRepeated = Boolean(
    lastSetupKeyByMarket?.[symbol] &&
    lastSetupKeyByMarket[symbol] ===
      currentFreshSetupKey
  );

  const lastMarketTrade =
    trades.find(
      (trade) =>
        String(trade.symbol || "") === symbol &&
        ["WON", "LOST", "OPEN"].includes(
          String(trade.status || "").toUpperCase()
        )
    ) || null;

  const sameBarrierRepeated = Boolean(
    lastMarketTrade &&
    String(lastMarketTrade.side || "") ===
      String(best.side || "") &&
    Number(lastMarketTrade.barrier) ===
      Number(best.barrier)
  );


  const blockedByLastLoss =
    lastLossKeyRef.current === bestKey;

  const recoveryScoreGate =
    Number(minimumScore) +
    (smartRecoveryActive ? 6 : 0);

  const recoveryConfidenceGate =
    Number(minimumConfidence) +
    (smartRecoveryActive ? 5 : 0);

  const recoverySetupPass =
    !smartRecoveryActive ||
    bestKey !== recovery.previousLossKey;

  const entryReady =
    !protectionActive &&
    !marketRunLocked &&
    !setupRepeated &&
    !sameBarrierRepeated &&
    (
      !universalPoolEnabled ||
      Boolean(universalDecision.selected)
    ) &&
    (
      !globalSelectionEnabled ||
      currentMarketDecision.qualified
    ) &&
    analysis.total >= 30 &&
    best.side !== "WAIT" &&
    Number(analysis.confidence || 0) >=
      recoveryConfidenceGate &&
    Number(best.adaptiveScore || 0) >=
      recoveryScoreGate &&
    Number(best.probability || 0) >=
      Number(best.learned.requiredProbability || 100) +
        (smartRecoveryActive ? 4 : 0) &&
    Number(best.payoutEdge || 0) >=
      (smartRecoveryActive ? 4 : 1.5) &&
    Number(regimeAnalysis.riskPenalty || 0) <=
      (smartRecoveryActive ? 18 : 25) &&
    Number(regimeAnalysis.sample || 0) >= 30 &&
    (
      !predictiveGuardEnabled ||
      (
        activeGuard.state !== "BLOCK" &&
        Number(activeGuard.risk || 0) <
          Number(guardThreshold || 58)
      )
    ) &&
    (
      !multiLayerEnabled ||
      (
        Number(best.agreementVotes || 0) >=
          Number(minimumLayerAgreement || 5) &&
        Number(
          best.layered?.simulation
            ?.expectedValue || -1
        ) >= Number(evFloor || 0.015) &&
        Number(
          best.layered?.weightedProbability || 0
        ) >=
          Number(
            best.learned.requiredProbability || 100
          )
      )
    ) &&
    !best.learned.blocked &&
    !blockedByLastLoss &&
    recoverySetupPass;

  useEffect(() => {
    if (!running || !entryReady) {
      confirmationRef.current = {
        key: "",
        ticks: 0,
      };
      return;
    }

    confirmationRef.current =
      confirmationRef.current.key === bestKey
        ? {
            key: bestKey,
            ticks:
              confirmationRef.current.ticks + 1,
          }
        : {
            key: bestKey,
            ticks: 1,
          };
  }, [
    running,
    entryReady,
    bestKey,
    prices.length,
  ]);

  const confirmed =
    entryReady &&
    confirmationRef.current.key === bestKey &&
    confirmationRef.current.ticks >= 2;

  const hasOpenTrade = trades.some(
    (trade) => trade.status === "OPEN"
  );

  function stop(text) {
    runningRef.current = false;
    setRunning(false);
    setMessage(text);
  }

  function nextMarket() {
    if (!marketSymbols.length) return "";

    const currentIndex =
      marketSymbols.indexOf(symbol);

    for (
      let step = 1;
      step <= marketSymbols.length;
      step++
    ) {
      const candidate =
        marketSymbols[
          (
            Math.max(0, currentIndex) + step
          ) %
            marketSymbols.length
        ];

      const blacklistRemaining =
        Math.max(
          0,
          Number(
            dynamicMarketBlacklist?.[candidate] || 0
          ) - Date.now()
        );

      const weakMarket =
        Boolean(marketHealth?.[candidate]?.weak);

      const alreadyUsed =
        Boolean(
          oneRunPerMarket &&
          lastTradeByMarket?.[candidate]
        );

      if (
        candidate &&
        candidate !== symbol &&
        !alreadyUsed &&
        marketBlockRemaining(
          marketBlocks,
          candidate
        ) <= 0 &&
        blacklistRemaining <= 0 &&
        !weakMarket
      ) {
        return candidate;
      }
    }

    return "";
  }

  async function switchMarket(reason) {
    if (
      switchBusyRef.current ||
      hasOpenTrade ||
      tradeBusy ||
      typeof changeSymbol !== "function"
    ) {
      return;
    }

    const next = nextMarket();

    if (!next || next === symbol) return;

    switchBusyRef.current = true;
    lastSwitchAtRef.current = Date.now();
    scanStartedAtRef.current = Date.now();
    marketEnteredAtRef.current = Date.now();
    lastRawCacheSignatureRef.current = "";
    lastDecisionCacheSignatureRef.current = "";
    confirmationRef.current = {
      key: "",
      ticks: 0,
    };

    const warmRow =
      marketBrowserCache?.[next];

    setMessage(
      `Switching ${symbol} → ${next} · ${
        cacheIsFresh(
          warmRow,
          cacheFreshnessSeconds
        )
          ? "WARM CACHE READY"
          : "COLLECTING FRESH DATA"
      } · ${reason}`
    );

    try {
      await Promise.resolve(
        changeSymbol(next)
      );

      setTradesOnCurrentMarket(0);
      playTradeSound("SWITCH");

      setStats((current) => ({
        ...current,
        switches: current.switches + 1,
      }));
    } finally {
      window.setTimeout(() => {
        switchBusyRef.current = false;
      }, Math.max(
      250,
      Number(fastScanMilliseconds || 650)
    ));
    }
  }

  async function executeTrade() {
    if (
      busyRef.current ||
      !runningRef.current ||
      hasOpenTrade ||
      !confirmed ||
      Date.now() < nextEntryAtRef.current
    ) {
      return;
    }

    if (!connected) {
      setMessage(
        "Waiting for Deriv connection."
      );
      return;
    }

    if (!selectedAccountId) {
      stop(
        "Choose a Demo or Real account."
      );
      return;
    }

    if (
      selectedAccountType !== "demo" &&
      !allowReal
    ) {
      stop(
        "Real execution is locked. Enable it manually."
      );
      return;
    }

    busyRef.current = true;

    try {
      const contractType =
        best.side === "OVER"
          ? "DIGITOVER"
          : "DIGITUNDER";

      const result = await placeTrade({
        symbol,
        contractType,
        amount: recoveryStakeAmount(
          stake,
          recoveryMode === "SMART"
            ? recovery
            : { active: false },
          maximumRecoveryStake,
          recoveryTarget,
          best.learned.profitRatio,
          recoveryMultiplier
        ),
        basis: "stake",
        duration: Math.max(
          1,
          Number(durationTicks) || 1
        ),
        durationUnit: "t",
        barrier: String(best.barrier),
      });

      const contractId = String(
        result?.contractId || ""
      );

      const trade = {
        id:
          contractId ||
          `${Date.now()}`,
        contractId,
        time: Date.now(),
        symbol,
        side: best.side,
        barrier: best.barrier,
        contract: `${best.side} ${best.barrier}`,
        duration: `${durationTicks} TICK`,
        stake: recoveryStakeAmount(
          stake,
          recoveryMode === "SMART"
            ? recovery
            : { active: false },
          maximumRecoveryStake,
          recoveryTarget,
          best.learned.profitRatio,
          recoveryMultiplier
        ),
        recoveryMode: smartRecoveryActive,
        recoveryAttempt: smartRecoveryActive
          ? recovery.attempts
          : 0,
        recoveryDebtAtEntry: recoveryDebt,
        confidence:
          analysis.confidence,
        score: best.adaptiveScore,
        probability: best.probability,
        learnedTrades:
          best.learned.trades,
        status: "OPEN",
        profit: 0,
      };

      previousTradeStatusRef.current.set(
        String(trade.contractId || trade.id),
        "OPEN"
      );

      setTrades((current) =>
        [trade, ...current].slice(0, 50)
      );

      setTradesOnCurrentMarket(
        (current) => current + 1
      );

      setLastTradeByMarket((current) => ({
        ...current,
        [symbol]: Date.now(),
      }));

      setLastSetupKeyByMarket((current) => ({
        ...current,
        [symbol]: currentFreshSetupKey,
      }));

      playTradeSound("OPEN");

      setStats((current) => ({
        ...current,
        runs: current.runs + 1,
      }));

      setMessage(
        `${recovery.active ? `RECOVERY ${recovery.attempts}/2` : "NORMAL"} · ${best.side} ${best.barrier} opened · stake ${recoveryStakeAmount(
          stake,
          recoveryMode === "SMART"
            ? recovery
            : { active: false },
          maximumRecoveryStake,
          recoveryTarget,
          best.learned.profitRatio,
          recoveryMultiplier
        ).toFixed(2)} · score ${best.adaptiveScore.toFixed(
          1
        )}% · memory ${best.learned.trades} trades.`
      );

      nextEntryAtRef.current =
        Date.now() + 2500;
      scanStartedAtRef.current =
        Date.now();
      confirmationRef.current = {
        key: "",
        ticks: 0,
      };
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Trade execution failed."
      );
    } finally {
      busyRef.current = false;
    }
  }

  useEffect(() => {
    if (
      !running ||
      hasOpenTrade ||
      tradeBusy ||
      !protectionEnabled
    ) {
      return undefined;
    }

    const cascadeTriggered =
      Number(protectionStats.lossStreak || 0) >=
      Number(maximumLossCascade || 2);

    const weakRecentRate =
      Number(protectionStats.sample || 0) >= 8 &&
      Number(protectionStats.winRate || 100) <
        Number(minimumRecentWinRate || 58);

    const negativePayoff =
      Number(protectionStats.sample || 0) >= 8 &&
      Number(protectionStats.netProfit || 0) < -0.7;

    if (
      !cascadeTriggered &&
      !weakRecentRate &&
      !negativePayoff
    ) {
      return undefined;
    }

    const now = Date.now();
    const pauseUntil =
      now +
      Math.max(
        8,
        Number(protectionPauseSeconds || 18)
      ) *
        1000;

    setProtectionUntil(pauseUntil);

    if (symbol) {
      setDynamicMarketBlacklist((current) => ({
        ...current,
        [symbol]:
          now +
          Math.max(
            25,
            Number(protectionPauseSeconds || 18) + 12
          ) *
            1000,
      }));
    }

    setMessage(
      `PROTECTION MODE · ${cascadeTriggered
        ? `${protectionStats.lossStreak} consecutive losses`
        : weakRecentRate
        ? `recent win rate ${Number(
            protectionStats.winRate || 0
          ).toFixed(1)}%`
        : `recent P/L ${Number(
            protectionStats.netProfit || 0
          ).toFixed(2)} USD`
      }. Pausing entries, blacklisting ${symbol}, and scanning a fresh market.`
    );

    const timer = window.setTimeout(() => {
      void switchMarket(
        "Adaptive protection moved away from a weakening market"
      );
    }, 350);

    return () => window.clearTimeout(timer);
  }, [
    running,
    hasOpenTrade,
    tradeBusy,
    protectionEnabled,
    protectionStats,
    maximumLossCascade,
    minimumRecentWinRate,
    protectionPauseSeconds,
    symbol,
  ]);

  useEffect(() => {
    if (!running || !globalSelectionEnabled) {
      return undefined;
    }

    setGlobalMarketScores((current) => ({
      ...current,
      [symbol]: {
        market: symbol,
        contract:
          best.contract ||
          `${best.side || ""} ${best.barrier ?? ""}`.trim(),
        probability:
          currentMarketDecision.probability,
        expectedValue:
          currentMarketDecision.expectedValue,
        votes:
          currentMarketDecision.votes,
        risk:
          currentMarketDecision.risk,
        qualified:
          currentMarketDecision.qualified,
        reasons:
          currentMarketDecision.reasons,
        updatedAt: Date.now(),
      },
    }));

    if (
      currentMarketDecision.qualified
    ) {
      setSelectedGlobalSetup({
        market: symbol,
        contract:
          best.contract ||
          `${best.side || ""} ${best.barrier ?? ""}`.trim(),
        probability:
          currentMarketDecision.probability,
        expectedValue:
          currentMarketDecision.expectedValue,
        votes:
          currentMarketDecision.votes,
        risk:
          currentMarketDecision.risk,
      });
      setLastSkipReason("");
      return undefined;
    }

    setSelectedGlobalSetup(null);
    setLastSkipReason(
      currentMarketDecision.reasons.join(", ") ||
        "NO_QUALIFIED_SETUP"
    );

    if (
      hasOpenTrade ||
      tradeBusy ||
      marketSymbols.length < 2
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void switchMarket(
        `NO QUALIFIED MARKET · ${currentMarketDecision.reasons.join(
          ", "
        ) || "setup rejected"}`
      );
    }, 900);

    return () =>
      window.clearTimeout(timer);
  }, [
    running,
    globalSelectionEnabled,
    symbol,
    best,
    currentMarketDecision,
    hasOpenTrade,
    tradeBusy,
    marketSymbols,
  ]);

  useEffect(() => {
    if (
      !running ||
      hasOpenTrade ||
      tradeBusy ||
      !rotateAfterEverySettlement ||
      !lastSettledTrade
    ) {
      return undefined;
    }

    const settledAt = Number(
      lastSettledTrade.settledAt ||
      lastSettledTrade.updatedAt ||
      lastSettledTrade.createdAt ||
      0
    );

    if (!settledAt) {
      return undefined;
    }

    const age = Date.now() - settledAt;

    if (age < 0 || age > 2500) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void switchMarket(
        `One-run rule: ${lastSettledTrade.status || "SETTLED"} on ${lastSettledTrade.symbol || symbol}. Scanning a new market.`
      );
    }, 450);

    return () => window.clearTimeout(timer);
  }, [
    running,
    hasOpenTrade,
    tradeBusy,
    rotateAfterEverySettlement,
    lastSettledTrade,
    symbol,
  ]);

  useEffect(() => {
    if (
      running &&
      confirmed &&
      !hasOpenTrade &&
      (
        !globalSelectionEnabled ||
        (
          selectedGlobalSetup?.market === symbol &&
          currentMarketDecision.qualified
        )
      )
    ) {
      void executeTrade();
    }
  }, [
    running,
    confirmed,
    hasOpenTrade,
    bestKey,
    symbol,
  ]);

  useEffect(() => {
    if (
      !oneRunPerMarket ||
      !symbol ||
      !lastTradeByMarket?.[symbol]
    ) {
      return undefined;
    }

    const recentCount =
      Array.isArray(analysis.recentDigits)
        ? analysis.recentDigits.length
        : 0;

    if (
      recentCount <
      Number(freshTicksRequired || 12)
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setLastTradeByMarket((current) => {
        const next = { ...current };
        delete next[symbol];
        return next;
      });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [
    oneRunPerMarket,
    symbol,
    lastTradeByMarket,
    analysis.recentDigits,
    freshTicksRequired,
  ]);

  useEffect(() => {
    if (
      !running ||
      !protectionActive
    ) {
      return undefined;
    }

    const remaining =
      Math.max(
        0,
        Number(protectionUntil || 0) - Date.now()
      );

    const timer = window.setTimeout(() => {
      setProtectionUntil(0);
      scanStartedAtRef.current = Date.now();
      confirmationRef.current = {
        key: "",
        ticks: 0,
      };
      setMessage(
        "PROTECTION RELEASED · Fresh market must pass predictive guard, layer agreement and EV before trading."
      );
    }, remaining + 100);

    return () => window.clearTimeout(timer);
  }, [
    running,
    protectionActive,
    protectionUntil,
  ]);

  useEffect(() => {
    if (
      !running ||
      hasOpenTrade ||
      tradeBusy ||
      !predictiveGuardEnabled ||
      marketSymbols.length < 2
    ) {
      return undefined;
    }

    if (
      activeGuard.state !== "BLOCK" &&
      Number(activeGuard.risk || 0) <
        Number(guardThreshold || 58)
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void switchMarket(
        `Predictive guard blocked ${symbol} at ${Number(
          activeGuard.risk || 0
        ).toFixed(1)} risk`
      );
    }, 500);

    return () => window.clearTimeout(timer);
  }, [
    running,
    hasOpenTrade,
    tradeBusy,
    predictiveGuardEnabled,
    activeGuard,
    guardThreshold,
    marketSymbols,
    symbol,
  ]);

  useEffect(() => {
    if (
      !running ||
      hasOpenTrade ||
      tradeBusy ||
      smartRecoveryActive ||
      marketSymbols.length < 2
    ) {
      return undefined;
    }

    if (
      tradesOnCurrentMarket <
      Number(proactiveRotationTrades || 5)
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void switchMarket(
        `Proactive rotation after ${tradesOnCurrentMarket} trades`
      );
    }, 700);

    return () =>
      window.clearTimeout(timer);
  }, [
    running,
    hasOpenTrade,
    tradeBusy,
    smartRecoveryActive,
    marketSymbols,
    tradesOnCurrentMarket,
    proactiveRotationTrades,
    symbol,
  ]);

  useEffect(() => {
    if (
      !running ||
      hasOpenTrade ||
      tradeBusy ||
      marketSymbols.length < 2
    ) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      const delay =
        Math.max(
          5,
          Number(switchSeconds) || 8
        ) * 1000;

      const currentMarketBlocked =
        marketBlockRemaining(
          marketBlocks,
          symbol
        ) > 0;

      if (
        (
          currentMarketBlocked ||
          Date.now() -
            scanStartedAtRef.current >=
            delay
        ) &&
        Date.now() -
          lastSwitchAtRef.current >=
          Math.min(delay, 3000) &&
        !confirmed
      ) {
        void switchMarket(
          currentMarketBlocked
            ? "Current market is cooling down"
            : recovery.active
            ? "No clear recovery entry; rotating"
            : blockedByLastLoss
            ? "Last losing setup blocked"
            : "No confirmed adaptive entry"
        );
      }
    }, 500);

    return () =>
      window.clearInterval(timer);
  }, [
    running,
    hasOpenTrade,
    tradeBusy,
    marketSymbols,
    switchSeconds,
    confirmed,
    blockedByLastLoss,
    symbol,
    marketBlocks,
    recovery.active,
  ]);

  useEffect(() => {
    const contracts = Array.isArray(
      openContracts
    )
      ? openContracts
      : [];

    if (!contracts.length) return;

    let settled = null;

    setTrades((current) =>
      current.map((trade) => {
        const match = contracts.find(
          (item) =>
            contractIdOf(item) ===
            trade.contractId
        );

        if (!match) return trade;

        const status =
          contractStatus(match);
        const closed = [
          "WON",
          "LOST",
          "SOLD",
          "EXPIRED",
        ].includes(status);

        if (
          closed &&
          trade.contractId &&
          !processedRef.current.has(
            trade.contractId
          )
        ) {
          processedRef.current.add(
            trade.contractId
          );

          settled = {
            ...trade,
            status,
            profit: profitOf(match),
          };
        }

        return {
          ...trade,
          status,
          profit: closed
            ? profitOf(match)
            : 0,
        };
      })
    );

    if (!settled) return;

    const settledSnapshot = {
      ...settled,
      settledAt: Date.now(),
    };

    setLastSettledTrade(
      settledSnapshot
    );

    const result =
      settled.status === "WON"
        ? "WON"
        : "LOST";

    if (result === "LOST") {
      const marketName =
        settled.symbol || symbol;
      const lostSide =
        String(
          settled.side || ""
        ).toUpperCase();
      const lostBarrier =
        Number(settled.barrier ?? -1);
      const setupKey =
        `${lostSide}:${lostBarrier}`;

      const matchingRecentLosses =
        trades.filter((trade) =>
          String(trade.symbol || "") ===
            String(marketName) &&
          String(
            trade.side || ""
          ).toUpperCase() === lostSide &&
          Number(trade.barrier ?? -1) ===
            lostBarrier &&
          String(
            trade.status || ""
          ).toUpperCase() === "LOST"
        ).length + 1;

      if (matchingRecentLosses >= 2) {
        setDynamicSetupBlacklist(
          (current) => ({
            ...current,
            [marketName]: {
              ...(current?.[marketName] || {}),
              [setupKey]:
                Date.now() +
                Number(
                  setupBlacklistSeconds || 90
                ) *
                  1000,
            },
          })
        );
      }
    }

    setMemory((current) =>
      updateMemory(current, {
        symbol: settled.symbol,
        side: settled.side,
        barrier: settled.barrier,
        result,
        profit: settled.profit,
        stake: settled.stake,
        confidence:
          settled.confidence,
        score: settled.score,
      })
    );

    const updatedSetupTrades =
      Number(
        memoryStats(
          memory,
          settled.symbol,
          settled.side,
          settled.barrier
        ).trades
      ) + 1;

    setTrades((current) =>
      current.map((trade) =>
        trade.id === settled.id
          ? {
              ...trade,
              learnedTrades:
                updatedSetupTrades,
            }
          : trade
      )
    );

    setStats((current) => ({
      ...current,
      wins:
        current.wins +
        (result === "WON" ? 1 : 0),
      losses:
        current.losses +
        (result === "LOST" ? 1 : 0),
      profit:
        current.profit +
        Number(settled.profit || 0),
    }));

    if (result === "WON") {
      setConsecutiveLosses(0);

      const wonAmount = Math.max(
        0,
        Number(settled.profit || 0)
      );

      if (settled.recoveryMode) {
        const remainingDebt = Math.max(
          0,
          Number(recoveryDebt || 0) -
            wonAmount
        );

        setRecoveryDebt(remainingDebt);
        setRecoveryTarget(remainingDebt);

        if (remainingDebt <= 0.001) {
          setRecovery({
            active: false,
            attempts: 0,
            previousLossKey: "",
            previousLossAmount: 0,
          });
          lastLossKeyRef.current = "";
          setMessage(
            `RECOVERY COMPLETE ${settled.contract}. Debt cleared; returning to normal lane.`
          );
        } else {
          setRecovery((current) => ({
            ...current,
            active: true,
          }));
          setMessage(
            `RECOVERY PARTIAL ${settled.contract}. ${remainingDebt.toFixed(
              2
            )} USD remains; searching one more clear recovery setup.`
          );
        }
      } else {
        setRecovery({
          active: false,
          attempts: 0,
          previousLossKey: "",
          previousLossAmount: 0,
        });
        setRecoveryDebt(0);
        setRecoveryTarget(0);
        lastLossKeyRef.current = "";
        setMessage(
          `WIN ${settled.contract}. Searching next normal low-barrier entry immediately.`
        );
      }
    } else {
      setConsecutiveLosses((current) => current + 1);
      const newLossAmount = Math.abs(
        Number(settled.profit || 0)
      );

      setRecoveryDebt((current) =>
        Number(current || 0) + newLossAmount
      );

      setRecoveryTarget((current) =>
        Number(current || 0) + newLossAmount
      );
      setMarketBlocks((current) => ({
        ...current,
        [settled.symbol]:
          Date.now() + 60000,
      }));
      playTradeSound("RECOVERY");

      setRecovery((current) => ({
        active:
          recoveryMode === "SMART",
        attempts: Math.min(
          maximumRecoveryAttempts,
          Number(current.attempts || 0) + 1
        ),
        previousLossKey: memoryKey(
          settled.symbol,
          settled.side,
          settled.barrier
        ),
        previousLossAmount: Math.abs(
          Number(settled.profit || 0)
        ),
      }));
      lastLossKeyRef.current =
        memoryKey(
          settled.symbol,
          settled.side,
          settled.barrier
        );

      setMessage(
        `LOSS ${settled.contract}. Recovery debt ${(
          Number(recoveryDebt || 0) +
          newLossAmount
        ).toFixed(
          2
        )} USD. Scanning every market for the strongest EV-positive recovery barrier.`
      );
    }

    if (
      result === "LOST" &&
      (
        consecutiveLosses >= 2 ||
        (
          settled.recoveryMode &&
          Number(settled.recoveryAttempt || 0) >=
            maximumRecoveryAttempts
        )
      )
    ) {
      stop(
        "Recovery safety limit reached. Bot paused for review."
      );
      return;
    }

    nextEntryAtRef.current =
      Date.now() +
      (result === "WON" ? 1200 : 2500);
    scanStartedAtRef.current =
      Date.now();
    confirmationRef.current = {
      key: "",
      ticks: 0,
    };

    if (
      result === "LOST" &&
      runningRef.current
    ) {
      window.setTimeout(() => {
        void switchMarket(
          "Loss market blocked; searching fresh recovery entry"
        );
      }, 900);
    }
  }, [openContracts]);

  async function toggle() {
    await unlockSounds();

    if (running) {
      stop("Stopped manually.");
      return;
    }

    if (
      selectedAccountType !== "demo" &&
      !allowReal
    ) {
      setMessage(
        "Switch to Demo or enable Real execution."
      );
      return;
    }

    runningRef.current = true;
    setRunning(true);
    scanStartedAtRef.current =
      Date.now();
    confirmationRef.current = {
      key: "",
      ticks: 0,
    };
    setMessage(
      "Reading live digits continuously and learning every settled setup."
    );
  }

  function clearBrowserMarketMemory() {
    lastRawCacheSignatureRef.current = "";
    lastDecisionCacheSignatureRef.current = "";
    setMarketBrowserCache({});
    setGlobalMarketScores({});
    setSelectedGlobalSetup(null);

    try {
      window.localStorage.removeItem(
        MARKET_BROWSER_CACHE_KEY
      );
    } catch {
      // Ignore unavailable storage.
    }

    setMessage(
      "Browser market memory cleared. Collecting fresh market data."
    );
  }

  function reset() {
    setTrades([]);
    setLastSettledTrade(null);
    setConsecutiveLosses(0);
    setRecovery({
      active: false,
      attempts: 0,
      previousLossKey: "",
      previousLossAmount: 0,
    });
    setRecoveryTarget(0);
    setRecoveryDebt(0);
    setTradesOnCurrentMarket(0);
    setMarketBlocks({});
    setStats({
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      switches: 0,
    });
    processedRef.current = new Set();
    soundedTradeIdsRef.current = new Set();
    previousTradeStatusRef.current = new Map();
    lastLossKeyRef.current = "";
    setMessage(
      running
        ? "Session reset; learning memory retained."
        : "Session reset."
    );
  }

  const winRate = stats.runs
    ? (stats.wins / stats.runs) * 100
    : 0;

  const settledTrades = trades.filter(
    (trade) =>
      ["WON", "LOST", "SOLD", "EXPIRED"].includes(
        String(trade.status || "").toUpperCase()
      )
  );

  const openTradeCount = trades.filter(
    (trade) =>
      String(trade.status || "").toUpperCase() ===
      "OPEN"
  ).length;

  const totalStaked = settledTrades.reduce(
    (total, trade) =>
      total + Number(trade.stake || 0),
    0
  );

  const grossWins = settledTrades.reduce(
    (total, trade) =>
      total +
      Math.max(0, Number(trade.profit || 0)),
    0
  );

  const grossLosses = settledTrades.reduce(
    (total, trade) =>
      total +
      Math.abs(
        Math.min(0, Number(trade.profit || 0))
      ),
    0
  );

  const netProfit = grossWins - grossLosses;

  const filteredTrades = trades.filter(
    (trade) => {
      if (journalFilter === "ALL") return true;

      return (
        String(trade.status || "").toUpperCase() ===
        journalFilter
      );
    }
  );

  const runningProfitById = (() => {
    let running = 0;
    const rows = [...trades]
      .reverse()
      .map((trade) => {
        if (
          String(trade.status || "").toUpperCase() !==
          "OPEN"
        ) {
          running += Number(trade.profit || 0);
        }

        return [trade.id, running];
      });

    return Object.fromEntries(rows);
  })();

  const startingBalance = Number(
    selectedAccountType === "demo"
      ? 10000
      : 0
  );

  const liveBalance =
    startingBalance + netProfit;

  const equityPoints = (() => {
    let running = startingBalance;

    return [...settledTrades]
      .reverse()
      .map((trade) => {
        running += Number(trade.profit || 0);

        return {
          id: trade.id,
          balance: running,
        };
      });
  })();

  const filteredAndSearchedTrades =
    filteredTrades.filter((trade) => {
      const query = journalSearch
        .trim()
        .toLowerCase();

      if (!query) return true;

      return [
        trade.symbol,
        trade.contract,
        trade.status,
        trade.recoveryMode
          ? `recovery ${trade.recoveryAttempt}`
          : "normal",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

  function exportTransactionsCsv() {
    const headers = [
      "Time",
      "Market",
      "Contract",
      "Mode",
      "Stake",
      "Status",
      "Trade P/L",
      "Running P/L",
    ];

    const rows = filteredAndSearchedTrades.map(
      (trade) => [
        new Date(trade.time).toISOString(),
        trade.symbol,
        trade.contract,
        trade.recoveryMode
          ? `RECOVERY ${trade.recoveryAttempt}/2`
          : "NORMAL",
        Number(trade.stake || 0).toFixed(2),
        String(trade.status || "").toUpperCase(),
        Number(trade.profit || 0).toFixed(2),
        Number(
          runningProfitById[trade.id] || 0
        ).toFixed(2),
      ]
    );

    const csv = [headers, ...rows]
      .map((row) =>
        row
          .map((cell) =>
            `"${String(cell).replaceAll('"', '""')}"`
          )
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = `over-under-transactions-${Date.now()}.csv`;
    anchor.click();

    URL.revokeObjectURL(url);
  }



  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent oulPage">
        <Topbar
          title="Over/Under Adaptive Learning Bot V19"
          subtitle="Universal candidate pool · rank #1 only · adaptive blacklist"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="oulToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket}
            onChange={(next) => {
              scanStartedAtRef.current =
                Date.now();
              confirmationRef.current = {
                key: "",
                ticks: 0,
              };
              void changeSymbol(next);
            }}
          />

          <div>
            <button
              type="button"
              className="oulReset"
              onClick={reset}
            >
              RESET SESSION
            </button>

            <button
              type="button"
              className={
                running
                  ? "oulStop"
                  : "oulStart"
              }
              disabled={tradeBusy}
              onClick={toggle}
            >
              {tradeBusy
                ? "SENDING..."
                : running
                ? "■ STOP"
                : "▶ START"}
            </button>
          </div>
        </section>

        <section
          className={`oulDecision ${
            confirmed ? "ready" : ""
          }`}
        >
          <div>
            <small>ADAPTIVE DECISION</small>
            <h1>
              {confirmed
                ? `BUY ${best.side} ${best.barrier}`
                : `WATCH ${best.side} ${best.barrier}`}
            </h1>
            <p>
              {predictiveGuardEnabled &&
              activeGuard.state === "BLOCK"
                ? `Predictive guard blocked this market at ${Number(
                    activeGuard.risk || 0
                  ).toFixed(1)} risk. Switching before another weak entry.`
                : recovery.active
                ? confirmed
                  ? "Fresh recovery setup passed stricter EV, confidence and confirmation gates."
                  : "Recovery is scanning all available markets. No trade will be forced without a clear setup."
                : universalPoolEnabled &&
                  !universalDecision.selected
                ? "UNIVERSAL POOL — No OVER or UNDER candidate passed every gate. Trade skipped."
                : marketRunLocked
                ? "ONE-RUN LIMIT — This market already traded. Switching to a different market."
                : setupRepeated
                ? "REPEATED SETUP — Waiting for fresh ticks or a new market."
                : sameBarrierRepeated
                ? `BARRIER LOCK — ${best.side} ${best.barrier} already used on this market. Switching.`
                : globalSelectionEnabled &&
                  !currentMarketDecision.qualified
                ? `NO QUALIFIED MARKET — TRADE SKIPPED. ${currentMarketDecision.reasons.join(
                    ", "
                  ) || "Current setup rejected."}`
                : multiLayerEnabled &&
                  Number(best.agreementVotes || 0) <
                    Number(minimumLayerAgreement || 5)
                ? `Only ${Number(
                    best.agreementVotes || 0
                  )}/7 analysis layers agree. Waiting or switching market.`
                : multiLayerEnabled &&
                  Number(
                    best.layered?.simulation
                      ?.expectedValue || -1
                  ) < Number(evFloor || 0.015)
                ? "Expected value is below the configured floor. Trade blocked."
                : blockedByLastLoss
                ? "This exact losing setup is blocked."
                : analysis.reason}
            </p>
          </div>

          <div className="oulDecisionGrid">
            <article>
              <span>Adaptive score</span>
              <strong>
                {pct(best.adaptiveScore)}
              </strong>
            </article>
            <article>
              <span>Confidence</span>
              <strong>
                {pct(analysis.confidence)}
              </strong>
            </article>
            <article>
              <span>Probability</span>
              <strong>
                {pct(best.probability)}
              </strong>
            </article>
            <article>
              <span>Memory adjustment</span>
              <strong>
                {best.learned.adjustment >= 0
                  ? "+"
                  : ""}
                {best.learned.adjustment.toFixed(
                  1
                )}
              </strong>
            </article>
            <article>
              <span>Break-even</span>
              <strong>
                {pct(best.learned.breakEven)}
              </strong>
            </article>
            <article>
              <span>Required probability</span>
              <strong>
                {pct(
                  best.learned.requiredProbability
                )}
              </strong>
            </article>
            <article>
              <span>Confirmations</span>
              <strong>
                {confirmationRef.current.ticks}/2
              </strong>
            </article>
            <article>
              <span>Market</span>
              <strong>
                {market?.label || symbol}
              </strong>
            </article>
            <article>
              <span>Recovery gate</span>
              <strong>
                {recovery.active
                  ? `Score ${recoveryScoreGate} · Conf ${recoveryConfidenceGate}`
                  : "NORMAL"}
              </strong>
            </article>
          </div>
        </section>

        <section className="oulControls">
          <label>
            <span>Stake</span>
            <input
              type="number"
              min="0.35"
              step="0.01"
              value={stake}
              onChange={(event) =>
                setStake(event.target.value)
              }
            />
          </label>

          <label>
            <span>Duration</span>
            <select
              value={durationTicks}
              onChange={(event) =>
                setDurationTicks(
                  event.target.value
                )
              }
            >
              <option value="1">1 TICK</option>
              <option value="2">2 TICKS</option>
              <option value="3">3 TICKS</option>
              <option value="5">5 TICKS</option>
            </select>
          </label>

          <label>
            <span>Minimum score</span>
            <input
              type="number"
              min="50"
              max="90"
              value={minimumScore}
              onChange={(event) =>
                setMinimumScore(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Minimum confidence</span>
            <input
              type="number"
              min="50"
              max="90"
              value={minimumConfidence}
              onChange={(event) =>
                setMinimumConfidence(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Switch after</span>
            <input
              type="number"
              min="5"
              max="30"
              value={switchSeconds}
              onChange={(event) =>
                setSwitchSeconds(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Max recovery stake</span>
            <input
              type="number"
              min="0.35"
              max="10"
              step="0.05"
              value={maximumRecoveryStake}
              onChange={(event) =>
                setMaximumRecoveryStake(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Universal candidate pool</span>
            <select
              value={
                universalPoolEnabled
                  ? "ON"
                  : "OFF"
              }
              onChange={(event) =>
                setUniversalPoolEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — rank OVER + UNDER together
              </option>
              <option value="OFF">
                OFF — balanced lane fallback
              </option>
            </select>
          </label>

          <label>
            <span>Universal minimum probability</span>
            <input
              type="number"
              min="70"
              max="99"
              step="1"
              value={universalMinimumProbability}
              onChange={(event) =>
                setUniversalMinimumProbability(
                  clamp(event.target.value, 70, 99)
                )
              }
            />
          </label>

          <label>
            <span>Universal minimum votes</span>
            <input
              type="number"
              min="3"
              max="7"
              step="1"
              value={universalMinimumVotes}
              onChange={(event) =>
                setUniversalMinimumVotes(
                  clamp(event.target.value, 3, 7)
                )
              }
            />
          </label>

          <label>
            <span>Universal maximum risk</span>
            <input
              type="number"
              min="5"
              max="80"
              step="1"
              value={universalMaximumRisk}
              onChange={(event) =>
                setUniversalMaximumRisk(
                  clamp(event.target.value, 5, 80)
                )
              }
            />
          </label>

          <label>
            <span>Setup blacklist seconds</span>
            <input
              type="number"
              min="20"
              max="600"
              step="10"
              value={setupBlacklistSeconds}
              onChange={(event) =>
                setSetupBlacklistSeconds(
                  clamp(event.target.value, 20, 600)
                )
              }
            />
          </label>

          <label>
            <span>Balanced OVER + UNDER</span>
            <select
              value={balancedSidesEnabled ? "ON" : "OFF"}
              onChange={(event) =>
                setBalancedSidesEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — compare both lanes
              </option>
              <option value="OFF">
                OFF — raw top candidate
              </option>
            </select>
          </label>

          <label>
            <span>Side preference</span>
            <select
              value={sidePreference}
              onChange={(event) =>
                setSidePreference(event.target.value)
              }
            >
              <option value="AUTO">
                AUTO — strongest lane
              </option>
              <option value="OVER">
                Slight OVER preference
              </option>
              <option value="UNDER">
                Slight UNDER preference
              </option>
            </select>
          </label>

          <label>
            <span>Minimum side score lead</span>
            <input
              type="number"
              min="0"
              max="10"
              step="0.5"
              value={minimumSideLead}
              onChange={(event) =>
                setMinimumSideLead(
                  clamp(event.target.value, 0, 10)
                )
              }
            />
          </label>

          <label>
            <span>Browser market memory</span>
            <select value="ON" disabled>
              <option value="ON">
                ON — persistent market cache
              </option>
            </select>
          </label>

          <label>
            <span>Cache freshness seconds</span>
            <input
              type="number"
              min="20"
              max="600"
              step="10"
              value={cacheFreshnessSeconds}
              onChange={(event) =>
                setCacheFreshnessSeconds(
                  clamp(event.target.value, 20, 600)
                )
              }
            />
          </label>

          <label>
            <span>Fast scan milliseconds</span>
            <input
              type="number"
              min="250"
              max="3000"
              step="50"
              value={fastScanMilliseconds}
              onChange={(event) =>
                setFastScanMilliseconds(
                  clamp(event.target.value, 250, 3000)
                )
              }
            />
          </label>

          <label>
            <span>Live ticks after switch</span>
            <input
              type="number"
              min="1"
              max="20"
              step="1"
              value={minimumLiveTicksAfterSwitch}
              onChange={(event) =>
                setMinimumLiveTicksAfterSwitch(
                  clamp(event.target.value, 1, 20)
                )
              }
            />
          </label>

          <label>
            <span>One run per market</span>
            <select
              value={oneRunPerMarket ? "ON" : "OFF"}
              onChange={(event) =>
                setOneRunPerMarket(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — switch after each trade
              </option>
              <option value="OFF">OFF</option>
            </select>
          </label>

          <label>
            <span>Rotate after settlement</span>
            <select
              value={
                rotateAfterEverySettlement
                  ? "ON"
                  : "OFF"
              }
              onChange={(event) =>
                setRotateAfterEverySettlement(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — win or loss
              </option>
              <option value="OFF">OFF</option>
            </select>
          </label>

          <label>
            <span>Fresh ticks before reuse</span>
            <input
              type="number"
              min="8"
              max="40"
              step="1"
              value={freshTicksRequired}
              onChange={(event) =>
                setFreshTicksRequired(
                  clamp(event.target.value, 8, 40)
                )
              }
            />
          </label>

          <label>
            <span>Global market selector</span>
            <select
              value={globalSelectionEnabled ? "ON" : "OFF"}
              onChange={(event) =>
                setGlobalSelectionEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — qualified market only
              </option>
              <option value="OFF">
                OFF — current market only
              </option>
            </select>
          </label>

          <label>
            <span>Minimum qualified probability</span>
            <input
              type="number"
              min="70"
              max="99"
              step="1"
              value={minimumQualifiedProbability}
              onChange={(event) =>
                setMinimumQualifiedProbability(
                  clamp(event.target.value, 70, 99)
                )
              }
            />
          </label>

          <label>
            <span>Minimum qualified layers</span>
            <input
              type="number"
              min="3"
              max="7"
              step="1"
              value={minimumQualifiedVotes}
              onChange={(event) =>
                setMinimumQualifiedVotes(
                  clamp(event.target.value, 3, 7)
                )
              }
            />
          </label>

          <label>
            <span>Maximum qualified risk</span>
            <input
              type="number"
              min="10"
              max="80"
              step="1"
              value={maximumQualifiedRisk}
              onChange={(event) =>
                setMaximumQualifiedRisk(
                  clamp(event.target.value, 10, 80)
                )
              }
            />
          </label>

          <label>
            <span>Adaptive protection</span>
            <select
              value={protectionEnabled ? "ON" : "OFF"}
              onChange={(event) =>
                setProtectionEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — pause loss cascades
              </option>
              <option value="OFF">OFF</option>
            </select>
          </label>

          <label>
            <span>Minimum recent win rate</span>
            <input
              type="number"
              min="45"
              max="80"
              step="1"
              value={minimumRecentWinRate}
              onChange={(event) =>
                setMinimumRecentWinRate(
                  clamp(event.target.value, 45, 80)
                )
              }
            />
          </label>

          <label>
            <span>Max consecutive losses</span>
            <input
              type="number"
              min="1"
              max="4"
              step="1"
              value={maximumLossCascade}
              onChange={(event) =>
                setMaximumLossCascade(
                  clamp(event.target.value, 1, 4)
                )
              }
            />
          </label>

          <label>
            <span>Protection pause seconds</span>
            <input
              type="number"
              min="8"
              max="60"
              step="1"
              value={protectionPauseSeconds}
              onChange={(event) =>
                setProtectionPauseSeconds(
                  clamp(event.target.value, 8, 60)
                )
              }
            />
          </label>

          <label>
            <span>Multi-layer engine</span>
            <select
              value={
                multiLayerEnabled
                  ? "ON"
                  : "OFF"
              }
              onChange={(event) =>
                setMultiLayerEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — Markov/Bayesian/EV
              </option>
              <option value="OFF">
                OFF — legacy score
              </option>
            </select>
          </label>

          <label>
            <span>Minimum layer votes</span>
            <input
              type="number"
              min="3"
              max="7"
              step="1"
              value={minimumLayerAgreement}
              onChange={(event) =>
                setMinimumLayerAgreement(
                  clamp(
                    event.target.value,
                    3,
                    7
                  )
                )
              }
            />
          </label>

          <label>
            <span>Minimum EV</span>
            <input
              type="number"
              min="-0.05"
              max="0.2"
              step="0.005"
              value={evFloor}
              onChange={(event) =>
                setEvFloor(
                  Number(
                    event.target.value || 0
                  )
                )
              }
            />
          </label>

          <label>
            <span>Base cooldown seconds</span>
            <input
              type="number"
              min="1"
              max="15"
              step="1"
              value={adaptiveCooldownSeconds}
              onChange={(event) =>
                setAdaptiveCooldownSeconds(
                  clamp(
                    event.target.value,
                    1,
                    15
                  )
                )
              }
            />
          </label>

          <label>
            <span>Predictive guard</span>
            <select
              value={predictiveGuardEnabled ? "ON" : "OFF"}
              onChange={(event) =>
                setPredictiveGuardEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">
                ON — avoid weakening setups
              </option>
              <option value="OFF">OFF</option>
            </select>
          </label>

          <label>
            <span>Guard risk threshold</span>
            <input
              type="number"
              min="40"
              max="80"
              step="1"
              value={guardThreshold}
              onChange={(event) =>
                setGuardThreshold(
                  clamp(event.target.value, 40, 80)
                )
              }
            />
          </label>

          <label>
            <span>Rotate after trades</span>
            <input
              type="number"
              min="2"
              max="12"
              step="1"
              value={proactiveRotationTrades}
              onChange={(event) =>
                setProactiveRotationTrades(
                  clamp(
                    event.target.value,
                    2,
                    12
                  )
                )
              }
            />
          </label>

          <label>
            <span>Recovery mode</span>
            <select
              value={recoveryMode}
              onChange={(event) =>
                setRecoveryMode(
                  event.target.value
                )
              }
            >
              <option value="SMART">
                SMART — clear setup only
              </option>
              <option value="OFF">
                OFF — base stake only
              </option>
            </select>
          </label>

          <label>
            <span>Recovery multiplier</span>
            <input
              type="number"
              min="1"
              max="2"
              step="0.1"
              value={recoveryMultiplier}
              onChange={(event) =>
                setRecoveryMultiplier(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Max recovery attempts</span>
            <input
              type="number"
              min="1"
              max="2"
              step="1"
              value={maximumRecoveryAttempts}
              onChange={(event) =>
                setMaximumRecoveryAttempts(
                  clamp(
                    event.target.value,
                    1,
                    2
                  )
                )
              }
            />
          </label>

          <label>
            <span>Real execution</span>
            <input
              type="checkbox"
              checked={allowReal}
              disabled={
                selectedAccountType === "demo"
              }
              onChange={(event) =>
                setAllowReal(
                  event.target.checked
                )
              }
            />
          </label>
        </section>

        <section className="oulSmartDashboard">
          <article className="balance">
            <span>Live balance</span>
            <strong>
              {liveBalance.toFixed(2)} USD
            </strong>
            <small>
              Start {startingBalance.toFixed(2)}
            </small>
          </article>

          <article>
            <span>Current market</span>
            <strong>
              {market?.label || symbol || "—"}
            </strong>
            <small>
              {running ? "SCANNING" : "STOPPED"}
            </small>
          </article>

          <article>
            <span>Current entry</span>
            <strong>
              {best.side !== "WAIT"
                ? `${best.side} ${best.barrier}`
                : "WAIT"}
            </strong>
            <small>
              Score {pct(best.adaptiveScore)}
            </small>
          </article>

          <article>
            <span>Recovery</span>
            <strong>
              {smartRecoveryActive
                ? `ACTIVE ${recovery.attempts}/${maximumRecoveryAttempts}`
                : "OFF"}
            </strong>
            <small>
              Target {recoveryTarget.toFixed(2)}
            </small>
          </article>

          <article>
            <span>Sound</span>
            <button
              type="button"
              className={
                soundEnabled ? "soundOn" : ""
              }
              onClick={async () => {
                if (soundEnabled) {
                  setSoundEnabled(false);
                  soundUnlockedRef.current = false;
                  return;
                }

                setSoundEnabled(true);

                window.setTimeout(async () => {
                  const unlocked =
                    await unlockSounds();

                  if (unlocked) {
                    playTradeSound("WON");
                  }
                }, 0);
              }}
            >
              {soundEnabled
                ? soundUnlockedRef.current
                  ? "🔊 SOUNDS READY"
                  : "🔊 CLICK START/TEST"
                : "🔇 SOUNDS OFF"}
            </button>
            <small>
              WIN/LOSS now trigger from settled journal status
            </small>
            <small className="oulLastSoundEvent">
              Last: {lastSoundEvent}
            </small>

            <div className="oulSoundTests">
              <button
                type="button"
                onClick={async () => {
                  await unlockSounds();
                  playTradeSound("WON");
                }}
              >
                TEST WIN
              </button>
              <button
                type="button"
                onClick={async () => {
                  await unlockSounds();
                  playTradeSound("LOST");
                }}
              >
                TEST LOSS
              </button>
            </div>
          </article>

          <article>
            <span>Next action</span>
            <strong>
              {hasOpenTrade
                ? "MONITORING"
                : universalPoolEnabled &&
                  !universalDecision.selected
                ? "UNIVERSAL SKIP"
                : globalSelectionEnabled &&
                  !currentMarketDecision.qualified
                ? "SKIP / SWITCH"
                : protectionActive
                ? "PROTECTED WAIT"
                : predictiveGuardEnabled &&
                  activeGuard.state === "BLOCK"
                ? "SWITCHING"
                : confirmed
                ? "ENTRY READY"
                : "SEARCHING"}
            </strong>
            <small>
              {confirmationRef.current.ticks}/2 confirms
            </small>
          </article>
        </section>

        <section className="oulMoneySummary">
          <article>
            <span>Total transactions</span>
            <strong>{settledTrades.length}</strong>
          </article>
          <article>
            <span>Open trades</span>
            <strong>{openTradeCount}</strong>
          </article>
          <article>
            <span>Total staked</span>
            <strong>
              {totalStaked.toFixed(2)} USD
            </strong>
          </article>
          <article className="positive">
            <span>Gross wins</span>
            <strong>
              +{grossWins.toFixed(2)} USD
            </strong>
          </article>
          <article className="negative">
            <span>Gross losses</span>
            <strong>
              -{grossLosses.toFixed(2)} USD
            </strong>
          </article>
          <article
            className={
              netProfit >= 0
                ? "positive"
                : "negative"
            }
          >
            <span>Net profit</span>
            <strong>
              {netProfit >= 0 ? "+" : "-"}
              {Math.abs(netProfit).toFixed(2)} USD
            </strong>
          </article>
          <article>
            <span>Win rate</span>
            <strong>{pct(winRate)}</strong>
          </article>
          <article>
            <span>Recovery</span>
            <strong>
              {recovery.active
                ? `${recovery.attempts}/2 · ${recoveryTarget.toFixed(
                    2
                  )} target`
                : "OFF"}
            </strong>
          </article>
        </section>

        <section className="oulEquityPanel">
          <header>
            <div>
              <small>ACCOUNT GROWTH</small>
              <h2>Live equity curve</h2>
            </div>
            <strong>
              {netProfit >= 0 ? "+" : "-"}
              {Math.abs(netProfit).toFixed(2)} USD
            </strong>
          </header>

          <div className="oulEquityChart">
            {equityPoints.length ? (
              <svg
                viewBox={`0 0 ${Math.max(
                  300,
                  equityPoints.length * 28
                )} 120`}
                preserveAspectRatio="none"
              >
                <polyline
                  points={equityPoints
                    .map((point, index) => {
                      const values =
                        equityPoints.map(
                          (item) => item.balance
                        );
                      const minimum =
                        Math.min(...values);
                      const maximum =
                        Math.max(...values);
                      const range =
                        Math.max(
                          0.01,
                          maximum - minimum
                        );

                      const x = index * 28;
                      const y =
                        105 -
                        ((point.balance - minimum) /
                          range) *
                          85;

                      return `${x},${y}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                />
              </svg>
            ) : (
              <p>
                Equity curve appears after settled trades.
              </p>
            )}
          </div>
        </section>


        <section className="oulAdvancedAnalysis">
          <header>
            <div>
              <small>MULTI-ANALYSIS ENGINE</small>
              <h2>
                Market regime and entry quality
              </h2>
            </div>
            <strong>
              {regimeAnalysis.regime}
            </strong>
          </header>

          <div>
            <article>
              <span>Entropy</span>
              <strong>
                {pct(regimeAnalysis.entropy)}
              </strong>
              <small>
                Randomness of recent digits
              </small>
            </article>

            <article>
              <span>Concentration</span>
              <strong>
                {pct(
                  regimeAnalysis.concentration
                )}
              </strong>
              <small>
                Dominant digit pressure
              </small>
            </article>

            <article>
              <span>Persistence</span>
              <strong>
                {pct(
                  regimeAnalysis.persistence
                )}
              </strong>
              <small>
                Repeat-digit behaviour
              </small>
            </article>

            <article>
              <span>Transition quality</span>
              <strong>
                {pct(
                  regimeAnalysis.transitionQuality
                )}
              </strong>
              <small>
                Stability between ticks
              </small>
            </article>

            <article>
              <span>Low / high digits</span>
              <strong>
                {pct(regimeAnalysis.lowShare)}
                {" / "}
                {pct(regimeAnalysis.highShare)}
              </strong>
              <small>
                Current distribution balance
              </small>
            </article>

            <article>
              <span>Risk penalty</span>
              <strong>
                {regimeAnalysis.riskPenalty}
              </strong>
              <small>
                Lower is safer
              </small>
            </article>

            <article>
              <span>Best safety</span>
              <strong>
                {pct(best.safetyScore)}
              </strong>
              <small>
                Barrier theoretical coverage
              </small>
            </article>

            <article>
              <span>Universal Rank #1</span>
              <strong>
                {universalDecision.selected
                  ? `${universalDecision.selected.side} ${universalDecision.selected.barrier}`
                  : "SKIP"}
              </strong>
              <small>
                {universalDecision.selectedMeta
                  ? `P ${pct(
                      universalDecision.selectedMeta.probability
                    )} · EV ${Number(
                      universalDecision.selectedMeta.expectedValue
                    ).toFixed(3)}`
                  : "No candidate passed all gates"}
              </small>
            </article>

            <article>
              <span>Rejected top setup</span>
              <strong>
                {universalDecision.rejectedTop
                  ? `${universalDecision.rejectedTop.candidate.side} ${universalDecision.rejectedTop.candidate.barrier}`
                  : "NONE"}
              </strong>
              <small>
                {universalDecision.rejectedTop
                  ? `Risk ${pct(
                      universalDecision.rejectedTop.risk
                    )} · Votes ${universalDecision.rejectedTop.votes}/7`
                  : "No candidates available"}
              </small>
            </article>

            <article>
              <span>Universal pool size</span>
              <strong>
                {universalDecision.ranked.length}
              </strong>
              <small>
                OVER and UNDER ranked together
              </small>
            </article>

            <article>
              <span>Setup blacklist</span>
              <strong>
                {Object.values(
                  dynamicSetupBlacklist?.[symbol] || {}
                ).filter(
                  (until) =>
                    Number(until || 0) >
                    Date.now()
                ).length}
              </strong>
              <small>
                Repeated losing setups blocked
              </small>
            </article>

            <article>
              <span>Best OVER lane</span>
              <strong>
                {bestOver
                  ? `OVER ${bestOver.barrier}`
                  : "NONE"}
              </strong>
              <small>
                {bestOver
                  ? `${pct(
                      bestOver.layered?.weightedProbability ??
                        bestOver.probability
                    )} · ${bestOver.agreementVotes}/7`
                  : "No qualified OVER candidate"}
              </small>
            </article>

            <article>
              <span>Best UNDER lane</span>
              <strong>
                {bestUnder
                  ? `UNDER ${bestUnder.barrier}`
                  : "NONE"}
              </strong>
              <small>
                {bestUnder
                  ? `${pct(
                      bestUnder.layered?.weightedProbability ??
                        bestUnder.probability
                    )} · ${bestUnder.agreementVotes}/7`
                  : "No qualified UNDER candidate"}
              </small>
            </article>

            <article>
              <span>Selected lane</span>
              <strong>{balancedDecision.side}</strong>
              <small>{balancedDecision.reason}</small>
            </article>

            <article>
              <span>OVER / UNDER score</span>
              <strong>
                {Number(
                  balancedDecision.overScore || 0
                ).toFixed(1)}
                {" / "}
                {Number(
                  balancedDecision.underScore || 0
                ).toFixed(1)}
              </strong>
              <small>
                Higher qualified lane is selected
              </small>
            </article>

            <article>
              <span>Engine version</span>
              <strong>V17</strong>
              <small>
                Browser intelligence active
              </small>
            </article>

            <article>
              <span>Browser cache</span>
              <strong>
                {cachedMarketUsable ? "WARM" : "FRESH"}
              </strong>
              <small>
                {cachedMarketUsable
                  ? `${Math.floor(
                      (
                        Date.now() -
                        Number(cachedMarketRow?.updatedAt || 0)
                      ) / 1000
                    )}s old`
                  : "Building market memory"}
              </small>
            </article>

            <article>
              <span>Warm market data</span>
              <strong>{effectivePrices.length}</strong>
              <small>
                Cached + live price points
              </small>
            </article>

            <article>
              <span>Live confirmation</span>
              <strong>
                {liveTicksAfterSwitch}/
                {minimumLiveTicksAfterSwitch}
              </strong>
              <small>
                Prevents stale-cache execution
              </small>
            </article>

            <article>
              <span>Market warm state</span>
              <strong>
                {marketWarmReady ? "READY" : "WARMING"}
              </strong>
              <small>
                Analysis remains available during switches
              </small>
            </article>

            <article>
              <span>Market run rule</span>
              <strong>
                {marketRunLocked
                  ? "LOCKED"
                  : "AVAILABLE"}
              </strong>
              <small>
                {marketRunLocked
                  ? "Already traded once; switch required"
                  : "No trade used on this market"}
              </small>
            </article>

            <article>
              <span>Fresh setup</span>
              <strong>
                {setupRepeated
                  ? "REPEATED"
                  : "FRESH"}
              </strong>
              <small>
                Exact market/barrier pattern lock
              </small>
            </article>

            <article>
              <span>Global decision</span>
              <strong>
                {currentMarketDecision.qualified
                  ? "QUALIFIED"
                  : "SKIP"}
              </strong>
              <small>
                {currentMarketDecision.qualified
                  ? `${symbol} selected`
                  : lastSkipReason || "No qualified setup"}
              </small>
            </article>

            <article>
              <span>Selected market</span>
              <strong>
                {selectedGlobalSetup?.market || "NONE"}
              </strong>
              <small>
                {selectedGlobalSetup?.contract ||
                  "Scanning every market"}
              </small>
            </article>

            <article>
              <span>Qualified probability</span>
              <strong>
                {pct(
                  currentMarketDecision.probability
                )}
              </strong>
              <small>
                Required {pct(
                  minimumQualifiedProbability
                )}
              </small>
            </article>

            <article>
              <span>Qualified EV / risk</span>
              <strong>
                {Number(
                  currentMarketDecision.expectedValue || 0
                ) >= 0
                  ? "+"
                  : ""}
                {Number(
                  currentMarketDecision.expectedValue || 0
                ).toFixed(3)}
                {" / "}
                {pct(currentMarketDecision.risk)}
              </strong>
              <small>
                Layers {currentMarketDecision.votes}/7
              </small>
            </article>

            <article>
              <span>Protection mode</span>
              <strong>
                {protectionActive
                  ? "PAUSED"
                  : "READY"}
              </strong>
              <small>
                {protectionActive
                  ? `${Math.ceil(
                      Math.max(
                        0,
                        Number(protectionUntil || 0) -
                          Date.now()
                      ) / 1000
                    )}s remaining`
                  : "Entries allowed after all gates"}
              </small>
            </article>

            <article>
              <span>Recent session</span>
              <strong>
                {pct(protectionStats.winRate)}
              </strong>
              <small>
                {protectionStats.wins}W / {protectionStats.losses}L · {protectionStats.sample} trades
              </small>
            </article>

            <article>
              <span>Loss cascade</span>
              <strong>
                {protectionStats.lossStreak}/
                {maximumLossCascade}
              </strong>
              <small>
                Protection triggers at the limit
              </small>
            </article>

            <article>
              <span>Recent net P/L</span>
              <strong>
                {Number(protectionStats.netProfit || 0) >= 0
                  ? "+"
                  : ""}
                {Number(
                  protectionStats.netProfit || 0
                ).toFixed(2)}
              </strong>
              <small>
                Last {protectionStats.sample} settled trades
              </small>
            </article>

            <article>
              <span>Layer agreement</span>
              <strong>
                {best.agreementVotes || 0}/7
              </strong>
              <small>
                Frequency, Markov, Bayesian, EV
              </small>
            </article>

            <article>
              <span>Bayesian probability</span>
              <strong>
                {pct(
                  best.layered
                    ?.bayesianPosterior || 0
                )}
              </strong>
              <small>
                Prior + observed market data
              </small>
            </article>

            <article>
              <span>Markov transition</span>
              <strong>
                {pct(
                  best.layered
                    ?.transitionProbability || 0
                )}
              </strong>
              <small>
                Next-digit transition support
              </small>
            </article>

            <article>
              <span>EV simulation</span>
              <strong>
                {Number(
                  best.layered
                    ?.simulation
                    ?.expectedValue || 0
                ) >= 0
                  ? "+"
                  : ""}
                {Number(
                  best.layered
                    ?.simulation
                    ?.expectedValue || 0
                ).toFixed(3)}
              </strong>
              <small>
                1,000-trial mathematical estimate
              </small>
            </article>

            <article>
              <span>Observed cycle</span>
              <strong>
                {observedCycle.length || "—"}
              </strong>
              <small>
                Strength {pct(
                  observedCycle.strength
                )}
              </small>
            </article>

            <article>
              <span>Mean reversion</span>
              <strong>
                {meanReversion.direction}
              </strong>
              <small>
                {pct(
                  meanReversion.probability
                )} probability
              </small>
            </article>

            <article>
              <span>Hot / cold digit</span>
              <strong>
                {multiWindowFrequency.short.hottestDigit}
                {" / "}
                {multiWindowFrequency.short.coldestDigit}
              </strong>
              <small>
                Last {multiWindowFrequency.short.size} ticks
              </small>
            </article>

            <article>
              <span>Weighted probability</span>
              <strong>
                {pct(
                  best.layered
                    ?.weightedProbability || 0
                )}
              </strong>
              <small>
                Combined layer output
              </small>
            </article>

            <article>
              <span>Predictive guard</span>
              <strong>{activeGuard.state}</strong>
              <small>
                Risk {pct(activeGuard.risk)}
              </small>
            </article>

            <article>
              <span>Confidence decay</span>
              <strong>{pct(resultRisk.decay)}</strong>
              <small>
                Recent performance weakening
              </small>
            </article>

            <article>
              <span>Current loss rate</span>
              <strong>{pct(resultRisk.lossRate)}</strong>
              <small>
                Last {resultRisk.sample} settled trades
              </small>
            </article>

            <article>
              <span>Streak condition</span>
              <strong>
                W{resultRisk.winStreak} / L{resultRisk.lossStreak}
              </strong>
              <small>
                Long win streaks can signal exhaustion
              </small>
            </article>

            <article>
              <span>Active barrier lane</span>
              <strong>
                {smartRecoveryActive
                  ? "REC: OVER 4 / UNDER 5"
                  : "NORMAL: OVER 1–3 / UNDER 6–8"}
              </strong>
              <small>
                Other barriers need stronger EV
              </small>
            </article>

            <article>
              <span>Trades this market</span>
              <strong>
                {tradesOnCurrentMarket}/
                {proactiveRotationTrades}
              </strong>
              <small>
                Rotates before waiting for a loss
              </small>
            </article>

            <article>
              <span>EV margin</span>
              <strong>
                {best.payoutEdge >= 0 ? "+" : ""}
                {pct(best.payoutEdge)}
              </strong>
              <small>
                Probability above break-even
              </small>
            </article>
          </div>
        </section>

        <section className="oulGlobalSelector">
          <header>
            <div>
              <small>GLOBAL MARKET SELECTOR</small>
              <h2>
                Best qualified setup across markets
              </h2>
            </div>
            <strong>
              {selectedGlobalSetup
                ? "TRADE READY"
                : "SKIP / SCANNING"}
            </strong>
          </header>

          <div className="oulGlobalScoreGrid">
            {marketSymbols.map((market) => {
              const item =
                globalMarketScores[market];

              return (
                <article
                  key={market}
                  className={
                    item?.qualified
                      ? "qualified"
                      : ""
                  }
                >
                  <strong>{market}</strong>
                  <span>
                    {item?.contract || "SCANNING"}
                  </span>
                  <small>
                    P {pct(item?.probability || 0)}
                    {" · "}
                    EV {Number(
                      item?.expectedValue || 0
                    ).toFixed(3)}
                    {" · "}
                    L {item?.votes || 0}/7
                  </small>
                  <small>
                    {item?.cached ? "CACHE · " : "LIVE · "}
                    {item?.qualified
                      ? "QUALIFIED"
                      : item?.reasons?.join(", ") ||
                        "WAITING"}
                  </small>
                </article>
              );
            })}
          </div>

          {!selectedGlobalSetup && (
            <div className="oulSkipBanner">
              NO QUALIFIED MARKET — TRADE SKIPPED
            </div>
          )}
        </section>

        <section className="oulRotation">
          <header>
            <div>
              <small>SMART MARKET ROTATION</small>
              <h2>
                Recovery searches every clear market
              </h2>
            </div>
            <strong>
              {recovery.active
                ? "RECOVERY SCAN"
                : "NORMAL SCAN"}
            </strong>
          </header>

          <div>
            {marketSymbols.slice(0, 12).map(
              (item) => {
                const remaining =
                  marketBlockRemaining(
                    marketBlocks,
                    item
                  );

                return (
                  <article
                    key={item}
                    className={
                      item === symbol
                        ? "active"
                        : remaining > 0
                        ? "blocked"
                        : ""
                    }
                  >
                    <strong>{item}</strong>
                    <span>
                      {item === symbol
                        ? "CURRENT"
                        : remaining > 0
                        ? `BLOCKED ${Math.ceil(
                            remaining / 1000
                          )}s`
                        : "AVAILABLE"}
                    </span>
                  </article>
                );
              }
            )}
          </div>
        </section>

        <section className="oulMainGrid">
          <article className="oulPanel">
            <header>
              <div>
                <small>LIVE DIGIT FLOW</small>
                <h2>
                  Continues while trades are open
                </h2>
              </div>
              <strong>{analysis.total} ticks</strong>
            </header>

            <div className="oulDigits">
              {analysis.recentDigits
                .slice(-30)
                .map((digit, index) => (
                  <span
                    key={`${digit}-${index}`}
                  >
                    {digit}
                  </span>
                ))}
            </div>
          </article>

          <article className="oulPanel">
            <header>
              <div>
                <small>TOP CANDIDATES</small>
                <h2>
                  Live + learned ranking
                </h2>
              </div>
            </header>

            <div className="oulLaneSummary">
              <article className={
                best.side === "OVER"
                  ? "selected"
                  : ""
              }>
                <small>BEST OVER</small>
                <strong>
                  {bestOver
                    ? `OVER ${bestOver.barrier}`
                    : "NONE"}
                </strong>
                <span>
                  {bestOver
                    ? pct(
                        bestOver.layered?.weightedProbability ??
                          bestOver.probability
                      )
                    : "WAIT"}
                </span>
              </article>

              <article className={
                best.side === "UNDER"
                  ? "selected"
                  : ""
              }>
                <small>BEST UNDER</small>
                <strong>
                  {bestUnder
                    ? `UNDER ${bestUnder.barrier}`
                    : "NONE"}
                </strong>
                <span>
                  {bestUnder
                    ? pct(
                        bestUnder.layered?.weightedProbability ??
                          bestUnder.probability
                      )
                    : "WAIT"}
                </span>
              </article>
            </div>

            <div className="oulUniversalRanking">
              {universalDecision.ranked
                .slice(0, 8)
                .map((item, index) => (
                  <article
                    key={`${item.setupKey}-${index}`}
                    className={
                      item.qualified
                        ? "qualified"
                        : item.blocked
                        ? "blocked"
                        : ""
                    }
                  >
                    <small>RANK #{index + 1}</small>
                    <strong>
                      {item.candidate.side}{" "}
                      {item.candidate.barrier}
                    </strong>
                    <span>
                      P {pct(item.probability)}
                      {" · "}
                      EV {Number(
                        item.expectedValue
                      ).toFixed(3)}
                    </span>
                    <span>
                      V {item.votes}/7
                      {" · "}
                      R {pct(item.risk)}
                    </span>
                    <em>
                      {item.blocked
                        ? "BLACKLISTED"
                        : item.qualified
                        ? "QUALIFIED"
                        : "REJECTED"}
                    </em>
                  </article>
                ))}
            </div>

            <div className="oulCandidates">
              {rankedCandidates
                .slice(0, 8)
                .map((candidate) => (
                  <div
                    key={`${candidate.side}-${candidate.barrier}`}
                  >
                    <strong>
                      {candidate.side}{" "}
                      {candidate.barrier}
                    </strong>
                    <span>
                      Score{" "}
                      {pct(
                        candidate.adaptiveScore
                      )}
                    </span>
                    <span>
                      Memory{" "}
                      {candidate.learned.trades}T ·{" "}
                      {pct(
                        candidate.learned
                          .probability * 100
                      )}
                    </span>
                    <span>
                      Need{" "}
                      {pct(
                        candidate.learned
                          .requiredProbability
                      )} ·{" "}
                      {candidate.learned.blocked
                        ? "COOLDOWN"
                        : "EV PASS"}
                    </span>
                    <span>
                      Recent{" "}
                      {pct(
                        candidate.learned.recentWinRate
                      )} · roll{" "}
                      {pct(
                        candidate.learned.rollingScore
                      )}
                    </span>
                  </div>
                ))}
            </div>
          </article>
        </section>

        <section className="oulTransactionPanel">
          <header className="oulTransactionHeader">
            <div>
              <small>TRANSACTION MONITOR</small>
              <h2>
                Profit, losses and settled trades
              </h2>
            </div>

            <div className="oulJournalTools">
              <input
                type="search"
                placeholder="Search market or contract"
                value={journalSearch}
                onChange={(event) =>
                  setJournalSearch(
                    event.target.value
                  )
                }
              />

              <button
                type="button"
                onClick={exportTransactionsCsv}
              >
                EXPORT CSV
              </button>

              <div className="oulJournalFilters">
              {["ALL", "WON", "LOST", "OPEN"].map(
                (filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={
                      journalFilter === filter
                        ? "active"
                        : ""
                    }
                    onClick={() =>
                      setJournalFilter(filter)
                    }
                  >
                    {filter}
                  </button>
                )
              )}
              </div>
            </div>
          </header>

          <div className="oulTransactionScroll">
            <div className="oulTransactionHead">
              <span>Time</span>
              <span>Market</span>
              <span>Contract</span>
              <span>Mode</span>
              <span>Stake</span>
              <span>Status</span>
              <span>Trade P/L</span>
              <span>Running P/L</span>
            </div>

            {filteredAndSearchedTrades.map((trade) => {
              const status = String(
                trade.status || ""
              ).toUpperCase();
              const isExpanded =
                expandedTradeId === trade.id;
              const runningProfit =
                Number(
                  runningProfitById[trade.id] || 0
                );

              return (
                <article
                  key={trade.id}
                  className={`oulTransactionRow ${status.toLowerCase()}`}
                >
                  <button
                    type="button"
                    className="oulTransactionMain"
                    onClick={() =>
                      setExpandedTradeId(
                        isExpanded ? "" : trade.id
                      )
                    }
                  >
                    <span>
                      {new Date(
                        trade.time
                      ).toLocaleTimeString()}
                    </span>
                    <strong>{trade.symbol}</strong>
                    <strong>{trade.contract}</strong>
                    <span>
                      {trade.recoveryMode
                        ? `RECOVERY ${
                            trade.recoveryAttempt
                          }/2`
                        : "NORMAL"}
                    </span>
                    <span>
                      {Number(
                        trade.stake || 0
                      ).toFixed(2)}
                    </span>
                    <b>{status}</b>
                    <b>
                      {status === "OPEN"
                        ? "0.00"
                        : `${
                            Number(
                              trade.profit || 0
                            ) >= 0
                              ? "+"
                              : "-"
                          }${Math.abs(
                            Number(
                              trade.profit || 0
                            )
                          ).toFixed(2)}`}
                    </b>
                    <b>
                      {runningProfit >= 0 ? "+" : "-"}
                      {Math.abs(
                        runningProfit
                      ).toFixed(2)}
                    </b>
                  </button>

                  {isExpanded ? (
                    <div className="oulTransactionDetails">
                      <div>
                        <small>WHY ENTERED</small>
                        <p>
                          Adaptive score{" "}
                          {pct(trade.score)} ·
                          confidence{" "}
                          {pct(trade.confidence)} ·
                          probability{" "}
                          {pct(trade.probability)}.
                        </p>
                      </div>
                      <div>
                        <small>MEMORY</small>
                        <p>
                          Setup had{" "}
                          {trade.learnedTrades || 0}{" "}
                          learned trades when opened.
                        </p>
                      </div>
                      <div>
                        <small>RESULT</small>
                        <p>
                          {status === "OPEN"
                            ? "Trade is still open. Live market reading continues."
                            : status === "WON"
                            ? `Won ${Number(
                                trade.profit || 0
                              ).toFixed(2)} USD · WIN sound triggered from journal settlement.`
                            : `Lost ${Math.abs(
                                Number(
                                  trade.profit || 0
                                )
                              ).toFixed(2)} USD · LOSS sound triggered from journal settlement.`}
                        </p>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}

            {!filteredAndSearchedTrades.length ? (
              <div className="oulNoTransactions">
                No {journalFilter.toLowerCase()} transactions.
              </div>
            ) : null}
          </div>
        </section>

        <div className="oulMessage">
          {message || tradeError}
        </div>

        <div className="oulDisclaimer">
          Analysis and learning are probabilistic.
          Demo-test before enabling Real execution.
          No fixed win rate or profit is guaranteed.
        </div>
      </main>
    </div>
  );
}
