import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeQuantumRiseFall } from "../analysis/quantumRiseFallEngine";
import "../styles/QuantumAIBot.css";

const INITIAL_STATS = {
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  history: [],
};

function money(value) {
  return Number(value || 0).toFixed(2);
}

function contractIdOf(value) {
  return String(
    value?.contractId ||
      value?.contract_id ||
      value?.buy?.contract_id ||
      value?.raw?.buy?.contract_id ||
      value?.raw?.data?.buy?.contract_id ||
      value?.proposal_open_contract?.contract_id ||
      value?.data?.contract_id ||
      value?.data?.contractId ||
      value?.id ||
      ""
  );
}

function settled(contract) {
  const status = String(
    contract?.status ||
      contract?.contract_status ||
      contract?.action ||
      ""
  ).toLowerCase();

  return Boolean(
    contract?.is_sold ||
      contract?.is_expired ||
      contract?.is_settleable === false ||
      ["won", "lost", "sold", "expired", "settled"].includes(status)
  );
}

function recoveryStakeAmount(baseStake, recovery) {
  const base = Math.max(0.35, Number(baseStake || 0.35));
  const attempts = Math.max(
    0,
    Math.min(2, Number(recovery?.attempts || 0))
  );

  // Attempt 0 = base stake, attempt 1 = 2x, attempt 2 = 4x.
  return Number((base * 2 ** attempts).toFixed(2));
}

function contractProfit(contract) {
  const candidates = [
    contract?.profit,
    contract?.profit_loss,
    contract?.pnl,
    contract?.data?.profit,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }

  const payout = Number(
    contract?.payout ??
      contract?.sell_price ??
      contract?.sellPrice ??
      0
  );

  const buy = Number(
    contract?.buy_price ??
      contract?.purchase_price ??
      contract?.buyPrice ??
      0
  );

  return payout - buy;
}


const QUANTUM_LEARNING_KEY = "quantumAiV12MarketLearning";

