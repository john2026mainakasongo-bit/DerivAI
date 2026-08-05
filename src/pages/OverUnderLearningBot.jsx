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

const MEMORY_KEY = "edgepilot:over-under-learning:v12";

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

  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const nextEntryAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const lastSwitchAtRef = useRef(0);
  const switchBusyRef = useRef(false);
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
    if (
      !connected &&
      typeof connect === "function"
    ) {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  const analysis = useMemo(
    () =>
      safeAnalysis(
        analyzeOverUnder(prices)
      ),
    [prices]
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

  const best =
    rankedCandidates[0] || {
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

  const bestKey = memoryKey(
    symbol,
    best.side,
    best.barrier
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

      if (
        candidate &&
        candidate !== symbol &&
        marketBlockRemaining(
          marketBlocks,
          candidate
        ) <= 0
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
    confirmationRef.current = {
      key: "",
      ticks: 0,
    };

    setMessage(
      `Switching ${symbol} → ${next} · ${reason}`
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
      }, 900);
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
      running &&
      confirmed &&
      !hasOpenTrade
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

    const result =
      settled.status === "WON"
        ? "WON"
        : "LOST";

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

  function reset() {
    setTrades([]);
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
          title="Over/Under Adaptive Learning Bot V12.3"
          subtitle="V12.3 syntax-clean · Markov · Bayesian · EV"
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