function clampNumber(value, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function readLearningModel() {
  try {
    const saved = window.localStorage.getItem(QUANTUM_LEARNING_KEY);
    if (!saved) return { totalTrades: 0, markets: {} };

    const parsed = JSON.parse(saved);

    return {
      totalTrades: Number(parsed?.totalTrades || 0),
      markets:
        parsed?.markets && typeof parsed.markets === "object"
          ? parsed.markets
          : {},
      recent: Array.isArray(parsed?.recent)
        ? parsed.recent.slice(-500)
        : [],
    };
  } catch {
    return {
      totalTrades: 0,
      markets: {},
      recent: [],
    };
  }
}

function learningKey(symbol, direction) {
  return `${String(symbol || "UNKNOWN")}|${String(
    direction || "WAIT"
  ).toUpperCase()}`;
}

function classifyTradeOutcome(trade, result) {
  const snapshot = trade?.entrySnapshot || {};
  const noise = Number(snapshot.noiseScore || 0);
  const reversal = Number(snapshot.reversalRisk || 0);
  const consensus = Number(snapshot.voteConsensus || 0);
  const consistency = Number(snapshot.consistency || 0);
  const trendStrength = Number(snapshot.trendStrength || 0);
  const transition = Number(snapshot.transition || 0);
  const confidence = Number(trade?.confidence || 0);

  if (result === "WON") {
    if (consensus >= 72 && trendStrength >= 65) {
      return {
        code: "STRONG_ALIGNMENT",
        label: "Strong votes and trend alignment held through expiry.",
      };
    }

    if (transition >= 62 && consistency >= 45) {
      return {
        code: "CLEAN_CONTINUATION",
        label: "Continuation and consistency supported the selected side.",
      };
    }

    return {
      code: "TIMING_HELD",
      label: "The selected direction remained valid until expiry.",
    };
  }

  if (noise >= 70) {
    return {
      code: "HIGH_NOISE",
      label: "Market noise was too high around the entry.",
    };
  }

  if (reversal >= 65) {
    return {
      code: "REVERSAL_RISK",
      label: "The move reversed before the contract expired.",
    };
  }

  if (consensus < 58) {
    return {
      code: "WEAK_VOTE",
      label: "The AI agents did not agree strongly enough.",
    };
  }

  if (consistency < 35) {
    return {
      code: "LOW_CONSISTENCY",
      label: "Short and full-timeframe direction did not remain consistent.",
    };
  }

  if (transition < 55) {
    return {
      code: "WEAK_TRANSITION",
      label: "Continuation probability was marginal at entry.",
    };
  }

  if (trendStrength < 50) {
    return {
      code: "WEAK_TREND",
      label: "Trend strength was insufficient for the selected duration.",
    };
  }

  if (confidence < 75) {
    return {
      code: "LOW_ENTRY_CONFIDENCE",
      label: "Entry confidence did not provide enough safety margin.",
    };
  }

  return {
    code: "EXPIRY_VARIANCE",
    label: "A qualified setup lost to short-term expiry movement.",
  };
}

function marketLearningStats(model, symbol, direction) {
  const key = learningKey(symbol, direction);
  const row = model?.markets?.[key] || {};

  const trades = Number(row.trades || 0);
  const wins = Number(row.wins || 0);
  const losses = Number(row.losses || 0);

  const rows = (Array.isArray(model?.recent)
    ? model.recent
    : []
  ).filter((item) => item.key === key);

  const rateFor = (count) => {
    const sample = rows.slice(-count);
    const sampleWins = sample.filter(
      (item) => item.result === "WON"
    ).length;

    // Bayesian smoothing: two virtual wins and two virtual losses.
    return (sampleWins + 2) / (sample.length + 4);
  };

  const recent10 = rateFor(10);
  const recent30 = rateFor(30);
  const recent100 = rateFor(100);
  const lifetime = (wins + 2) / (trades + 4);

  const weightedWinRate =
    recent10 * 0.50 +
    recent30 * 0.30 +
    recent100 * 0.15 +
    lifetime * 0.05;

  const adjustment =
    trades >= 3
      ? clampNumber(
          (weightedWinRate - 0.5) * 26,
          -7,
          7
        )
      : 0;

  return {
    trades,
    wins,
    losses,
    smoothedWinRate: weightedWinRate,
    recent10,
    recent30,
    recent100,
    lifetime,
    adjustment,
    lastCause: row.lastCause || null,
  };
}


function setupVector(analysis = {}) {
  const metrics = analysis.metrics || {};

  return {
    direction: String(
      analysis.candidate || analysis.decision || "WAIT"
    ).toUpperCase(),
    confidence: clampNumber(
      Number(analysis.confidence || 0),
      0,
      100
    ),
    noise: clampNumber(
      Number(analysis.noiseScore || 0),
      0,
      100
    ),
    reversal: clampNumber(
      Number(analysis.reversalRisk || 0),
      0,
      100
    ),
    votes: clampNumber(
      Number(metrics.voteConsensus || 0),
      0,
      100
    ),
    transition: clampNumber(
      Number(metrics.transition || 0),
      0,
      100
    ),
    trendStrength: clampNumber(
      Number(metrics.trendStrength || 0),
      0,
      100
    ),
    consistency: clampNumber(
      Number(analysis.consistency || 0),
      0,
      100
    ),
    entropy: clampNumber(
      Number(metrics.entropy || 0),
      0,
      100
    ),
    impulse: clampNumber(
      Number(metrics.impulse || 0),
      -100,
      100
    ),
    rsi: clampNumber(
      Number(metrics.rsi || 50),
      0,
      100
    ),
    regime: String(analysis.regime || "UNKNOWN"),
    trend: String(analysis.trend || "UNKNOWN"),
    momentum: String(analysis.momentum || "UNKNOWN"),
  };
}

function setupSimilarity(current, previous) {
  if (!current || !previous) return 0;

  let score = 0;
  let weight = 0;

  const numeric = [
    ["confidence", 0.08],
    ["noise", 0.12],
    ["reversal", 0.13],
    ["votes", 0.15],
    ["transition", 0.15],
    ["trendStrength", 0.13],
    ["consistency", 0.10],
    ["entropy", 0.06],
    ["rsi", 0.04],
  ];

  for (const [key, itemWeight] of numeric) {
    const difference = Math.abs(
      Number(current[key] || 0) -
      Number(previous[key] || 0)
    );

    score +=
      Math.max(0, 1 - difference / 100) *
      itemWeight;
    weight += itemWeight;
  }

  const categorical = [
    ["direction", 0.08],
    ["regime", 0.03],
    ["trend", 0.02],
    ["momentum", 0.01],
  ];

  for (const [key, itemWeight] of categorical) {
    score +=
      String(current[key]) === String(previous[key])
        ? itemWeight
        : 0;
    weight += itemWeight;
  }

  return weight > 0
    ? clampNumber((score / weight) * 100, 0, 100)
    : 0;
}

function similarSetupStats(model, vector, symbol) {
  const rows = Array.isArray(model?.recent)
    ? model.recent
    : [];

  const candidates = rows
    .filter(
      (item) =>
        item?.entryVector &&
        (
          item.symbol === symbol ||
          item.direction === vector.direction
        )
    )
    .map((item) => ({
      ...item,
      similarity: setupSimilarity(
        vector,
        item.entryVector
      ),
    }))
    .filter((item) => item.similarity >= 65)
    .sort(
      (a, b) =>
        Number(b.similarity) -
        Number(a.similarity)
    )
    .slice(0, 40);

  const weightedWins = candidates.reduce(
    (sum, item) =>
      sum +
      (item.result === "WON"
        ? Number(item.similarity || 0)
        : 0),
    0
  );

  const totalWeight = candidates.reduce(
    (sum, item) =>
      sum + Number(item.similarity || 0),
    0
  );

  const probability =
    totalWeight > 0
      ? (weightedWins + 200) /
        (totalWeight + 400)
      : 0.5;

  const averageSimilarity = candidates.length
    ? candidates.reduce(
        (sum, item) =>
          sum + Number(item.similarity || 0),
        0
      ) / candidates.length
    : 0;

  return {
    samples: candidates.length,
    wins: candidates.filter(
      (item) => item.result === "WON"
    ).length,
    losses: candidates.filter(
      (item) => item.result === "LOST"
    ).length,
    probability,
    averageSimilarity,
  };
}

function marketDirectionProbability(
  model,
  symbol,
  direction
) {
  const row =
    model?.markets?.[
      learningKey(symbol, direction)
    ] || {};

  const trades = Number(row.trades || 0);
  const wins = Number(row.wins || 0);

  return {
    trades,
    probability: (wins + 3) / (trades + 6),
  };
}

export default function QuantumAIBot() {
  const {
    markets,
    market,
    symbol,
    status,
    statusDetail,
    connected,
    authenticatedFeed,
    loadingMarket,
    prices,
    currentPrice,
    openContracts,
    transactions,
    tradeBusy,
    tradeError,
    selectedAccountType,
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("Quantum AI is ready.");
  const [settings, setSettings] = useState({
    stake: 0.35,
    minConfidence: 72,
    maxNoise: 66,
    maxReversalRisk: 60,
    maxOpenTrades: 2,
    marketSwitchSeconds: 5,
    minimumTradeGapSeconds: 3,
    takeProfit: 5,
    stopLoss: 3,
    oneLossCooldownSeconds: 20,
    repeatLossBlockSeconds: 90,
    marketLossBlockSeconds: 60,
    learningEnabled: true,
    learningMinimumTrades: 3,
    learningMaxAdjustment: 7,
    recoveryEnabled: true,
    maxRecoveryAttempts: 2,
    recoveryConfidenceBonus: 0,
    recoveryAttempt1Confidence: 70,
    recoveryAttempt2Confidence: 72,
    recoveryCooldownSeconds: 20,
    recoveryStakeMultiplier: 2,
    scanCycleSeconds: 120,
    fastLaneSeconds: 30,
    balancedLaneSeconds: 60,
    opportunityLaneSeconds: 90,
    fastConfidence: 70,
    balancedConfidence: 68,
    opportunityConfidence: 66,
    selectiveConfidence: 65,
    entryQueueTicks: 1,
    minimumVoteConsensus: 52,
    maximumFastNoise: 72,
    maximumFastReversal: 68,
    finalSafeMinimumVotes: 58,
    finalSafeMaximumNoise: 70,
    finalSafeMaximumReversal: 64,
    recoveryExpiryDurationMultiplier: 1.5,
    maximumRecoveryDurationSeconds: 30,
    maximumRecoveryStake: 1.4,
    patternMinimumSamples: 4,
    patternMinimumSimilarity: 65,
    patternMaximumBonus: 8,
    patternMaximumPenalty: 7,
    historicalMinimumSamples: 4,
    historicalMaximumBonus: 6,
    weightedQualityMinimum: 62,
    hardNoiseLimit: 86,
    hardReversalLimit: 82,
    smartRecoveryOppositeBonus: 4,
  });
  const [activeTrades, setActiveTrades] = useState([]);
  const [stats, setStats] = useState(INITIAL_STATS);
  const [marketScores, setMarketScores] = useState({});
  const [learningModel, setLearningModel] =
    useState(readLearningModel);
  const [recovery, setRecovery] = useState({
    active: false,
    attempts: 0,
    previousLoss: null,
  });
  const [scanClock, setScanClock] = useState(0);
  const [entryQueue, setEntryQueue] = useState({
    key: "",
    ticks: 0,
  });
  const [cycleRestarts, setCycleRestarts] = useState(0);

  const lastTradeAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const processedContractsRef = useRef(new Set());
  const buyingRef = useRef(false);
  const autoConnectStartedRef = useRef(false);
  const adaptiveMarketBlockRef = useRef(new Map());
  const scanCycleStartedAtRef = useRef(Date.now());

  useEffect(() => {
    try {
      window.localStorage.setItem(
        QUANTUM_LEARNING_KEY,
        JSON.stringify(learningModel)
      );
    } catch {
      // Browser storage may be unavailable in private mode.
    }
  }, [learningModel]);

  useEffect(() => {
    if (!running) {
      setScanClock(0);
      return;
    }

    const update = () => {
      setScanClock(
        Math.max(
          0,
          (Date.now() -
            scanCycleStartedAtRef.current) /
            1000
        )
      );
    };

    update();
    const timer = window.setInterval(update, 250);

    return () => window.clearInterval(timer);
  }, [running]);

  const connecting = status === "CONNECTING" || loadingMarket;

  useEffect(() => {
    if (connected || connecting || autoConnectStartedRef.current) return;

    autoConnectStartedRef.current = true;
    setMessage("Connecting Quantum AI to Deriv live feed...");

    Promise.resolve(connect())
      .then(() => setMessage("Deriv live feed connected. Collecting market ticks..."))
      .catch((error) => {
        autoConnectStartedRef.current = false;
        setMessage(error instanceof Error ? error.message : "Unable to connect Deriv feed.");
      });
  }, [connected, connecting, connect]);

  const analysis = useMemo(
    () =>
      analyzeQuantumRiseFall(prices, {
        minConfidence: settings.minConfidence,
        maxNoise: settings.maxNoise,
        maxReversalRisk: settings.maxReversalRisk,
      }),
    [prices, settings.minConfidence, settings.maxNoise, settings.maxReversalRisk]
  );

  const currentCandidate =
    analysis.candidate || analysis.decision || "WAIT";

  const currentLearning = useMemo(
    () =>
      marketLearningStats(
        learningModel,
        symbol,
        currentCandidate
      ),
    [learningModel, symbol, currentCandidate]
  );

  const learnedAdjustment =
    settings.learningEnabled &&
    currentLearning.trades >=
      Number(settings.learningMinimumTrades)
      ? clampNumber(
          currentLearning.adjustment,
          -Math.abs(Number(settings.learningMaxAdjustment)),
          Math.abs(Number(settings.learningMaxAdjustment))
        )
      : 0;

  const learnedConfidence = clampNumber(
    Number(analysis.confidence || 0) + learnedAdjustment,
    0,
    99
  );

  const liveSetupVector = useMemo(
    () => setupVector(analysis),
    [analysis]
  );

  const similarHistory = useMemo(
    () =>
      similarSetupStats(
        learningModel,
        liveSetupVector,
        symbol
      ),
    [learningModel, liveSetupVector, symbol]
  );

  const historicalDirection = useMemo(
    () =>
      marketDirectionProbability(
        learningModel,
        symbol,
        currentCandidate
      ),
    [learningModel, symbol, currentCandidate]
  );

  const oppositeCandidate =
    currentCandidate === "RISE"
      ? "FALL"
      : currentCandidate === "FALL"
      ? "RISE"
      : "WAIT";

  const oppositeHistorical = useMemo(
    () =>
      marketDirectionProbability(
        learningModel,
        symbol,
        oppositeCandidate
      ),
    [learningModel, symbol, oppositeCandidate]
  );

  const patternAdjustment =
    similarHistory.samples >=
    Number(settings.patternMinimumSamples)
      ? clampNumber(
          (similarHistory.probability - 0.5) * 28,
          -Math.abs(
            Number(settings.patternMaximumPenalty)
          ),
          Math.abs(
            Number(settings.patternMaximumBonus)
          )
        )
      : 0;

  const historicalAdjustment =
    historicalDirection.trades >=
    Number(settings.historicalMinimumSamples)
      ? clampNumber(
          (
            historicalDirection.probability -
            0.5
          ) * 22,
          -Math.abs(
            Number(settings.historicalMaximumBonus)
          ),
          Math.abs(
            Number(settings.historicalMaximumBonus)
          )
        )
      : 0;

  const liveRiskPenalty =
    Number(analysis.noiseScore || 0) * 0.08 +
    Number(analysis.reversalRisk || 0) * 0.10 +
    Math.max(
      0,
      55 -
        Number(
          analysis.metrics?.transition || 0
        )
    ) *
      0.07;

  const liveQualityScore = clampNumber(
    learnedConfidence * 0.34 +
      Number(
        analysis.metrics?.voteConsensus || 0
      ) *
        0.22 +
      Number(
        analysis.metrics?.transition || 0
      ) *
        0.16 +
      Number(
        analysis.metrics?.trendStrength || 0
      ) *
        0.14 +
      Number(analysis.consistency || 0) *
        0.14 -
      liveRiskPenalty,
    0,
    100
  );

  const finalLearnedConfidence = clampNumber(
    learnedConfidence +
      patternAdjustment +
      historicalAdjustment -
      liveRiskPenalty * 0.18,
    0,
    99
  );

  const hardRiskBlock =
    Number(analysis.noiseScore || 0) >
      Number(settings.hardNoiseLimit) ||
    Number(analysis.reversalRisk || 0) >
      Number(settings.hardReversalLimit);

  const smartRecoveryDirection =
    recovery.active &&
    oppositeHistorical.trades >= 4 &&
    oppositeHistorical.probability >
      historicalDirection.probability + 0.12
      ? oppositeCandidate
      : currentCandidate;


  const recoveryRequiredConfidence =
    !recovery.active
      ? Number(settings.minConfidence || 72)
      : Number(recovery.attempts || 1) <= 1
      ? Number(settings.recoveryAttempt1Confidence || 70)
      : Number(settings.recoveryAttempt2Confidence || 72);

  const scanPhase =
    scanClock < Number(settings.fastLaneSeconds)
      ? "NORMAL"
      : scanClock < Number(settings.balancedLaneSeconds)
      ? "ADAPTIVE"
      : scanClock < Number(settings.opportunityLaneSeconds)
      ? "OPPORTUNITY"
      : "FINAL_SAFE";

  const phaseConfidence =
    scanPhase === "NORMAL"
      ? Number(settings.fastConfidence)
      : scanPhase === "ADAPTIVE"
      ? Number(settings.balancedConfidence)
      : scanPhase === "OPPORTUNITY"
      ? Number(settings.opportunityConfidence)
      : Number(settings.selectiveConfidence);

  const dynamicRequiredConfidence = recovery.active
    ? recoveryRequiredConfidence
    : Math.max(
        Number(settings.minConfidence || 72),
        phaseConfidence
      );

  const fastVoteConsensus = Number(
    analysis.metrics?.voteConsensus || 0
  );

  const finalSafeStage = scanPhase === "FINAL_SAFE";

  const requiredVotes = finalSafeStage
    ? Number(settings.finalSafeMinimumVotes)
    : Number(settings.minimumVoteConsensus);

  const allowedNoise = finalSafeStage
    ? Number(settings.finalSafeMaximumNoise)
    : Number(settings.maximumFastNoise);

  const allowedReversal = finalSafeStage
    ? Number(settings.finalSafeMaximumReversal)
    : Number(settings.maximumFastReversal);

  const phaseSignalPass =
    finalLearnedConfidence >=
      dynamicRequiredConfidence &&
    liveQualityScore >=
      Number(settings.weightedQualityMinimum) &&
    fastVoteConsensus >= requiredVotes &&
    Number(analysis.noiseScore || 100) <=
      allowedNoise &&
    Number(analysis.reversalRisk || 100) <=
      allowedReversal &&
    !hardRiskBlock;

  const queueDirection = recovery.active
    ? smartRecoveryDirection
    : currentCandidate;

  const queueKey = `${symbol}|${queueDirection}`;

  useEffect(() => {
    if (
      !running ||
      !analysis.ready ||
      !phaseSignalPass ||
      queueDirection === "WAIT"
    ) {
      setEntryQueue({ key: "", ticks: 0 });
      return;
    }

    setEntryQueue((current) => ({
      key: queueKey,
      ticks:
        current.key === queueKey
          ? Math.min(
              Number(settings.entryQueueTicks),
              current.ticks + 1
            )
          : 1,
    }));
  }, [
    running,
    analysis.ready,
    phaseSignalPass,
    currentCandidate,
    queueDirection,
    queueKey,
    currentPrice,
    settings.entryQueueTicks,
  ]);

  const entryQueuePass =
    entryQueue.key === queueKey &&
    entryQueue.ticks >=
      Number(settings.entryQueueTicks);


  const learningEntryPass =
    learnedConfidence >= dynamicRequiredConfidence &&
    phaseSignalPass &&
    entryQueuePass;

  const recoveryMarketPass =
    !recovery.active ||
    !recovery.previousLoss ||
    recovery.previousLoss.symbol !== symbol;


  const recoveryDuration = useMemo(() => {
    const baseDuration = Math.max(
      1,
      Number(analysis.duration || 5)
    );

    const baseUnit =
      analysis.durationUnit === "t" ? "t" : "s";

    const previousCause =
      recovery.previousLoss?.cause?.code || "";

    if (
      recovery.active &&
      previousCause === "EXPIRY_VARIANCE" &&
      baseUnit === "s"
    ) {
      return {
        duration: Math.min(
          Number(settings.maximumRecoveryDurationSeconds),
          Math.max(
            baseDuration + 2,
            Math.round(
              baseDuration *
                Number(
                  settings.recoveryExpiryDurationMultiplier
                )
            )
          )
        ),
        durationUnit: "s",
        reason: "Longer recovery expiry after expiry variance",
      };
    }

    return {
      duration: baseDuration,
      durationUnit: baseUnit,
      reason: recovery.active
        ? "Fresh setup recovery duration"
        : "Normal analyzed duration",
    };
  }, [
    analysis.duration,
    analysis.durationUnit,
    recovery.active,
    recovery.previousLoss,
    settings.maximumRecoveryDurationSeconds,
    settings.recoveryExpiryDurationMultiplier,
  ]);

  const adaptiveLossGuard = useMemo(() => {
    const history = Array.isArray(stats.history) ? stats.history : [];
    const now = Date.now();

    const symbolHistory = history
      .filter((item) => item.symbol === symbol)
      .sort((a, b) => Number(b.settledAt || 0) - Number(a.settledAt || 0));

    const recent = symbolHistory.slice(0, 8);
    const last = recent[0] || null;

    let sameDirectionLossStreak = 0;
    let marketLossStreak = 0;
    let sessionLossStreak = 0;

    for (const item of history) {
      if (item.result !== "LOST") break;
      sessionLossStreak += 1;
    }

    for (const item of recent) {
      if (item.result !== "LOST") break;
      marketLossStreak += 1;
    }

    if (last?.result === "LOST") {
      for (const item of recent) {
        if (item.result !== "LOST" || item.direction !== last.direction) break;
        sameDirectionLossStreak += 1;
      }
    }

    const lastLossAgeSeconds =
      last?.result === "LOST"
        ? Math.max(0, (now - Number(last.settledAt || now)) / 1000)
        : Number.POSITIVE_INFINITY;

    const candidate = analysis.candidate || analysis.decision || "WAIT";
    const sameAsLastLoss =
      last?.result === "LOST" && candidate === last.direction;

    const oppositeOfLastLoss =
      last?.result === "LOST" &&
      candidate !== "WAIT" &&
      candidate !== last.direction;

    const voteConsensus = Number(analysis.metrics?.voteConsensus || 0);
    const consistency = Number(analysis.consistency || 0);
    const fullTimeframePassed = Boolean(
      (analysis.checks || []).find((item) => item.label === "Full timeframe")?.passed
    );

    const oppositeConfirmed =
      oppositeOfLastLoss &&
      analysis.entryMode === "STRONG" &&
      finalLearnedConfidence >=
        Number(settings.minConfidence || 72) +
          Number(settings.smartRecoveryOppositeBonus) &&
      Number(analysis.noiseScore || 100) <= Math.max(20, Number(settings.maxNoise || 66) - 8) &&
      Number(analysis.reversalRisk || 100) <= Math.max(15, Number(settings.maxReversalRisk || 60) - 10) &&
      voteConsensus >= 68 &&
      consistency >= 35 &&
      fullTimeframePassed;

    const oneLossCooldown =
      sameAsLastLoss &&
      sameDirectionLossStreak === 1 &&
      lastLossAgeSeconds < Number(settings.oneLossCooldownSeconds || 20);

    const repeatedDirectionBlock =
      sameAsLastLoss &&
      sameDirectionLossStreak >= 2 &&
      lastLossAgeSeconds < Number(settings.repeatLossBlockSeconds || 90);

    const marketBlockedUntil = Number(adaptiveMarketBlockRef.current.get(symbol) || 0);
    const marketBlocked = marketLossStreak >= 2 && now < marketBlockedUntil;

    const sessionCooldown = sessionLossStreak >= 3 && lastLossAgeSeconds < 120;

    let reason = "Loss memory clear. Normal confirmed-entry rules apply.";

    if (sessionCooldown) {
      reason = "Three consecutive session losses: scanner cooling down for 120 seconds.";
    } else if (marketBlocked) {
      reason = "This market is temporarily blocked after repeated losses.";
    } else if (repeatedDirectionBlock) {
      reason = `${candidate} is blocked after repeated same-direction losses. Switching market.`;
    } else if (oneLossCooldown) {
      reason = `${candidate} lost recently. Waiting for a fresh setup instead of repeating immediately.`;
    } else if (oppositeOfLastLoss && !oppositeConfirmed) {
      reason = `Opposite ${candidate} is not accepted automatically; strong independent confirmation is required.`;
    } else if (oppositeConfirmed) {
      reason = `Opposite ${candidate} passed strong independent confirmation after the previous loss.`;
    }

    const recoverySameMarket =
      recovery.active &&
      recovery.previousLoss?.symbol === symbol;

    if (recoverySameMarket) {
      reason =
        "Recovery requires a fresh market after the previous loss.";
    } else if (
      recovery.active &&
      !learningEntryPass
    ) {
      reason =
        `Recovery needs ${dynamicRequiredConfidence.toFixed(
          1
        )}% learned confidence plus ${settings.entryQueueTicks} confirming ticks. Current final confidence: ${finalLearnedConfidence.toFixed(
          1
        )}%; quality: ${liveQualityScore.toFixed(
          1
        )}%.`;
    } else if (!learningEntryPass) {
      reason =
        `${scanPhase} stage needs ${dynamicRequiredConfidence.toFixed(
          1
        )}% confidence, ${requiredVotes.toFixed(
          0
        )}% vote consensus and ${settings.entryQueueTicks} confirming tick(s). Current final confidence: ${finalLearnedConfidence.toFixed(
          1
        )}%; quality: ${liveQualityScore.toFixed(
          1
        )}%.`;
    }

    const ready =
      analysis.ready &&
      learningEntryPass &&
      recoveryMarketPass &&
      !sessionCooldown &&
      !marketBlocked &&
      !oneLossCooldown &&
      !repeatedDirectionBlock &&
      (!oppositeOfLastLoss || oppositeConfirmed);

    return {
      ready,
      reason,
      candidate,
      lastLossDirection: last?.result === "LOST" ? last.direction : "—",
      sameDirectionLossStreak,
      marketLossStreak,
      sessionLossStreak,
      oppositeConfirmed,
      shouldSwitchMarket:
        repeatedDirectionBlock ||
        marketBlocked ||
        sessionCooldown ||
        recoverySameMarket,
    };
  }, [
    stats.history,
    symbol,
    analysis.ready,
    analysis.candidate,
    analysis.decision,
    analysis.entryMode,
    analysis.confidence,
    analysis.noiseScore,
    analysis.reversalRisk,
    analysis.consistency,
    analysis.metrics?.voteConsensus,
    analysis.checks,
    settings.minConfidence,
    settings.maxNoise,
    settings.maxReversalRisk,
    settings.oneLossCooldownSeconds,
    settings.repeatLossBlockSeconds,
    learnedConfidence,
    finalLearnedConfidence,
    liveQualityScore,
    hardRiskBlock,
    learningEntryPass,
    recoveryRequiredConfidence,
    dynamicRequiredConfidence,
    phaseSignalPass,
    entryQueuePass,
    scanPhase,
    requiredVotes,
    allowedNoise,
    allowedReversal,
    settings.entryQueueTicks,
    recovery.active,
    recovery.previousLoss,
    recoveryMarketPass,
  ]);

  useEffect(() => {
    const symbolHistory = (Array.isArray(stats.history) ? stats.history : [])
      .filter((item) => item.symbol === symbol)
      .sort((a, b) => Number(b.settledAt || 0) - Number(a.settledAt || 0));

    let losses = 0;
    for (const item of symbolHistory) {
      if (item.result !== "LOST") break;
      losses += 1;
    }

    if (losses >= 2 && symbol) {
      adaptiveMarketBlockRef.current.set(
        symbol,
        Date.now() + Number(settings.marketLossBlockSeconds || 60) * 1000
      );
    }
  }, [stats.history, symbol, settings.marketLossBlockSeconds]);
  useEffect(() => {
    if (!symbol) return;
    setMarketScores((current) => ({
      ...current,
      [symbol]: {
        symbol,
        label: market?.label || symbol,
        confidence: finalLearnedConfidence,
        rawConfidence: analysis.confidence,
        decision: analysis.decision,
        score:
          liveQualityScore +
          patternAdjustment +
          historicalAdjustment,
        updatedAt: Date.now(),
      },
    }));
  }, [
    symbol,
    market?.label,
    analysis.confidence,
    analysis.decision,
    analysis.reversalRisk,
    learnedConfidence,
    finalLearnedConfidence,
    liveQualityScore,
    patternAdjustment,
    historicalAdjustment,
  ]);

  useEffect(() => {
    const contractRows = Array.isArray(openContracts) ? openContracts : [];
    const transactionRows = Array.isArray(transactions) ? transactions : [];

    const combined = [...contractRows, ...transactionRows];
    const updates = [];

    for (const contract of combined) {
      const id = contractIdOf(contract);

      if (
        !id ||
        !settled(contract) ||
        processedContractsRef.current.has(id)
      ) {
        continue;
      }

      const original = activeTrades.find(
        (item) => String(item.contractId) === id
      );

      if (!original) continue;

      processedContractsRef.current.add(id);

      const profit = contractProfit(contract);
      const rawStatus = String(
        contract?.status ||
          contract?.contract_status ||
          ""
      ).toUpperCase();

      const result =
        rawStatus === "WON" || profit > 0
          ? "WON"
          : "LOST";

      const outcomeCause =
        classifyTradeOutcome(original, result);

      updates.push({
        ...original,
        result,
        profit,
        outcomeCause,
        settledAt: Date.now(),
      });

      if (settings.learningEnabled) {
        const key = learningKey(
          original.symbol,
          original.direction
        );

        setLearningModel((current) => {
          const previous =
            current.markets?.[key] || {
              trades: 0,
              wins: 0,
              losses: 0,
              totalProfit: 0,
            };

          return {
            totalTrades:
              Number(current.totalTrades || 0) + 1,
            markets: {
              ...(current.markets || {}),
              [key]: {
                ...previous,
                symbol: original.symbol,
                market: original.market,
                direction: original.direction,
                trades:
                  Number(previous.trades || 0) + 1,
                wins:
                  Number(previous.wins || 0) +
                  (result === "WON" ? 1 : 0),
                losses:
                  Number(previous.losses || 0) +
                  (result === "LOST" ? 1 : 0),
                totalProfit:
                  Number(previous.totalProfit || 0) +
                  Number(profit || 0),
                lastCause: outcomeCause,
                lastConfidence:
                  Number(original.confidence || 0),
                lastSettledAt: Date.now(),
              },
            },
            recent: [
              ...(Array.isArray(current.recent)
                ? current.recent
                : []),
              {
                key,
                symbol: original.symbol,
                direction: original.direction,
                result,
                profit: Number(profit || 0),
                confidence: Number(
                  original.confidence || 0
                ),
                entryVector:
                  original.entrySnapshot?.setupVector ||
                  null,
                qualityScore: Number(
                  original.entrySnapshot?.qualityScore ||
                    0
                ),
                settledAt: Date.now(),
              },
            ].slice(-500),
          };
        });
      }

      if (result === "LOST") {
        adaptiveMarketBlockRef.current.set(
          original.symbol,
          Date.now() +
            Number(
              settings.marketLossBlockSeconds || 60
            ) *
              1000
        );

        if (
          settings.recoveryEnabled &&
          recovery.attempts <
            Number(settings.maxRecoveryAttempts || 2)
        ) {
          setRecovery({
            active: true,
            attempts: recovery.attempts + 1,
            previousLoss: {
              symbol: original.symbol,
              market: original.market,
              direction: original.direction,
              cause: outcomeCause,
              settledAt: Date.now(),
            },
          });
        } else {
          setRecovery({
            active: false,
            attempts: recovery.attempts,
            previousLoss: {
              symbol: original.symbol,
              market: original.market,
              direction: original.direction,
              cause: outcomeCause,
              settledAt: Date.now(),
            },
          });
        }
      } else if (recovery.active) {
        setRecovery({
          active: false,
          attempts: 0,
          previousLoss: null,
        });
      }
    }

    if (!updates.length) return;

    setActiveTrades((current) =>
      current.filter(
        (item) =>
          !updates.some(
            (done) =>
              String(done.contractId) === String(item.contractId)
          )
      )
    );

    setStats((current) => {
      const wins = updates.filter(
        (item) => item.result === "WON"
      ).length;

      const losses = updates.length - wins;

      const profit = updates.reduce(
        (sum, item) => sum + Number(item.profit || 0),
        0
      );

      return {
        runs: current.runs,
        wins: current.wins + wins,
        losses: current.losses + losses,
        profit: current.profit + profit,
        history: [
          ...updates.reverse(),
          ...current.history,
        ].slice(0, 40),
      };
    });
  }, [
    openContracts,
    transactions,
    activeTrades,
    settings.learningEnabled,
    settings.recoveryEnabled,
    settings.maxRecoveryAttempts,
    settings.marketLossBlockSeconds,
    recovery.active,
    recovery.attempts,
    recoveryDuration.duration,
    recoveryDuration.durationUnit,
    recoveryDuration.reason,
    settings.maximumRecoveryStake,
    smartRecoveryDirection,
    finalLearnedConfidence,
    liveQualityScore,
    liveSetupVector,
    similarHistory.samples,
    similarHistory.probability,
    similarHistory.averageSimilarity,
    historicalDirection.trades,
    historicalDirection.probability,
    patternAdjustment,
    historicalAdjustment,
  ]);

  useEffect(() => {
    if (
      !activeTrades.length ||
      typeof refreshContract !== "function"
    ) {
      return;
    }

    const refreshAll = () => {
      activeTrades.forEach((trade) => {
        if (!trade.contractId) return;

        Promise.resolve(
          refreshContract(trade.contractId)
        ).catch(() => {
          // Subscription may still deliver the settlement.
        });
      });
    };

    refreshAll();
    const timer = window.setInterval(refreshAll, 2000);

    return () => window.clearInterval(timer);
  }, [activeTrades, refreshContract]);

  useEffect(() => {
    if (!running) return;
    if (stats.profit >= Number(settings.takeProfit)) {
      setRunning(false);
      setMessage("Take Profit reached. Bot stopped safely.");
    } else if (stats.profit <= -Math.abs(Number(settings.stopLoss))) {
      setRunning(false);
      setMessage("Stop Loss reached. Bot stopped safely.");
    }
  }, [running, stats.profit, settings.takeProfit, settings.stopLoss]);

  useEffect(() => {
    if (!running || loadingMarket || activeTrades.length > 0 || markets.length < 2) return;
    if (adaptiveLossGuard.ready) {
      scanStartedAtRef.current = Date.now();
      return;
    }

    if (adaptiveLossGuard.shouldSwitchMarket) {
      const index = Math.max(0, markets.findIndex((item) => item.id === symbol));
      const next = markets[(index + 1) % markets.length];

      if (next?.id && next.id !== symbol) {
        setMessage(adaptiveLossGuard.reason);
        scanStartedAtRef.current = Date.now();
        void changeSymbol(next.id);
      }
      return;
    }

    const timer = window.setInterval(() => {
      const marketElapsed =
        (Date.now() - scanStartedAtRef.current) / 1000;

      const cycleElapsed =
        (Date.now() -
          scanCycleStartedAtRef.current) /
        1000;

      if (
        cycleElapsed >=
        Number(settings.scanCycleSeconds || 120)
      ) {
        scanCycleStartedAtRef.current = Date.now();
        setCycleRestarts((current) => current + 1);
        setEntryQueue({ key: "", ticks: 0 });

        const ranked = Object.values(marketScores)
          .filter(
            (item) =>
              item?.symbol &&
              Date.now() -
                Number(item.updatedAt || 0) <
                120000
          )
          .sort((a, b) => b.score - a.score);

        const best = ranked[0];

        if (best?.symbol) {
          setMessage(
            `120s cycle complete. Restarting on best recent market ${best.label} at ${Number(
              best.confidence || 0
            ).toFixed(1)}% learned confidence. No unsafe trade was forced.`
          );

          scanStartedAtRef.current = Date.now();

          if (best.symbol !== symbol) {
            void changeSymbol(best.symbol);
          }

          return;
        }
      }

      if (
        marketElapsed <
        Number(settings.marketSwitchSeconds || 7)
      ) {
        return;
      }

      const index = Math.max(
        0,
        markets.findIndex(
          (item) => item.id === symbol
        )
      );

      const next =
        markets[(index + 1) % markets.length];

      if (next?.id && next.id !== symbol) {
        setMessage(
          `${scanPhase} scan: switching to ${next.label} after ${settings.marketSwitchSeconds}s.`
        );
        scanStartedAtRef.current = Date.now();
        setEntryQueue({ key: "", ticks: 0 });
        void changeSymbol(next.id);
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, [
    running,
    loadingMarket,
    activeTrades.length,
    markets,
    symbol,
    analysis.ready,
    adaptiveLossGuard.ready,
    adaptiveLossGuard.reason,
    adaptiveLossGuard.shouldSwitchMarket,
    settings.marketSwitchSeconds,
    settings.scanCycleSeconds,
    marketScores,
    scanPhase,
    changeSymbol,
  ]);

  useEffect(() => {
    if (
      !running ||
      !adaptiveLossGuard.ready ||
      buyingRef.current ||
      tradeBusy
    ) {
      if (running && analysis.ready && !adaptiveLossGuard.ready) {
        setMessage(adaptiveLossGuard.reason);
      }
      return;
    }
    if (!authenticatedFeed) {
      setMessage("Choose a Deriv Demo or Real account and reconnect first.");
      return;
    }
    if (activeTrades.length >= Number(settings.maxOpenTrades || 2)) return;

    const gapMs =
      Number(
        recovery.active
          ? settings.recoveryCooldownSeconds
          : settings.minimumTradeGapSeconds
      ) * 1000;
    if (Date.now() - lastTradeAtRef.current < gapMs) return;

    buyingRef.current = true;

    void (async () => {
      try {
        const direction = recovery.active
          ? smartRecoveryDirection
          : adaptiveLossGuard.candidate;
        setMessage(
          `${recovery.active ? `Recovery ${recovery.attempts}/${settings.maxRecoveryAttempts} at ${Math.min(
            Number(settings.maximumRecoveryStake),
            recoveryStakeAmount(
              settings.stake,
              recovery
            )
          ).toFixed(2)} USD` : "Normal entry"} · ${direction} · ${finalLearnedConfidence.toFixed(
            1
          )}% final confidence · ${recoveryDuration.duration}${
            recoveryDuration.durationUnit === "t"
              ? " ticks"
              : " seconds"
          }.`
        );

        const tradeRequest = Promise.resolve(
          placeTrade({
            contractType: direction === "RISE" ? "CALL" : "PUT",
            amount: recovery.active
              ? Math.min(
                  Number(settings.maximumRecoveryStake),
                  recoveryStakeAmount(
                    settings.stake,
                    recovery
                  )
                )
              : Math.max(
                  0.35,
                  Number(settings.stake || 0.35)
                ),
            basis: "stake",
            duration: Number(recoveryDuration.duration),
            durationUnit: recoveryDuration.durationUnit,
            symbol,
          })
        );

        const timeoutRequest = new Promise((_, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                "Deriv purchase confirmation timed out after 15 seconds. Scanner has been released."
              )
            );
          }, 15000);
        });

        const response = await Promise.race([
          tradeRequest,
          timeoutRequest,
        ]);

        const contractId = contractIdOf(response);
        if (!contractId) throw new Error("Deriv did not return a contract ID.");

        const trade = {
          contractId,
          market: market?.label || symbol,
          symbol,
          direction,
          confidence: finalLearnedConfidence,
          rawConfidence: analysis.confidence,
          learnedAdjustment,
          patternAdjustment,
          historicalAdjustment,
          qualityScore: liveQualityScore,
          recoveryTrade: recovery.active,
          recoveryAttempt: recovery.attempts,
          duration: recoveryDuration.duration,
          durationUnit: recoveryDuration.durationUnit,
          displayDuration:
            recoveryDuration.durationUnit === "t"
              ? `${recoveryDuration.duration} ticks`
              : `${recoveryDuration.duration} seconds`,
          durationReason: recoveryDuration.reason,
          stake: recovery.active
            ? Math.min(
                Number(settings.maximumRecoveryStake),
                recoveryStakeAmount(
                  settings.stake,
                  recovery
                )
              )
            : Number(settings.stake || 0.35),
          baseStake: Number(settings.stake || 0.35),
          recoveryMultiplier: recovery.active
            ? 2 ** Math.min(2, Number(recovery.attempts || 0))
            : 1,
          entryPrice: currentPrice,
          entrySnapshot: {
            decision: analysis.decision,
            candidate: analysis.candidate,
            entryMode: analysis.entryMode,
            regime: analysis.regime,
            trend: analysis.trend,
            momentum: analysis.momentum,
            noiseScore: Number(
              analysis.noiseScore || 0
            ),
            reversalRisk: Number(
              analysis.reversalRisk || 0
            ),
            consistency: Number(
              analysis.consistency || 0
            ),
            voteConsensus: Number(
              analysis.metrics?.voteConsensus || 0
            ),
            trendStrength: Number(
              analysis.metrics?.trendStrength || 0
            ),
            transition: Number(
              analysis.metrics?.transition || 0
            ),
            entropy: Number(
              analysis.metrics?.entropy || 0
            ),
            impulse: Number(
              analysis.metrics?.impulse || 0
            ),
            rsi: Number(
              analysis.metrics?.rsi || 0
            ),
            setupVector: liveSetupVector,
            similarSamples:
              similarHistory.samples,
            similarProbability:
              similarHistory.probability,
            averageSimilarity:
              similarHistory.averageSimilarity,
            historicalTrades:
              historicalDirection.trades,
            historicalProbability:
              historicalDirection.probability,
            patternAdjustment,
            historicalAdjustment,
            qualityScore: liveQualityScore,
            finalConfidence:
              finalLearnedConfidence,
          },
          openedAt: Date.now(),
        };

        lastTradeAtRef.current = Date.now();
        setActiveTrades((current) => [trade, ...current]);
        setStats((current) => ({ ...current, runs: current.runs + 1 }));
        setMessage(
          `Trade ${contractId} opened at ${
            recovery.active
              ? `${recoveryStakeAmount(settings.stake, recovery).toFixed(2)} USD recovery stake`
              : `${Number(settings.stake || 0.35).toFixed(2)} USD base stake`
          }.`
        );
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to open trade.");
      } finally {
        buyingRef.current = false;
      }
    })();


  }, [
    running,
    analysis,
    adaptiveLossGuard.ready,
    adaptiveLossGuard.reason,
    adaptiveLossGuard.candidate,
    authenticatedFeed,
    activeTrades.length,
    settings,
    tradeBusy,
    placeTrade,
    symbol,
    market?.label,
    currentPrice,
    learnedConfidence,
    learnedAdjustment,
    recovery.active,
    recovery.attempts,
  ]);

  async function startBot() {
    if (!connected) {
      try {
        setMessage("Connecting to Deriv...");
        await connect();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Connection failed.");
        return;
      }
    }

    scanStartedAtRef.current = Date.now();
    scanCycleStartedAtRef.current = Date.now();
    setScanClock(0);
    setEntryQueue({ key: "", ticks: 0 });
    setRunning(true);
    setMessage(
      "V14 scanner started: 5-second market rotation, 30-second ranking cycle and one-tick qualified entry queue."
    );
  }

  function stopBot() {
    setRunning(false);
    setMessage("Bot stopped. Open contracts will continue settling on Deriv.");
  }

  function resetSession() {
    if (running || activeTrades.length) return;
    setStats(INITIAL_STATS);
    processedContractsRef.current.clear();
    setRecovery({
      active: false,
      attempts: 0,
      previousLoss: null,
    });
    setScanClock(0);
    setEntryQueue({ key: "", ticks: 0 });
    setMessage(
      "Session reset. Learned market memory has been preserved."
    );
  }

  const rankedMarkets = Object.values(marketScores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return (
    <div className="appShell quantumShell">
      <Sidebar />
      <main className="mainContent quantumPage">
        <Topbar
          title="MetaBinary Quantum AI V16"
          subtitle="Pattern similarity · historical probability · smart recovery"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className={`quantumHero ${running ? "running" : "idle"}`}>
          <div>
            <small>METABINARY SYNTHETIC INTELLIGENCE</small>
            <h1>MetaBinary Quantum AI V16</h1>
            <p>
              Compares each live setup with settled history, calculates
              market-direction probability and uses a fresh confirmed
              setup for each capped recovery attempt.
            </p>
          </div>
          <div className="quantumHeroStatus">
            <span>{running ? "â— LIVE" : "â—‹ IDLE"}</span>
            <strong>{running ? (analysis.ready ? "ENTRY READY" : "SCANNING") : "STOPPED"}</strong>
          </div>
        </section>

        <section className="quantumToolbar">
          <div>
            <span>Market</span>
            <MarketSelector
              markets={markets}
              value={symbol}
              disabled={loadingMarket || activeTrades.length > 0}
              onChange={changeSymbol}
            />
          </div>
          <div className="quantumAccount">
            <span>Account</span>
            <strong>{selectedAccountType || "Not selected"}</strong>
          </div>
          <button className="quantumStart" onClick={startBot} disabled={running}>RUN AI</button>
          <button className="quantumStop" onClick={stopBot} disabled={!running}>STOP</button>
          <button className="quantumReset" onClick={resetSession} disabled={running || activeTrades.length > 0}>RESET</button>
        </section>

        <section className="quantumV16Brain">
          <header>
            <div>
              <small>V16 SELF-LEARNING BRAIN</small>
              <h3>Pattern + history + live risk</h3>
            </div>
            <strong>
              {hardRiskBlock
                ? "HARD BLOCK"
                : `QUALITY ${liveQualityScore.toFixed(1)}`}
            </strong>
          </header>

          <div className="quantumV16Grid">
            <article>
              <span>Base confidence</span>
              <strong>
                {Number(analysis.confidence || 0).toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Market learning</span>
              <strong>
                {learnedAdjustment >= 0 ? "+" : ""}
                {learnedAdjustment.toFixed(1)}
              </strong>
            </article>
            <article>
              <span>Pattern adjustment</span>
              <strong>
                {patternAdjustment >= 0 ? "+" : ""}
                {patternAdjustment.toFixed(1)}
              </strong>
            </article>
            <article>
              <span>History adjustment</span>
              <strong>
                {historicalAdjustment >= 0 ? "+" : ""}
                {historicalAdjustment.toFixed(1)}
              </strong>
            </article>
            <article>
              <span>Risk penalty</span>
              <strong>
                -{liveRiskPenalty.toFixed(1)}
              </strong>
            </article>
            <article>
              <span>Final confidence</span>
              <strong>
                {finalLearnedConfidence.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Similar setups</span>
              <strong>{similarHistory.samples}</strong>
            </article>
            <article>
              <span>Pattern probability</span>
              <strong>
                {(similarHistory.probability * 100).toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Average similarity</span>
              <strong>
                {similarHistory.averageSimilarity.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Market-side trades</span>
              <strong>{historicalDirection.trades}</strong>
            </article>
            <article>
              <span>Historical probability</span>
              <strong>
                {(historicalDirection.probability * 100).toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Recovery direction</span>
              <strong>{smartRecoveryDirection}</strong>
            </article>
          </div>
        </section>

        <section className="quantumV15Manager">
          <header>
            <div>
              <small>V15 DYNAMIC LEARNING + RECOVERY</small>
              <h3>{scanPhase} STAGE</h3>
            </div>
            <strong>
              {scanClock.toFixed(1)}s /
              {settings.scanCycleSeconds}s
            </strong>
          </header>

          <div className="quantumV15Grid">
            <article>
              <span>Dynamic gate</span>
              <strong>
                {dynamicRequiredConfidence.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Current confidence</span>
              <strong>{finalLearnedConfidence.toFixed(1)}%</strong>
            </article>
            <article>
              <span>Required votes</span>
              <strong>{requiredVotes.toFixed(0)}%</strong>
            </article>
            <article>
              <span>Allowed noise</span>
              <strong>{allowedNoise.toFixed(0)}%</strong>
            </article>
            <article>
              <span>Recovery attempt</span>
              <strong>
                {recovery.active
                  ? `${recovery.attempts}/${settings.maxRecoveryAttempts}`
                  : "OFF"}
              </strong>
            </article>
            <article>
              <span>Next duration</span>
              <strong>
                {recoveryDuration.duration}
                {recoveryDuration.durationUnit === "t"
                  ? " ticks"
                  : " sec"}
              </strong>
            </article>
            <article>
              <span>Cycle restarts</span>
              <strong>{cycleRestarts}</strong>
            </article>
            <article>
              <span>Entry queue</span>
              <strong>
                {entryQueue.ticks}/{settings.entryQueueTicks}
              </strong>
            </article>
          </div>
        </section>

        <section className={`quantumFastScanner ${scanPhase.toLowerCase()}`}>
          <header>
            <div>
              <small>V16 SELF-LEARNING ENTRY MANAGER</small>
              <h3>{scanPhase} LANE</h3>
            </div>
            <strong>
              {scanClock.toFixed(1)}s /
              {settings.scanCycleSeconds}s
            </strong>
          </header>

          <div className="quantumFastGrid">
            <article>
              <span>Market rotation</span>
              <strong>{settings.marketSwitchSeconds}s</strong>
            </article>
            <article>
              <span>Required confidence</span>
              <strong>
                {dynamicRequiredConfidence.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Learned confidence</span>
              <strong>{finalLearnedConfidence.toFixed(1)}%</strong>
            </article>
            <article>
              <span>Vote consensus</span>
              <strong>{fastVoteConsensus.toFixed(0)}%</strong>
            </article>
            <article>
              <span>Entry queue</span>
              <strong>
                {entryQueue.ticks}/{settings.entryQueueTicks}
              </strong>
            </article>
            <article>
              <span>Recent 10</span>
              <strong>
                {(currentLearning.recent10 * 100).toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Recent 30</span>
              <strong>
                {(currentLearning.recent30 * 100).toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Entry gate</span>
              <strong
                className={
                  learningEntryPass
                    ? "positive"
                    : "negative"
                }
              >
                {learningEntryPass ? "READY" : "SCANNING"}
              </strong>
            </article>
          </div>
        </section>

        <section className={`quantumDecision ${analysis.ready ? "ready" : "wait"}`}>
          <div>
            <small>AI DECISION</small>
            <h2>{analysis.decision}</h2>
            <p>{analysis.reason}</p>
          </div>
          <div className="quantumDecisionStats">
            <article>
              <span>Learned confidence</span>
              <strong>{finalLearnedConfidence.toFixed(1)}%</strong>
            </article>
            <article><span>Candidate</span><strong>{analysis.candidate || "â€”"}</strong></article>
            <article>
              <span>Smart duration</span>
              <strong>
                {analysis.displayDuration ||
                  `${analysis.duration}${analysis.durationUnit === "t" ? " ticks" : "s"}`}
              </strong>
            </article>
            <article><span>Active slots</span><strong>{activeTrades.length}/{settings.maxOpenTrades}</strong></article>
          </div>
        </section>

        <section className="quantumSettings">
          {[
            ["Stake USD", "stake", 0.35, 100, 0.01],
            ["Min confidence", "minConfidence", 60, 98, 1],
            ["Max noise", "maxNoise", 20, 90, 1],
            ["Max reversal", "maxReversalRisk", 15, 90, 1],
            ["Trade slots", "maxOpenTrades", 1, 2, 1],
            ["Switch sec", "marketSwitchSeconds", 5, 60, 1],
            ["Take profit", "takeProfit", 0.5, 1000, 0.5],
            ["Stop loss", "stopLoss", 0.5, 1000, 0.5],
            ["Recovery attempts", "maxRecoveryAttempts", 0, 2, 1],
            ["Recovery 1 conf", "recoveryAttempt1Confidence", 60, 90, 1],
            ["Recovery 2 conf", "recoveryAttempt2Confidence", 60, 95, 1],
            ["Recovery cooldown", "recoveryCooldownSeconds", 5, 180, 1],
            ["Recovery stake x", "recoveryStakeMultiplier", 1, 2, 0.25],
            ["Learn after", "learningMinimumTrades", 1, 50, 1],
            ["Learning cap", "learningMaxAdjustment", 0, 12, 1],
            ["Scan cycle sec", "scanCycleSeconds", 30, 180, 5],
            ["Fast lane sec", "fastLaneSeconds", 5, 40, 1],
            ["Balanced sec", "balancedLaneSeconds", 15, 55, 1],
            ["Fast confidence", "fastConfidence", 60, 90, 1],
            ["Balanced confidence", "balancedConfidence", 60, 92, 1],
            ["Opportunity sec", "opportunityLaneSeconds", 30, 115, 5],
            ["Opportunity conf", "opportunityConfidence", 55, 90, 1],
            ["Final safe conf", "selectiveConfidence", 55, 90, 1],
            ["Queue ticks", "entryQueueTicks", 1, 5, 1],
            ["Final min vote", "finalSafeMinimumVotes", 45, 90, 1],
            ["Recovery max stake", "maximumRecoveryStake", 0.35, 20, 0.05],
            ["Pattern samples", "patternMinimumSamples", 1, 50, 1],
            ["Pattern bonus", "patternMaximumBonus", 0, 15, 1],
            ["Pattern penalty", "patternMaximumPenalty", 0, 15, 1],
            ["History samples", "historicalMinimumSamples", 1, 50, 1],
            ["Quality gate", "weightedQualityMinimum", 40, 90, 1],
            ["Hard noise", "hardNoiseLimit", 60, 100, 1],
            ["Hard reversal", "hardReversalLimit", 60, 100, 1],
            ["Min vote", "minimumVoteConsensus", 40, 90, 1],
          ].map(([label, key, min, max, step]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                min={min}
                max={max}
                step={step}
                disabled={running}
                value={settings[key]}
                onChange={(event) => setSettings((current) => ({ ...current, [key]: Number(event.target.value) }))}
              />
            </label>
          ))}
        </section>

        <section className="quantumMetrics">
          <article><span>Regime</span><strong>{analysis.regime}</strong></article>
          <article><span>Trend</span><strong>{analysis.trend}</strong></article>
          <article><span>Momentum</span><strong>{analysis.momentum}</strong></article>
          <article><span>Noise</span><strong>{analysis.noise}</strong></article>
          <article><span>Volatility</span><strong>{analysis.volatility.toFixed(0)}%</strong></article>
          <article><span>Consistency</span><strong>{analysis.consistency.toFixed(0)}%</strong></article>
          <article><span>Reversal risk</span><strong>{analysis.reversalRisk.toFixed(0)}%</strong></article>
          <article><span>Price</span><strong>{currentPrice ?? "â€”"}</strong></article>
        </section>

        <section className="quantumToolsPanel">
          <header>
            <div>
              <small>VISIBLE ANALYSIS TOOLS</small>
              <h3>What Quantum AI is reading now</h3>
            </div>
            <strong>{analysis.entryMode || "WAIT"} LANE</strong>
          </header>

          <div className="quantumToolGrid">
            {[
              ["RSI 14", analysis.metrics?.rsi?.toFixed?.(1) ?? "â€”"],
              ["EMA 6", analysis.metrics?.fastEma?.toFixed?.(5) ?? "â€”"],
              ["EMA 14", analysis.metrics?.mediumEma?.toFixed?.(5) ?? "â€”"],
              ["EMA 30", analysis.metrics?.slowEma?.toFixed?.(5) ?? "â€”"],
              ["Fast slope", analysis.metrics?.fastSlope?.toFixed?.(6) ?? "â€”"],
              ["Medium slope", analysis.metrics?.mediumSlope?.toFixed?.(6) ?? "â€”"],
              ["Slow slope", analysis.metrics?.slowSlope?.toFixed?.(6) ?? "â€”"],
              ["Impulse", `${Number(analysis.metrics?.impulse || 0).toFixed(0)}%`],
              ["Trend strength", `${Number(analysis.metrics?.trendStrength || 0).toFixed(0)}%`],
              ["Vote consensus", `${Number(analysis.metrics?.voteConsensus || 0).toFixed(0)}%`],
              ["RISE votes", Number(analysis.votes?.rise || 0).toFixed(2)],
              ["FALL votes", Number(analysis.votes?.fall || 0).toFixed(2)],
              ["ROC 3", Number(analysis.metrics?.roc3 || 0).toFixed(5)],
              ["ROC 8", Number(analysis.metrics?.roc8 || 0).toFixed(5)],
              ["Acceleration", Number(analysis.metrics?.acceleration || 0).toFixed(6)],
              ["Z-score", Number(analysis.metrics?.zScore || 0).toFixed(2)],
              ["Entropy", `${Number(analysis.metrics?.entropy || 0).toFixed(0)}%`],
              ["Transition", `${Number(analysis.metrics?.transition || 0).toFixed(0)}%`],
              ["Reversal bias", `${Number(analysis.metrics?.reversalBias || 0).toFixed(0)}%`],
              ["Range position", `${Number(analysis.metrics?.rangePosition || 0).toFixed(0)}%`],
              ["Breakout", analysis.metrics?.breakout || "NONE"],
              ["Cycle 4", Number(analysis.metrics?.cycle4 || 0).toFixed(2)],
              ["Cycle 7", Number(analysis.metrics?.cycle7 || 0).toFixed(2)],
              ["Micro slope", Number(analysis.metrics?.microSlope || 0).toFixed(6)],
            ].map(([label, value]) => (
              <article key={label}><span>{label}</span><strong>{value}</strong></article>
            ))}
          </div>

          <div className="quantumGateGrid">
            {(analysis.checks || []).map((check) => (
              <article key={check.label} className={check.passed ? "passed" : "failed"}>
                <span>{check.label}</span>
                <strong>{check.passed ? "PASS" : "WAIT"}</strong>
                <b>{check.value}</b>
              </article>
            ))}
          </div>
        </section>

        <section className="quantumLearningPanel">
          <header>
            <div>
              <small>MARKET LEARNING + RECOVERY</small>
              <h3>What the bot has learned</h3>
            </div>
            <strong>
              {recovery.active
                ? `RECOVERY ${recovery.attempts}/${settings.maxRecoveryAttempts}`
                : "NORMAL MODE"}
            </strong>
          </header>

          <div className="quantumLearningGrid">
            <article>
              <span>Market + side</span>
              <strong>
                {symbol || "—"} · {currentCandidate}
              </strong>
            </article>
            <article>
              <span>Learned trades</span>
              <strong>{currentLearning.trades}</strong>
            </article>
            <article>
              <span>Weighted recent rate</span>
              <strong>
                {(currentLearning.smoothedWinRate * 100).toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Confidence adjustment</span>
              <strong
                className={
                  learnedAdjustment >= 0
                    ? "positive"
                    : "negative"
                }
              >
                {learnedAdjustment >= 0 ? "+" : ""}
                {learnedAdjustment.toFixed(1)}
              </strong>
            </article>
            <article>
              <span>Required confidence</span>
              <strong>
                {dynamicRequiredConfidence.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Previous loss</span>
              <strong>
                {recovery.previousLoss?.cause?.code ||
                  currentLearning.lastCause?.code ||
                  "NONE"}
              </strong>
            </article>
            <article>
              <span>Next stake</span>
              <strong>
                {recovery.active
                  ? `${recoveryStakeAmount(
                      settings.stake,
                      recovery
                    ).toFixed(2)} USD`
                  : `${Number(
                      settings.stake || 0.35
                    ).toFixed(2)} USD`}
              </strong>
            </article>
            <article>
              <span>Recovery rule</span>
              <strong>
                {recovery.active
                  ? `X${2 ** Math.min(
                      2,
                      Number(recovery.attempts || 0)
                    )}`
                  : "BASE"}
              </strong>
            </article>
          </div>

          {recovery.previousLoss ? (
            <p>
              Previous loss:{" "}
              {recovery.previousLoss.cause.label}
              {" "}The losing market is blocked; recovery
              requires a fresh independently confirmed setup.
            </p>
          ) : null}
        </section>

        <section className={`quantumLossGuard ${adaptiveLossGuard.ready ? "ready" : "blocked"}`}>
          <header>
            <div>
              <small>ADAPTIVE LOSS MEMORY</small>
              <h3>Loss-aware market protection</h3>
            </div>
            <strong>{adaptiveLossGuard.ready ? "ENTRY ALLOWED" : "FILTERING"}</strong>
          </header>

          <div>
            <article><span>Last losing side</span><strong>{adaptiveLossGuard.lastLossDirection}</strong></article>
            <article><span>Same-side loss streak</span><strong>{adaptiveLossGuard.sameDirectionLossStreak}</strong></article>
            <article><span>Market loss streak</span><strong>{adaptiveLossGuard.marketLossStreak}</strong></article>
            <article><span>Session loss streak</span><strong>{adaptiveLossGuard.sessionLossStreak}</strong></article>
            <article><span>Opposite confirmation</span><strong>{adaptiveLossGuard.oppositeConfirmed ? "STRONG PASS" : "NOT CONFIRMED"}</strong></article>
          </div>

          <p>{adaptiveLossGuard.reason}</p>
        </section>
        <section className="quantumMessage">
          <strong>{message}</strong>
          {(tradeError || statusDetail || !authenticatedFeed) && (
            <span>
              {tradeError || statusDetail || (connected
                ? "Public analysis feed is connected. Reconnect the selected Demo/Real account for trading."
                : "Deriv feed is disconnected. Press Connect feed.")}
            </span>
          )}
        </section>

        <section className="quantumBottomGrid">
          <div className="quantumPanel">
            <header><div><small>LIVE EXECUTION</small><h3>Two-run monitor</h3></div><strong>{activeTrades.length} OPEN</strong></header>
            <div className="quantumTrades">
              {!activeTrades.length && <p>No open Quantum AI trades.</p>}
              {activeTrades.map((trade) => (
                <article key={trade.contractId}>
                  <div><strong>{trade.direction}</strong><span>{trade.market}</span></div>
                  <div><span>Confidence</span><strong>{trade.confidence.toFixed(1)}%</strong></div>
                  <div>
                    <span>Duration</span>
                    <strong>
                      {trade.displayDuration ||
                        `${trade.duration}${trade.durationUnit === "t" ? " ticks" : "s"}`}
                    </strong>
                  </div>
                  <div><span>Contract</span><strong>{trade.contractId}</strong></div>
                </article>
              ))}
            </div>
          </div>

          <div className="quantumPanel">
            <header><div><small>PERFORMANCE</small><h3>Current session</h3></div></header>
            <div className="quantumPerformance">
              <article><span>Runs</span><strong>{stats.runs}</strong></article>
              <article><span>Wins</span><strong>{stats.wins}</strong></article>
              <article><span>Losses</span><strong>{stats.losses}</strong></article>
              <article><span>P/L</span><strong className={stats.profit >= 0 ? "positive" : "negative"}>{money(stats.profit)}</strong></article>
            </div>
          </div>
        </section>

        <section className="quantumPanel quantumRanking">
          <header><div><small>MARKET MEMORY</small><h3>Recently scanned markets</h3></div></header>
          <div>
            {!rankedMarkets.length && <p>Market scores will appear after scanning.</p>}
            {rankedMarkets.map((item) => (
              <article key={item.symbol}>
                <strong>{item.label}</strong><span>{item.decision}</span><b>{item.confidence.toFixed(1)}%</b>
              </article>
            ))}
          </div>
        </section>

        <section className="quantumPanel quantumHistory">
          <header><div><small>TRADE JOURNAL</small><h3>Settled Quantum trades</h3></div></header>
          <div className="quantumHistoryTable">
            {!stats.history.length && <p>No settled trades yet.</p>}
            {stats.history.map((trade) => (
              <article
                key={`${trade.contractId}-${trade.settledAt}`}
                className="quantumAuditRow"
              >
                <div>
                  <strong>{trade.market}</strong>
                  <span>
                    {trade.recoveryTrade
                      ? `RECOVERY ${trade.recoveryAttempt} · X${trade.recoveryMultiplier || 2}`
                      : "NORMAL"}{" "}
                    · {trade.direction} ·{" "}
                    {Number(trade.stake || 0).toFixed(2)} USD
                  </span>
                </div>
                <div>
                  <span>Confidence</span>
                  <strong>
                    {Number(trade.confidence || 0).toFixed(1)}%
                  </strong>
                </div>
                <div>
                  <span>Entry metrics</span>
                  <strong>
                    V{" "}
                    {Number(
                      trade.entrySnapshot?.voteConsensus || 0
                    ).toFixed(0)}
                    % · N{" "}
                    {Number(
                      trade.entrySnapshot?.noiseScore || 0
                    ).toFixed(0)}
                    % · R{" "}
                    {Number(
                      trade.entrySnapshot?.reversalRisk || 0
                    ).toFixed(0)}
                    %
                  </strong>
                </div>
                <div>
                  <b
                    className={
                      trade.result === "WON"
                        ? "positive"
                        : "negative"
                    }
                  >
                    {trade.result}
                  </b>
                  <span>
                    {trade.outcomeCause?.code || "SETTLED"}
                  </span>
                </div>
                <div>
                  <strong>{money(trade.profit)} USD</strong>
                  <span>
                    {trade.outcomeCause?.label ||
                      "Trade settled."}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>

        <p className="quantumRiskNote">
          V14 learns from settled trades and uses capped x2 recovery,
          but past performance cannot guarantee future wins.
          Test on Demo before Real execution.
        </p>
      </main>
    </div>
  );
}





