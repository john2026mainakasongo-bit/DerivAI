import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeFreshEdge } from "../analysis/freshEdgeEngine";
import "../styles/FreshEdgeBot.css";

const STORAGE_KEY = "fresh-edge-ai-v7-learning-history";

const INITIAL_STATS = {
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  history: [],
};

function contractIdOf(value) {
  return String(
    value?.contractId ||
      value?.contract_id ||
      value?.buy?.contract_id ||
      value?.raw?.buy?.contract_id ||
      ""
  );
}

function contractKey(contract) {
  return String(
    contract?.contract_id ||
      contract?.contractId ||
      contract?.id ||
      ""
  );
}

function isSettled(contract) {
  return (
    contract?.is_sold === true ||
    contract?.is_sold === 1 ||
    contract?.is_expired === true ||
    contract?.is_expired === 1 ||
    ["WON", "LOST", "SOLD"].includes(
      String(contract?.status || "").toUpperCase()
    )
  );
}

function resultOf(contract) {
  const status = String(contract?.status || "").toUpperCase();
  const profit = Number(contract?.profit || 0);

  if (status === "WON" || profit > 0) return "WON";
  if (status === "LOST" || profit < 0) return "LOST";
  return profit >= 0 ? "WON" : "LOST";
}

function profitOf(contract, fallbackStake = 0.35) {
  const direct = Number(contract?.profit);
  if (Number.isFinite(direct)) return direct;

  const payout = Number(contract?.payout || 0);
  const buyPrice = Number(
    contract?.buy_price ||
      contract?.purchase_price ||
      fallbackStake
  );

  return payout - buyPrice;
}


function diagnoseFreshEdgeTrade(trade, result) {
  if (result === "WON") {
    return {
      code: "SETUP_HELD",
      summary: "Trend, votes and continuation held through expiry.",
      nextAction: "Keep the same thresholds; continue scanning fresh setups.",
    };
  }

  const confidence = Number(trade?.confidence || 0);
  const quality = Number(trade?.quality || 0);
  const noise = Number(trade?.noise || 0);
  const reversal = Number(trade?.reversalRisk || 0);
  const spike = Number(trade?.spikeRatio || 0);
  const continuation = Number(trade?.continuation || 0);
  const votes = Number(trade?.voteConsensus || 0);

  if (spike >= 4.5) {
    return {
      code: "SPIKE_ENTRY",
      summary: "A large tick spike weakened the expiry timing.",
      nextAction: "Block the market briefly and require a lower spike ratio.",
    };
  }

  if (reversal >= 58) {
    return {
      code: "REVERSAL_PRESSURE",
      summary: "Reversal pressure was already elevated at entry.",
      nextAction: "Require stronger continuation and avoid repeating that side.",
    };
  }

  if (noise >= 68) {
    return {
      code: "HIGH_NOISE",
      summary: "Noise was high enough to disrupt the short expiry.",
      nextAction: "Skip this market until noise drops.",
    };
  }

  if (votes < 62 || continuation < 60) {
    return {
      code: "WEAK_FOLLOW_THROUGH",
      summary: "The direction was correct briefly but follow-through was weak.",
      nextAction: "Raise vote/continuation requirements for the next setup.",
    };
  }

  if (confidence < 66 || quality < 62) {
    return {
      code: "MARGINAL_EDGE",
      summary: "The setup passed, but its safety margin was small.",
      nextAction: "Wait for a stronger fresh-tick setup on another market.",
    };
  }

  return {
    code: "EXPIRY_VARIANCE",
    summary: "A strong setup lost to short-term expiry variance.",
    nextAction: "Do not chase; move to a fresh market and rebuild the signal.",
  };
}


const EMPTY_LEARNING = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 50,
  confidenceAdjustment: 0,
  qualityAdjustment: 0,
  voteAdjustment: 0,
  continuationAdjustment: 0,
  weights: {
    quality: 0.42,
    votes: 0.22,
    continuation: 0.20,
    risk: 0.16,
  },
  causes: {
    SETUP_HELD: 0,
    SPIKE_ENTRY: 0,
    REVERSAL_PRESSURE: 0,
    HIGH_NOISE: 0,
    WEAK_FOLLOW_THROUGH: 0,
    MARGINAL_EDGE: 0,
    EXPIRY_VARIANCE: 0,
  },
  directions: {
    RISE: { trades: 0, wins: 0, rate: 50 },
    FALL: { trades: 0, wins: 0, rate: 50 },
  },
};

function buildFreshEdgeLearning(history = []) {
  const settled = Array.isArray(history)
    ? history.filter(
        (trade) =>
          trade?.result === "WON" ||
          trade?.result === "LOST"
      )
    : [];

  if (!settled.length) {
    return EMPTY_LEARNING;
  }

  const recent = settled.slice(0, 60);
  const wins = recent.filter(
    (trade) => trade.result === "WON"
  ).length;
  const losses = recent.length - wins;
  const winRate = (wins / recent.length) * 100;

  const causes = {
    ...EMPTY_LEARNING.causes,
  };

  const directions = {
    RISE: { trades: 0, wins: 0, rate: 50 },
    FALL: { trades: 0, wins: 0, rate: 50 },
  };

  let confidenceLossPressure = 0;
  let qualityLossPressure = 0;
  let voteLossPressure = 0;
  let continuationLossPressure = 0;

  recent.forEach((trade, index) => {
    const recencyWeight =
      1 - index / Math.max(80, recent.length * 1.5);
    const code =
      trade?.diagnosis?.code ||
      (trade.result === "WON"
        ? "SETUP_HELD"
        : "EXPIRY_VARIANCE");

    causes[code] = Number(causes[code] || 0) + 1;

    const side =
      trade.direction === "RISE" ? "RISE" : "FALL";
    directions[side].trades += 1;

    if (trade.result === "WON") {
      directions[side].wins += 1;
    } else {
      if (Number(trade.confidence || 0) < 68) {
        confidenceLossPressure += recencyWeight;
      }

      if (Number(trade.quality || 0) < 64) {
        qualityLossPressure += recencyWeight;
      }

      if (Number(trade.voteConsensus || 0) < 64) {
        voteLossPressure += recencyWeight;
      }

      if (Number(trade.continuation || 0) < 62) {
        continuationLossPressure += recencyWeight;
      }
    }
  });

  for (const side of ["RISE", "FALL"]) {
    directions[side].rate = directions[side].trades
      ? (directions[side].wins /
          directions[side].trades) *
        100
      : 50;
  }

  const lossBase = Math.max(1, losses);

  const confidenceAdjustment = Math.min(
    10,
    (confidenceLossPressure / lossBase) * 4
  );
  const qualityAdjustment = Math.min(
    8,
    (qualityLossPressure / lossBase) * 3
  );
  const voteAdjustment = Math.min(
    8,
    (voteLossPressure / lossBase) * 3
  );
  const continuationAdjustment = Math.min(
    8,
    (continuationLossPressure / lossBase) * 3
  );

  const normalize = (weights) => {
    const total = Object.values(weights).reduce(
      (sum, value) => sum + Number(value || 0),
      0
    );

    return Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [
        key,
        Number(value || 0) / Math.max(0.01, total),
      ])
    );
  };

  const weights = normalize({
    quality:
      0.42 +
      Math.min(0.10, qualityLossPressure * 0.012),
    votes:
      0.22 +
      Math.min(0.08, voteLossPressure * 0.010),
    continuation:
      0.20 +
      Math.min(
        0.10,
        continuationLossPressure * 0.012
      ),
    risk:
      0.16 +
      Math.min(
        0.12,
        (
          Number(causes.HIGH_NOISE || 0) +
          Number(causes.REVERSAL_PRESSURE || 0) +
          Number(causes.SPIKE_ENTRY || 0)
        ) *
          0.006
      ),
  });

  return {
    totalTrades: recent.length,
    wins,
    losses,
    winRate,
    confidenceAdjustment,
    qualityAdjustment,
    voteAdjustment,
    continuationAdjustment,
    weights,
    causes,
    directions,
  };
}


function freshEdgeRecoveryPolicy(code, settings) {
  switch (code) {
    case "SPIKE_ENTRY":
      return {
        action: "RAISE_CONFIRMATION",
        extraTicks: Number(
          settings.spikeRecoveryConfirmExtra || 1
        ),
        freshTicks: Number(settings.freshRecoveryTicks || 12) + 3,
        durationExtra: 0,
        description:
          "Require one more confirmation tick and rebuild on a new market.",
      };

    case "HIGH_NOISE":
      return {
        action: "WAIT_FOR_CALMER_MARKET",
        extraTicks: 0,
        freshTicks:
          Number(settings.freshRecoveryTicks || 12) +
          Number(settings.noiseRecoveryTickExtra || 4),
        durationExtra: 0,
        description:
          "Collect more fresh ticks and reject markets with elevated noise.",
      };

    case "REVERSAL_PRESSURE":
      return {
        action: "BLOCK_SAME_DIRECTION",
        extraTicks: 1,
        freshTicks:
          Number(settings.freshRecoveryTicks || 12) +
          Number(settings.reversalRecoveryTickExtra || 3),
        durationExtra: 0,
        description:
          "Avoid repeating the losing direction until a new market confirms.",
      };

    case "WEAK_FOLLOW_THROUGH":
      return {
        action: "RAISE_CONTINUATION",
        extraTicks: 1,
        freshTicks:
          Number(settings.freshRecoveryTicks || 12) +
          Number(settings.weakFollowRecoveryTickExtra || 2),
        durationExtra: 0,
        description:
          "Require stronger continuation and a fresh confirmation sequence.",
      };

    case "MARGINAL_EDGE":
      return {
        action: "RAISE_ENTRY_GATE",
        extraTicks: 1,
        freshTicks: Number(settings.freshRecoveryTicks || 12) + 2,
        durationExtra: 0,
        description:
          "Wait for a wider confidence and quality margin.",
      };

    case "EXPIRY_VARIANCE":
      return {
        action: "LONGER_EXPIRY",
        extraTicks: 0,
        freshTicks: Number(settings.freshRecoveryTicks || 12),
        durationExtra: Number(
          settings.expiryRecoveryDurationExtra || 10
        ),
        description:
          "Use fresh analysis and a slightly longer expiry only if requalified.",
      };

    default:
      return {
        action: "FRESH_REBUILD",
        extraTicks: 0,
        freshTicks: Number(settings.freshRecoveryTicks || 12),
        durationExtra: 0,
        description:
          "Forget the previous setup and rebuild from current ticks.",
      };
  }
}

function freshEdgeAdaptiveDurationV85(
  analysis,
  settings,
  recoveryPolicy,
  signalTrajectory
) {
  const confidence = Number(analysis.confidence || 0);
  const quality = Number(analysis.quality || 0);
  const momentum = Number(
    analysis.componentScores?.momentum || 0
  );
  const continuation = Number(
    analysis.continuation || 0
  );
  const noise = Number(analysis.noise || 0);
  const reversal = Number(
    analysis.reversalRisk || 0
  );

  const trajectoryHealthy =
    Boolean(signalTrajectory?.ready) &&
    Number(signalTrajectory?.momentumDrop || 0) <= 2.5 &&
    Number(signalTrajectory?.votesDrop || 0) <= 2.5 &&
    Number(
      signalTrajectory?.continuationDrop || 0
    ) <= 2.5;

  if (
    confidence >= 90 &&
    quality >= 82 &&
    momentum >= 85 &&
    continuation >= 86 &&
    noise <= 42 &&
    reversal <= 32 &&
    trajectoryHealthy
  ) {
    return Number(settings.durationFastSeconds || 12);
  }

  if (
    confidence >= 84 &&
    quality >= 75 &&
    momentum >= 76 &&
    continuation >= 80 &&
    noise <= 52 &&
    reversal <= 40 &&
    trajectoryHealthy
  ) {
    return Number(settings.durationStrongSeconds || 16);
  }

  if (
    confidence >= 78 &&
    quality >= 70 &&
    continuation >= 74 &&
    reversal <= 47
  ) {
    return Number(
      settings.durationBalancedSeconds || 22
    );
  }

  return Number(settings.durationPatientSeconds || 30);
}
export default function FreshEdgeBot() {
  const {
    markets,
    market,
    symbol,
    connected,
    authenticatedFeed,
    loadingMarket,
    prices,
    currentPrice,
    openContracts,
    tradeBusy,
    tradeError,
    connect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(
    "FreshEdge V8.5 is ready with stable timing and clean hook order."
  );
  const [settings, setSettings] = useState({
    stake: 0.35,
    duration: 20,
    durationUnit: "s",
    minimumTicks: 12,
    minimumConfidence: 69,
    minimumQuality: 60,
    minimumVotes: 62,
    minimumContinuation: 65,
    maximumNoise: 60,
    maximumReversal: 50,
    maximumSpikeRatio: 6,
    confirmationTicks: 2,
    maximumMarketSeconds: 8,
    decisionCycleSeconds: 20,
    oneMinuteTargetSeconds: 45,
    fastLaneAfterSeconds: 25,
    fastLaneMinimumConfidence: 66,
    fastLaneMinimumQuality: 57,
    durationFastSeconds: 12,
    durationNormalSeconds: 20,
    durationPatientSeconds: 30,
    durationStrongSeconds: 16,
    durationBalancedSeconds: 22,
    latencyEntryLimitMs: 1600,
    hardRiskHoldSeconds: 6,
    weakSetupHoldSeconds: 6,
    strongerMarketDelaySeconds: 5,
    strongerMarketMargin: 12,
    marketBlockSeconds: 15,
    maximumOpenTrades: 1,
    takeProfit: 2,
    stopLoss: 1.4,
    rankingTopMarkets: 5,
    rankingFreshnessSeconds: 20,
    rankingSwitchMargin: 2,
    rankingMinimumScore: 44,
    timelineLimit: 60,
    freshRecoveryTicks: 8,
    marketWarmupTicks: 6,
    minimumExpiryConfidence: 69,
    minimumExpiryQuality: 60,
    sameDirectionLossBlockSeconds: 18,
    recoveryMarketBlockSeconds: 20,
    replayLimit: 12,
    waitEstimateSeconds: 3,
    stabilityTicks: 3,
    trajectoryTicks: 4,
    minimumTrendAgeTicks: 5,
    maximumMomentumDrop: 6,
    maximumVotesDrop: 5,
    maximumContinuationDrop: 5,
    lossCooldownSeconds: 5,
    maximumConfidenceDrop: 3.5,
    minimumConfidenceGrowth: -0.5,
    scannerBoardMarkets: 8,
    scannerSnapshotSeconds: 45,
    lossLearningWindow: 20,
    replayTickLimit: 40,
    entryTickSnapshot: 12,
    latencyWarningMs: 800,
    spikeRecoveryConfirmExtra: 1,
    noiseRecoveryTickExtra: 4,
    reversalRecoveryTickExtra: 3,
    weakFollowRecoveryTickExtra: 2,
    expiryRecoveryDurationExtra: 10,
  });
  const [stats, setStats] = useState(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) || "null"
      );
      return saved || INITIAL_STATS;
    } catch {
      return INITIAL_STATS;
    }
  });
  const [confirmation, setConfirmation] = useState({
    key: "",
    ticks: 0,
  });
  const [blockedMarkets, setBlockedMarkets] = useState({});
  const [marketStartedAt, setMarketStartedAt] = useState(Date.now());
  const [marketScores, setMarketScores] = useState({});
  const [timeline, setTimeline] = useState([]);
  const [confidenceTrail, setConfidenceTrail] = useState([]);
  const [selectedReplayId, setSelectedReplayId] = useState("");

  const selectedReplay = useMemo(
    () =>
      stats.history.find(
        (item) =>
          `${item.contractId}-${item.settledAt}` ===
          selectedReplayId
      ) || null,
    [stats.history, selectedReplayId]
  );

  const [recoveryState, setRecoveryState] = useState({
    active: false,
    sourceSymbol: "",
    requiredTicks: 0,
    freshTicks: 0,
    cause: "",
    sourceDirection: "",
  });

  const buyingRef = useRef(false);
  const processedRef = useRef(new Set());
  const botContractsRef = useRef(new Map());
  const activeReplayTicksRef = useRef(new Map());
  const lastObservedPriceRef = useRef(null);
  const marketWarmupCountV85Ref = useRef(0);
  const lastLossDirectionV85Ref = useRef("");
  const lastLossDirectionUntilV85Ref = useRef(0);
  const lossCooldownUntilV85Ref = useRef(0);
  const hardRiskStartedAtRef = useRef(0);
  const weakSetupStartedAtRef = useRef(0);
  const lastEntryAttemptV87Ref = useRef(Date.now());
  const oneMinuteSwitchBusyV87Ref = useRef(false);

  const rapidPortfolioLastMoveV88Ref = useRef(Date.now());
  const rapidPortfolioBusyV88Ref = useRef(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(stats)
      );
    } catch {
      // Storage can be unavailable in private mode.
    }
  }, [stats]);


  const appendTimeline = useCallback(
    (type, detail, extra = {}) => {
      setTimeline((current) =>
        [
          {
            id: `${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}`,
            time: Date.now(),
            type,
            detail,
            symbol,
            ...extra,
          },
          ...current,
        ].slice(0, Number(settings.timelineLimit || 60))
      );
    },
    [symbol, settings.timelineLimit]
  );

  useEffect(() => {
    if (connected) {
      appendTimeline(
        "CONNECTED",
        authenticatedFeed
          ? "Authenticated Deriv feed ready."
          : "Public analysis feed ready."
      );
    }

    if (!connected) {
      void connect().catch((error) => {        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to connect."
        );
      });
    }
  }, [
    connected,
    connect,
    authenticatedFeed,
    appendTimeline,
  ]);

  const learning = useMemo(
    () => buildFreshEdgeLearning(stats.history),
    [stats.history]
  );

  const analysis = useMemo(
    () =>
      analyzeFreshEdge(
        prices,
        settings,
        learning
      ),
    [prices, settings, learning]
  );


  useEffect(() => {
    if (!symbol || !analysis.ready) return;

    setMarketScores((current) => ({
      ...current,
      [symbol]: {
        symbol,
        label: market?.label || symbol,
        score:
          Number(analysis.confidence || 0) * 0.42 +
          Number(analysis.quality || 0) * 0.28 +
          Number(analysis.continuation || 0) * 0.18 +
          Number(analysis.voteConsensus || 0) * 0.12,
        confidence: Number(analysis.confidence || 0),
        quality: Number(analysis.quality || 0),
        votes: Number(analysis.voteConsensus || 0),
        continuation: Number(analysis.continuation || 0),
        noise: Number(analysis.noise || 0),
        reversal: Number(analysis.reversalRisk || 0),
        direction: analysis.direction || "WAIT",
        updatedAt: Date.now(),
      },
    }));
  }, [
    symbol,
    market?.label,
    analysis.ready,
    analysis.confidence,
    analysis.quality,
    analysis.continuation,
    analysis.voteConsensus,
    analysis.noise,
    analysis.reversalRisk,
    analysis.direction,
  ]);

  const rankedMarkets = useMemo(
    () =>
      Object.values(marketScores)
        .filter(
          (item) =>
            item?.symbol &&
            Date.now() - Number(item.updatedAt || 0) <=
              Number(settings.rankingFreshnessSeconds || 20) *
                1000 &&
            Number(item.score || 0) >=
              Number(settings.rankingMinimumScore || 48)
        )
        .sort(
          (a, b) =>
            Number(b.score || 0) -
            Number(a.score || 0)
        )
        .slice(
          0,
          Math.max(
            1,
            Number(settings.rankingTopMarkets || 5)
          )
        ),
    [
      marketScores,
      settings.rankingFreshnessSeconds,
      settings.rankingMinimumScore,
      settings.rankingTopMarkets,
      currentPrice,
    ]
  );

  const scannerBoard = useMemo(() => {
    const now = Date.now();

    return Object.values(marketScores)
      .filter(
        (item) =>
          item?.symbol &&
          now - Number(item.updatedAt || 0) <=
            Number(settings.scannerSnapshotSeconds || 45) *
              1000
      )
      .map((item) => {
        const reasons = [];

        if (!item.direction || item.direction === "WAIT") {
          reasons.push("mixed direction");
        }

        if (
          Number(item.confidence || 0) <
          Number(settings.minimumConfidence || 59)
        ) {
          reasons.push("low confidence");
        }

        if (
          Number(item.quality || 0) <
          Number(settings.minimumQuality || 55)
        ) {
          reasons.push("low quality");
        }

        if (
          Number(item.votes || 0) <
          Number(settings.minimumVotes || 55)
        ) {
          reasons.push("weak votes");
        }

        if (
          Number(item.continuation || 0) <
          Number(settings.minimumContinuation || 53)
        ) {
          reasons.push("weak continuation");
        }

        if (
          Number(item.noise || 0) >=
          Number(settings.maximumNoise || 76)
        ) {
          reasons.push("high noise");
        }

        if (
          Number(item.reversal || 0) >=
          Number(settings.maximumReversal || 70)
        ) {
          reasons.push("reversal risk");
        }

        return {
          ...item,
          status: reasons.length ? "REJECTED" : "CANDIDATE",
          rejectionReason:
            reasons.join(", ") || "fresh setup passed",
        };
      })
      .sort(
        (a, b) =>
          Number(b.score || 0) -
          Number(a.score || 0)
      )
      .slice(
        0,
        Math.max(
          1,
          Number(settings.scannerBoardMarkets || 8)
        )
      );
  }, [
    marketScores,
    settings.scannerSnapshotSeconds,
    settings.scannerBoardMarkets,
    settings.minimumConfidence,
    settings.minimumQuality,
    settings.minimumVotes,
    settings.minimumContinuation,
    settings.maximumNoise,
    settings.maximumReversal,
    currentPrice,
  ]);

  const confidenceStability = useMemo(() => {
    const requiredTicks = Math.max(
      2,
      Number(settings.stabilityTicks || 3)
    );
    const points = confidenceTrail.slice(-requiredTicks);

    if (points.length < requiredTicks) {
      return {
        ready: false,
        trend: 0,
        drop: 0,
        reason: `Collecting stability ${points.length}/${requiredTicks}.`,
      };
    }

    const first = Number(points[0]?.confidence || 0);
    const last = Number(points.at(-1)?.confidence || 0);
    const trend = last - first;

    let maximumDrop = 0;

    for (let index = 1; index < points.length; index += 1) {
      const previous = Number(
        points[index - 1]?.confidence || 0
      );
      const current = Number(
        points[index]?.confidence || 0
      );

      maximumDrop = Math.max(
        maximumDrop,
        previous - current
      );
    }

    const ready =
      maximumDrop <=
        Number(settings.maximumConfidenceDrop || 3.5) &&
      trend >=
        Number(settings.minimumConfidenceGrowth || -0.5);

    return {
      ready,
      trend,
      drop: maximumDrop,
      reason: ready
        ? `Stable ${trend >= 0 ? "+" : ""}${trend.toFixed(
            1
          )}% Â· max drop ${maximumDrop.toFixed(1)}%.`
        : `Confidence unstable: trend ${trend.toFixed(
            1
          )}% Â· max drop ${maximumDrop.toFixed(1)}%.`,
    };
  }, [
    confidenceTrail,
    settings.stabilityTicks,
    settings.maximumConfidenceDrop,
    settings.minimumConfidenceGrowth,
  ]);

  const signalTrajectoryV85 = useMemo(() => {
    const trajectoryTicks = Math.max(
      4,
      Number(settings.trajectoryTicks || 6)
    );

    const requiredTrendAge = Math.max(
      trajectoryTicks,
      Number(settings.minimumTrendAgeTicks || 8)
    );

    const trajectoryPoints =
      confidenceTrail.slice(-trajectoryTicks);

    const agePoints =
      confidenceTrail.slice(-requiredTrendAge);

    if (
      trajectoryPoints.length < trajectoryTicks ||
      agePoints.length < requiredTrendAge
    ) {
      return {
        ready: false,
        trendAge: agePoints.length,
        momentumDrop: 0,
        votesDrop: 0,
        continuationDrop: 0,
        reason:
          `Building trend age ${agePoints.length}/${requiredTrendAge} ticks.`,
      };
    }

    const direction = analysis.direction;

    const sameDirectionTicks = agePoints.filter(
      (point) =>
        point.direction === direction &&
        direction &&
        direction !== "WAIT"
    ).length;

    const first = trajectoryPoints[0] || {};
    const last = trajectoryPoints.at(-1) || {};

    const momentumDrop = Math.max(
      0,
      Number(first.momentum || 0) -
        Number(last.momentum || 0)
    );

    const votesDrop = Math.max(
      0,
      Number(first.votes || 0) -
        Number(last.votes || 0)
    );

    const continuationDrop = Math.max(
      0,
      Number(first.continuation || 0) -
        Number(last.continuation || 0)
    );

    const directionStable =
      sameDirectionTicks >= requiredTrendAge - 1;

    const metricsStable =
      momentumDrop <=
        Number(settings.maximumMomentumDrop || 6) &&
      votesDrop <=
        Number(settings.maximumVotesDrop || 5) &&
      continuationDrop <=
        Number(
          settings.maximumContinuationDrop || 5
        );

    const ready =
      Boolean(direction) &&
      direction !== "WAIT" &&
      directionStable &&
      metricsStable;

    return {
      ready,
      trendAge: sameDirectionTicks,
      momentumDrop,
      votesDrop,
      continuationDrop,
      reason: ready
        ? `Trend held ${sameDirectionTicks}/${requiredTrendAge} ticks; trajectory is stable.`
        : `Entry blocked: trend ${sameDirectionTicks}/${requiredTrendAge}, momentum drop ${momentumDrop.toFixed(
            1
          )}, votes drop ${votesDrop.toFixed(
            1
          )}, continuation drop ${continuationDrop.toFixed(
            1
          )}.`,
    };
  }, [
    confidenceTrail,
    analysis.direction,
    settings.trajectoryTicks,
    settings.minimumTrendAgeTicks,
    settings.maximumMomentumDrop,
    settings.maximumVotesDrop,
    settings.maximumContinuationDrop,
  ]);
  const entryTimingGuardV85 = useMemo(() => {
    const requiredWarmup = Math.max(
      6,
      Number(settings.marketWarmupTicks || 10)
    );

    const warmupCount =
      marketWarmupCountV85Ref.current;

    const warmupReady =
      warmupCount >= requiredWarmup;

    const confidenceReady =
      Number(analysis.confidence || 0) >=
      Number(settings.minimumExpiryConfidence || 78);

    const qualityReady =
      Number(analysis.quality || 0) >=
      Number(settings.minimumExpiryQuality || 70);

    const sameDirectionBlocked =
      Date.now() <
        Number(
          lastLossDirectionUntilV85Ref.current || 0
        ) &&
      analysis.direction ===
        lastLossDirectionV85Ref.current;

    const latestTrade = stats.history[0];

    const latencyBlocked =
      Number(latestTrade?.orderLatencyMs || 0) >
        Number(settings.latencyEntryLimitMs || 1600) &&
      Date.now() -
        Number(latestTrade?.settledAt || 0) <
        30000;

    return {
      ready:
        warmupReady &&
        confidenceReady &&
        qualityReady &&
        !sameDirectionBlocked &&
        !latencyBlocked,
      warmupReady,
      confidenceReady,
      qualityReady,
      sameDirectionBlocked,
      latencyBlocked,
      warmupCount,
      requiredWarmup,
    };
  }, [
    currentPrice,
    analysis.confidence,
    analysis.quality,
    analysis.direction,
    stats.history,
    settings.marketWarmupTicks,
    settings.minimumExpiryConfidence,
    settings.minimumExpiryQuality,
    settings.latencyEntryLimitMs,
  ]);

  const expiryQualifiedV85 = useMemo(
    () =>
      Number(analysis.confidence || 0) >=
        Number(settings.minimumExpiryConfidence || 78) &&
      Number(analysis.quality || 0) >=
        Number(settings.minimumExpiryQuality || 70) &&
      Number(analysis.continuation || 0) >= 72 &&
      Number(analysis.noise || 100) <= 60 &&
      Number(analysis.reversalRisk || 100) <= 50,
    [
      analysis.confidence,
      analysis.quality,
      analysis.continuation,
      analysis.noise,
      analysis.reversalRisk,
      settings.minimumExpiryConfidence,
      settings.minimumExpiryQuality,
    ]
  );
  const waitReasons = useMemo(() => {
    const thresholds = analysis.adaptiveThresholds || {};
    const reasons = [];

    if (!analysis.ready) {
      reasons.push({
        label: "Fresh ticks",
        pass: false,
        detail: analysis.reason,
      });
      return reasons;
    }

    reasons.push(
      {
        label: "EMA structure",
        pass: Boolean(analysis.direction),
        detail: analysis.direction
          ? `${analysis.direction} aligned`
          : "mixed",
      },
      {
        label: "Confidence",
        pass:
          Number(analysis.confidence || 0) >=
          Number(thresholds.confidence || settings.minimumConfidence),
        detail: `${Number(analysis.confidence || 0).toFixed(1)} / ${Number(
          thresholds.confidence || settings.minimumConfidence
        ).toFixed(1)}%`,
      },
      {
        label: "Quality",
        pass:
          Number(analysis.quality || 0) >=
          Number(thresholds.quality || settings.minimumQuality),
        detail: `${Number(analysis.quality || 0).toFixed(1)} / ${Number(
          thresholds.quality || settings.minimumQuality
        ).toFixed(1)}%`,
      },
      {
        label: "Votes",
        pass:
          Number(analysis.voteConsensus || 0) >=
          Number(thresholds.votes || settings.minimumVotes),
        detail: `${Number(analysis.voteConsensus || 0).toFixed(1)} / ${Number(
          thresholds.votes || settings.minimumVotes
        ).toFixed(1)}%`,
      },
      {
        label: "Continuation",
        pass:
          Number(analysis.continuation || 0) >=
          Number(thresholds.continuation || settings.minimumContinuation),
        detail: `${Number(analysis.continuation || 0).toFixed(1)} / ${Number(
          thresholds.continuation || settings.minimumContinuation
        ).toFixed(1)}%`,
      },
      {
        label: "Noise safety",
        pass: Number(analysis.noise || 0) < Number(settings.maximumNoise),
        detail: `${Number(analysis.noise || 0).toFixed(1)} / max ${settings.maximumNoise}%`,
      },
      {
        label: "Reversal safety",
        pass:
          Number(analysis.reversalRisk || 0) <
          Number(settings.maximumReversal),
        detail: `${Number(analysis.reversalRisk || 0).toFixed(1)} / max ${settings.maximumReversal}%`,
      },
      {
        label: "Confidence stability",
        pass: confidenceStability.ready,
        detail: confidenceStability.reason,
      },
      {
        label: "Warm-up and expiry guard",
        pass:
          entryTimingGuardV85.ready &&
          expiryQualifiedV85,
        detail: !entryTimingGuardV85.warmupReady
          ? `Building fresh ticks ${entryTimingGuardV85.warmupCount}/${entryTimingGuardV85.requiredWarmup}.`
          : entryTimingGuardV85.sameDirectionBlocked
          ? "Previous losing direction is temporarily blocked."
          : entryTimingGuardV85.latencyBlocked
          ? "Recent API response latency is above the entry limit."
          : !expiryQualifiedV85
          ? "Signal does not qualify for a safe short expiry."
          : "Warm-up and expiry checks passed.",
      },
      {
        label: "Trend trajectory V8.5",
        pass: signalTrajectoryV85.ready,
        detail: signalTrajectoryV85.reason,
      }
    );

    return reasons;
  }, [
    analysis,
    settings,
    confidenceStability,
    signalTrajectoryV85,
    entryTimingGuardV85,
    expiryQualifiedV85,
  ]);

  const missingWaitReasons = waitReasons.filter((item) => !item.pass);

  useEffect(() => {
    if (!Number.isFinite(Number(analysis.confidence))) return;

    setConfidenceTrail((current) =>
      [
        ...current,
        {
          time: Date.now(),
          confidence: Number(analysis.confidence || 0),
          quality: Number(analysis.quality || 0),
          momentum: Number(
            analysis.componentScores?.momentum || 0
          ),
          votes: Number(analysis.voteConsensus || 0),
          continuation: Number(analysis.continuation || 0),
          noise: Number(analysis.noise || 0),
          reversal: Number(analysis.reversalRisk || 0),
          direction: analysis.direction || "WAIT",
        },
      ].slice(-20)
    );
  }, [
    currentPrice,
    analysis.confidence,
    analysis.quality,
    analysis.componentScores?.momentum,
    analysis.voteConsensus,
    analysis.continuation,
    analysis.noise,
    analysis.reversalRisk,
    analysis.direction,
  ]);

  useEffect(() => {
    if (!recoveryState.active) return;

    setRecoveryState((current) => ({
      ...current,
      freshTicks:
        symbol === current.sourceSymbol
          ? 0
          : Math.min(
              current.requiredTicks,
              Number(current.freshTicks || 0) + 1
            ),
    }));
  }, [currentPrice, symbol, recoveryState.active]);

  const recoveryPolicy = useMemo(
    () =>
      freshEdgeRecoveryPolicy(
        recoveryState.cause,
        settings
      ),
    [recoveryState.cause, settings]
  );

  const adaptiveDurationV85 = useMemo(
    () =>
      Math.max(
        10,
        Math.min(
          30,
          freshEdgeAdaptiveDurationV85(
            analysis,
            settings,
            recoveryState.active
              ? recoveryPolicy
              : null,
            signalTrajectoryV85
          )
        )
      ),
    [
      analysis,
      settings,
      recoveryState.active,
      recoveryPolicy,
      signalTrajectoryV85,
    ]
  );
  const recoveryReady =
    !recoveryState.active ||
    (
      symbol !== recoveryState.sourceSymbol &&
      recoveryState.freshTicks >= recoveryState.requiredTicks &&
      !(
        recoveryPolicy.action === "BLOCK_SAME_DIRECTION" &&
        analysis.direction === recoveryState.sourceDirection
      )
    );



  useEffect(() => {
    const numericPrice = Number(currentPrice);

    if (!Number.isFinite(numericPrice)) return;
    if (lastObservedPriceRef.current === numericPrice) return;

    lastObservedPriceRef.current = numericPrice;

    marketWarmupCountV85Ref.current = Math.min(
      999,
      marketWarmupCountV85Ref.current + 1
    );

    for (const [contractId, trade] of botContractsRef.current.entries()) {
      if (trade.symbol !== symbol) continue;

      const current =
        activeReplayTicksRef.current.get(contractId) || [];

      activeReplayTicksRef.current.set(
        contractId,
        [
          ...current,
          {
            time: Date.now(),
            price: numericPrice,
            confidence: Number(analysis.confidence || 0),
            quality: Number(analysis.quality || 0),
            continuation: Number(analysis.continuation || 0),
            noise: Number(analysis.noise || 0),
            reversal: Number(analysis.reversalRisk || 0),
            direction: analysis.direction || "WAIT",
          },
        ].slice(
          -Math.max(
            10,
            Number(settings.replayTickLimit || 40)
          )
        )
      );
    }
  }, [
    currentPrice,
    symbol,
    analysis.confidence,
    analysis.quality,
    analysis.continuation,
    analysis.noise,
    analysis.reversalRisk,
    analysis.direction,
    settings.replayTickLimit,
  ]);


  const directionHeatmap = useMemo(() => {
    const riseHistory =
      learning.directions.RISE.rate;
    const fallHistory =
      learning.directions.FALL.rate;

    const liveRise =
      analysis.direction === "RISE"
        ? analysis.confidence
        : Math.max(
            0,
            100 - analysis.confidence
          );

    const liveFall =
      analysis.direction === "FALL"
        ? analysis.confidence
        : Math.max(
            0,
            100 - analysis.confidence
          );

    return {
      RISE:
        liveRise * 0.72 +
        riseHistory * 0.28,
      FALL:
        liveFall * 0.72 +
        fallHistory * 0.28,
    };
  }, [
    analysis.direction,
    analysis.confidence,
    learning.directions,
  ]);

  const learningChanges = useMemo(
    () => [
      {
        label: "Confidence gate",
        base: Number(settings.minimumConfidence || 0),
        learned: Number(
          analysis.adaptiveThresholds?.confidence ||
            settings.minimumConfidence ||
            0
        ),
      },
      {
        label: "Quality gate",
        base: Number(settings.minimumQuality || 0),
        learned: Number(
          analysis.adaptiveThresholds?.quality ||
            settings.minimumQuality ||
            0
        ),
      },
      {
        label: "Votes gate",
        base: Number(settings.minimumVotes || 0),
        learned: Number(
          analysis.adaptiveThresholds?.votes ||
            settings.minimumVotes ||
            0
        ),
      },
      {
        label: "Continuation gate",
        base: Number(settings.minimumContinuation || 0),
        learned: Number(
          analysis.adaptiveThresholds?.continuation ||
            settings.minimumContinuation ||
            0
        ),
      },
    ],
    [
      settings.minimumConfidence,
      settings.minimumQuality,
      settings.minimumVotes,
      settings.minimumContinuation,
      analysis.adaptiveThresholds,
    ]
  );

  const dominantLossCause = useMemo(() => {
    const entries = Object.entries(learning.causes || {})
      .filter(([code]) => code !== "SETUP_HELD")
      .sort(
        (a, b) =>
          Number(b[1] || 0) -
          Number(a[1] || 0)
      );

    return entries[0]?.[1]
      ? {
          code: entries[0][0],
          count: Number(entries[0][1] || 0),
        }
      : {
          code: "NONE",
          count: 0,
        };
  }, [learning.causes]);

  const activeBotTrades = useMemo(
    () =>
      openContracts.filter((contract) =>
        botContractsRef.current.has(contractKey(contract))
      ),
    [openContracts]
  );

  const sessionStopped =
    stats.profit >= Number(settings.takeProfit) ||
    stats.profit <= -Math.abs(Number(settings.stopLoss));

  useEffect(() => {
    if (!running || sessionStopped) return;

    const key = [
      symbol,
      analysis.direction,
      Math.round(analysis.confidence),
      Math.round(analysis.quality),
    ].join("|");

    if (
      analysis.decision === "BUY" &&
      analysis.direction
    ) {
      const nextConfirmationTicks =
        confirmation.key === key
          ? Math.min(
              Number(settings.confirmationTicks),
              Number(confirmation.ticks || 0) + 1
            )
          : 1;

      setConfirmation({
        key,
        ticks: nextConfirmationTicks,
      });

      appendTimeline(
        "SIGNAL",
        `${analysis.direction} candidate ${analysis.confidence.toFixed(
          1
        )}% Â· confirmation ${nextConfirmationTicks}/${
          settings.confirmationTicks
        }.`,
        {
          direction: analysis.direction,
          confidence: analysis.confidence,
        }
      );
    } else {
      setConfirmation({ key: "", ticks: 0 });
    }
  }, [
    running,
    sessionStopped,
    symbol,
    currentPrice,
    analysis.decision,
    analysis.direction,
    analysis.confidence,
    analysis.quality,
    settings.confirmationTicks,
    confirmation.ticks,
    appendTimeline,
  ]);

  const switchMarket = useCallback(
    async (reason) => {
      if (markets.length < 2 || loadingMarket) return;

      const now = Date.now();
      const available = markets.filter(
        (item) =>
          item.id !== symbol &&
          Number(blockedMarkets[item.id] || 0) <= now
      );

      const rankedNext = rankedMarkets.find(
        (item) =>
          item.symbol !== symbol &&
          Number(blockedMarkets[item.symbol] || 0) <= now
      );

      const fallback =
        available[0] ||
        markets.find((item) => item.id !== symbol);

      const nextSymbol =
        rankedNext?.symbol || fallback?.id;
      const nextLabel =
        rankedNext?.label ||
        fallback?.label ||
        nextSymbol;

      if (!nextSymbol) return;

      setMessage(`${reason} Switching to ${nextLabel}.`);
      appendTimeline(
        "SWITCH",
        `${reason} ${symbol} â†’ ${nextLabel}.`,
        {
          from: symbol,
          to: nextSymbol,
        }
      );
      setConfirmation({ key: "", ticks: 0 });
      hardRiskStartedAtRef.current = 0;
      weakSetupStartedAtRef.current = 0;
      marketWarmupCountV85Ref.current = 0;
      setMarketStartedAt(Date.now());

      await changeSymbol(nextSymbol);
    },
    [
      markets,
      loadingMarket,
      symbol,
      blockedMarkets,
      rankedMarkets,
      appendTimeline,
      changeSymbol,
    ]
  );

  useEffect(() => {
    if (
      !running ||
      loadingMarket ||
      activeBotTrades.length ||
      markets.length < 2
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      const elapsed =
        (Date.now() - marketStartedAt) / 1000;

      const hardRisk =
        analysis.ready &&
        (
          analysis.noise >= settings.maximumNoise ||
          analysis.reversalRisk >=
            settings.maximumReversal ||
          analysis.spikeRatio >=
            settings.maximumSpikeRatio
        );

      const now = Date.now();
      const currentScore =
        Number(marketScores?.[symbol]?.score || 0);
      const bestRanked = rankedMarkets[0];

      const strongerRanked =
        bestRanked &&
        bestRanked.symbol !== symbol &&
        Number(bestRanked.score || 0) -
          currentScore >=
          Number(settings.strongerMarketMargin || 8);

      const weakFreshSetup =
        analysis.ready &&
        analysis.confidence < 45 &&
        analysis.quality < 45;

      if (hardRisk) {
        if (!hardRiskStartedAtRef.current) {
          hardRiskStartedAtRef.current = now;
        }
      } else {
        hardRiskStartedAtRef.current = 0;
      }

      if (weakFreshSetup) {
        if (!weakSetupStartedAtRef.current) {
          weakSetupStartedAtRef.current = now;
        }
      } else {
        weakSetupStartedAtRef.current = 0;
      }

      const hardRiskDuration =
        hardRiskStartedAtRef.current
          ? (now - hardRiskStartedAtRef.current) / 1000
          : 0;

      const weakSetupDuration =
        weakSetupStartedAtRef.current
          ? (now - weakSetupStartedAtRef.current) / 1000
          : 0;

      if (
        strongerRanked &&
        elapsed >=
          Number(settings.strongerMarketDelaySeconds || 6)
      ) {
        hardRiskStartedAtRef.current = 0;
        weakSetupStartedAtRef.current = 0;

        void switchMarket(
          `Materially stronger market found (${Number(
            bestRanked.score || 0
          ).toFixed(1)} vs ${currentScore.toFixed(1)}).`
        );
      } else if (
        hardRisk &&
        hardRiskDuration >=
          Number(settings.hardRiskHoldSeconds || 12)
      ) {
        hardRiskStartedAtRef.current = 0;
        weakSetupStartedAtRef.current = 0;

        void switchMarket(
          "Risk remained high after patient confirmation."
        );
      } else if (
        weakFreshSetup &&
        weakSetupDuration >=
          Number(settings.weakSetupHoldSeconds || 10)
      ) {
        hardRiskStartedAtRef.current = 0;
        weakSetupStartedAtRef.current = 0;

        void switchMarket(
          "Confidence and quality remained weak."
        );
      } else if (
        elapsed >=
          Number(settings.decisionCycleSeconds || 55)
      ) {
        hardRiskStartedAtRef.current = 0;
        weakSetupStartedAtRef.current = 0;

        void switchMarket(
          "55-second fresh decision cycle ended without a safe entry."
        );
      } else if (
        elapsed >= Number(settings.maximumMarketSeconds)
      ) {
        hardRiskStartedAtRef.current = 0;
        weakSetupStartedAtRef.current = 0;

        void switchMarket(
          "No confirmed entry after patient scan."
        );
      } else if (hardRisk) {
        setMessage(
          `High risk detected. Holding ${symbol} for fresh confirmation (${hardRiskDuration.toFixed(
            1
          )}/${Number(
            settings.hardRiskHoldSeconds || 12
          )}s).`
        );
      } else if (weakFreshSetup) {
        setMessage(
          `Weak setup. Continuing current-market scan (${weakSetupDuration.toFixed(
            1
          )}/${Number(
            settings.weakSetupHoldSeconds || 10
          )}s).`
        );
      }
    }, 150);

    return () => window.clearInterval(timer);
  }, [
    running,
    loadingMarket,
    activeBotTrades.length,
    markets.length,
    marketStartedAt,
    analysis,
    settings.maximumNoise,
    settings.maximumReversal,
    settings.maximumSpikeRatio,
    settings.maximumMarketSeconds,
    settings.decisionCycleSeconds,
    settings.hardRiskHoldSeconds,
    settings.weakSetupHoldSeconds,
    settings.strongerMarketDelaySeconds,
    settings.strongerMarketMargin,
    marketScores,
    rankedMarkets,
    switchMarket,
  ]);

  useEffect(() => {
    if (
      !running ||
      sessionStopped ||
      !authenticatedFeed ||
      !recoveryReady ||
      !confidenceStability.ready ||
      !entryTimingGuardV85.ready ||
      !expiryQualifiedV85 ||
      !signalTrajectoryV85.ready ||
      Date.now() < lossCooldownUntilV85Ref.current ||
      tradeBusy ||
      buyingRef.current ||
      activeBotTrades.length >=
        Number(settings.maximumOpenTrades) ||
      confirmation.ticks <
        (
          Number(settings.confirmationTicks) +
          (
            recoveryState.active
              ? Number(recoveryPolicy.extraTicks || 0)
              : 0
          )
        ) ||
      analysis.decision !== "BUY" ||
      !analysis.direction
    ) {
      return;
    }

    buyingRef.current = true;

    void (async () => {
      try {
        const contractType =
          analysis.direction === "RISE"
            ? "CALL"
            : "PUT";

        const orderSentAt = performance.now();
        const wallClockSentAt = Date.now();

        const response = await placeTrade({
          contractType,
          amount: Math.max(
            0.35,
            Number(settings.stake || 0.35)
          ),
          basis: "stake",
          duration: adaptiveDurationV85,
          durationUnit: settings.durationUnit || "s",
          symbol,
        });

        const orderResponseAt = performance.now();
        const orderLatencyMs = Math.max(
          0,
          orderResponseAt - orderSentAt
        );

        const contractId = contractIdOf(response);

        if (!contractId) {
          throw new Error(
            "Deriv did not return a contract ID."
          );
        }

        botContractsRef.current.set(contractId, {
          contractId,
          symbol,
          market: market?.label || symbol,
          direction: analysis.direction,
          confidence: analysis.confidence,
          quality: analysis.quality,
          noise: analysis.noise,
          reversalRisk: analysis.reversalRisk,
          continuation: analysis.continuation,
          voteConsensus: analysis.voteConsensus,
          spikeRatio: analysis.spikeRatio,
          entryReasons: analysis.entryReasons || [],
          adaptiveThresholds:
            analysis.adaptiveThresholds || {},
          learnedWeights:
            analysis.learnedWeights || {},
          learningTrades:
            learning.totalTrades,
          entryTimeline: timeline.slice(0, 12),
          confidenceTrail: confidenceTrail.slice(-12),
          waitReasons: waitReasons.map((item) => ({ ...item })),
          recoveryEntry: recoveryState.active,
          stabilityAtEntry: {
            trend: confidenceStability.trend,
            maximumDrop: confidenceStability.drop,
            ready: confidenceStability.ready,
          },
          scannerRankAtEntry:
            rankedMarkets.findIndex(
              (item) => item.symbol === symbol
            ) + 1,
          adaptiveDurationAtEntry: adaptiveDurationV85,
          decisionAgeSeconds:
            (Date.now() - marketStartedAt) / 1000,
          entryPrice: Number(currentPrice),
          entryTickSnapshot: prices
            .slice(
              -Math.max(
                4,
                Number(settings.entryTickSnapshot || 12)
              )
            )
            .map((price, index) => ({
              index,
              price: Number(price),
            })),
          recoveryPolicyAtEntry:
            recoveryState.active
              ? { ...recoveryPolicy }
              : null,
          orderSentAt: wallClockSentAt,
          orderLatencyMs,
          openedAt: Date.now(),
          stake: Number(settings.stake || 0.35),
        });

        activeReplayTicksRef.current.set(
          contractId,
          []
        );

        setMessage(
          `${analysis.direction} opened on ${market?.label || symbol} at ${analysis.confidence.toFixed(
            1
          )}% confidence Â· order response ${orderLatencyMs.toFixed(
            0
          )}ms.`
        );
        appendTimeline(
          "OPEN",
          `${analysis.direction} opened Â· C ${analysis.confidence.toFixed(
            1
          )}% Â· Q ${analysis.quality.toFixed(
            1
          )}% Â· order response ${orderLatencyMs.toFixed(
            0
          )}ms.`,
          {
            contractId,
            direction: analysis.direction,
          }
        );
        // FreshEdge V8.7 entry activity
        lastEntryAttemptV87Ref.current = Date.now();
        setConfirmation({ key: "", ticks: 0 });
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Trade failed."
        );
      } finally {
        buyingRef.current = false;
      }
    })();
  }, [
    running,
    sessionStopped,
    authenticatedFeed,
    tradeBusy,
    activeBotTrades.length,
    confirmation.ticks,
    analysis,
    settings.maximumOpenTrades,
    settings.confirmationTicks,
    settings.stake,
    settings.duration,
    settings.durationUnit,
    symbol,
    market?.label,
    appendTimeline,
    recoveryReady,
    confidenceStability.ready,
    recoveryState,
    recoveryPolicy,
    currentPrice,
    prices,
    timeline,
    confidenceTrail,
    waitReasons,
    adaptiveDurationV85,
    entryTimingGuardV85,
    expiryQualifiedV85,
    signalTrajectoryV85,
    marketStartedAt,
    stats.history,
    settings.latencyEntryLimitMs,
    placeTrade,
  ]);

  // FreshEdge V8.7 one-minute watchdog.
  // It targets one qualified opportunity per minute without forcing
  // a random trade when risk remains unsafe.
  useEffect(() => {
    if (
      !running ||
      sessionStopped ||
      activeBotTrades.length > 0 ||
      tradeBusy ||
      buyingRef.current ||
      !markets.length
    ) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      const idleMs =
        Date.now() -
        Number(
          lastEntryAttemptV87Ref.current ||
          marketStartedAt ||
          Date.now()
        );

      const fastLaneMs =
        Number(
          settings.fastLaneAfterSeconds || 42
        ) * 1000;

      const hardTargetMs =
        Number(
          settings.oneMinuteTargetSeconds || 60
        ) * 1000;

      const riskAcceptable =
        Number(analysis.noise || 100) <=
          Number(settings.maximumNoise || 60) &&
        Number(analysis.reversalRisk || 100) <=
          Number(settings.maximumReversal || 50);

      const fastLaneQualified =
        Boolean(analysis.ready) &&
        Boolean(analysis.direction) &&
        analysis.direction !== "WAIT" &&
        riskAcceptable &&
        Number(analysis.confidence || 0) >=
          Number(
            settings.fastLaneMinimumConfidence || 66
          ) &&
        Number(analysis.quality || 0) >=
          Number(
            settings.fastLaneMinimumQuality || 57
          ) &&
        Number(analysis.voteConsensus || 0) >= 58 &&
        Number(analysis.continuation || 0) >= 60;

      if (
        idleMs >= fastLaneMs &&
        fastLaneQualified
      ) {
        setConfirmation((current) => ({
          key:
            current.key ||
            `${symbol}:${analysis.direction}:V87`,
          ticks: Math.max(
            Number(current.ticks || 0),
            Number(settings.confirmationTicks || 2)
          ),
        }));

        setMessage(
          `FreshEdge V8.7 fast lane ready after ${Math.floor(
            idleMs / 1000
          )}s. Executing only if all live entry guards remain clear.`
        );

        lastEntryAttemptV87Ref.current =
          Date.now();
        return;
      }

      if (
        idleMs >= hardTargetMs &&
        !oneMinuteSwitchBusyV87Ref.current
      ) {
        oneMinuteSwitchBusyV87Ref.current = true;

        const ranked = Object.values(
          marketScores || {}
        )
          .filter(
            (item) =>
              item?.symbol &&
              item.symbol !== symbol &&
              Date.now() -
                Number(item.updatedAt || 0) <
                120000
          )
          .sort(
            (a, b) =>
              Number(b.score || 0) -
              Number(a.score || 0)
          );

        const currentIndex = Math.max(
          0,
          markets.findIndex(
            (item) => item.id === symbol
          )
        );

        const nextSymbol =
          ranked[0]?.symbol ||
          markets[
            (currentIndex + 1) %
              markets.length
          ]?.id;

        setConfirmation({
          key: "",
          ticks: 0,
        });
        hardRiskStartedAtRef.current = 0;
        weakSetupStartedAtRef.current = 0;
        setConfidenceTrail([]);
        setMarketStartedAt(Date.now());
        lastEntryAttemptV87Ref.current =
          Date.now();

        setMessage(
          `FreshEdge V8.7 one-minute target: no safe entry on ${market?.label || symbol}. Switching immediately to refresh the strongest market.`
        );

        if (
          nextSymbol &&
          nextSymbol !== symbol
        ) {
          void changeSymbol(nextSymbol)
            .catch(() => {})
            .finally(() => {
              window.setTimeout(() => {
                oneMinuteSwitchBusyV87Ref.current =
                  false;
              }, 900);
            });
        } else {
          oneMinuteSwitchBusyV87Ref.current =
            false;
        }
      }
    }, 1000);

    return () =>
      window.clearInterval(timer);
  }, [
    running,
    sessionStopped,
    activeBotTrades.length,
    tradeBusy,
    markets,
    symbol,
    market?.label,
    marketStartedAt,
    analysis,
    settings,
    marketScores,
    changeSymbol,
  ]);
  // FreshEdge V8.8 rapid portfolio scanner.
  // The current hook subscribes to one live market at a time, so this
  // performs fast sequential portfolio rotation using cached scores.
  useEffect(() => {
    if (
      !running ||
      sessionStopped ||
      activeBotTrades.length > 0 ||
      tradeBusy ||
      buyingRef.current ||
      !Array.isArray(markets) ||
      markets.length < 2
    ) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      const heldMs =
        now -
        Number(
          rapidPortfolioLastMoveV88Ref.current ||
          marketStartedAt ||
          now
        );

      const highRisk =
        Number(analysis.noise || 0) >
          Number(settings.maximumNoise || 60) ||
        Number(analysis.reversalRisk || 0) >
          Number(settings.maximumReversal || 50);

      const noConfirmedEntry =
        !analysis.ready ||
        !analysis.direction ||
        analysis.direction === "WAIT";

      const mustMove =
        (
          highRisk &&
          heldMs >= 6000
        ) ||
        (
          noConfirmedEntry &&
          heldMs >= 20000
        );

      if (
        !mustMove ||
        rapidPortfolioBusyV88Ref.current
      ) {
        return;
      }

      rapidPortfolioBusyV88Ref.current = true;
      rapidPortfolioLastMoveV88Ref.current =
        now;

      const ranked = Object.values(
        marketScores || {}
      )
        .filter(
          (row) =>
            row?.symbol &&
            row.symbol !== symbol &&
            now -
              Number(row.updatedAt || 0) <
              120000
        )
        .sort(
          (a, b) =>
            Number(b.score || 0) -
            Number(a.score || 0)
        );

      const currentIndex = Math.max(
        0,
        markets.findIndex(
          (item) => item.id === symbol
        )
      );

      const nextSymbol =
        ranked[0]?.symbol ||
        markets[
          (currentIndex + 1) %
            markets.length
        ]?.id;

      setConfirmation({
        key: "",
        ticks: 0,
      });
      hardRiskStartedAtRef.current = 0;
      weakSetupStartedAtRef.current = 0;
      setConfidenceTrail([]);
      setMarketStartedAt(now);

      setMessage(
        highRisk
          ? `FreshEdge V8.8: ${market?.label || symbol} stayed high-risk for 6s. Rotating immediately.`
          : `FreshEdge V8.8: no confirmed entry in 20s. Refreshing the strongest cached market.`
      );

      if (
        nextSymbol &&
        nextSymbol !== symbol
      ) {
        void changeSymbol(nextSymbol)
          .catch(() => {})
          .finally(() => {
            window.setTimeout(() => {
              rapidPortfolioBusyV88Ref.current =
                false;
            }, 700);
          });
      } else {
        rapidPortfolioBusyV88Ref.current =
          false;
      }
    }, 1000);

    return () =>
      window.clearInterval(timer);
  }, [
    running,
    sessionStopped,
    activeBotTrades.length,
    tradeBusy,
    markets,
    symbol,
    market?.label,
    marketStartedAt,
    analysis,
    settings,
    marketScores,
    changeSymbol,
  ]);
  useEffect(() => {
    const settled = openContracts.filter(
      (contract) =>
        isSettled(contract) &&
        botContractsRef.current.has(contractKey(contract)) &&
        !processedRef.current.has(contractKey(contract))
    );

    if (!settled.length) return;

    for (const contract of settled) {
      const id = contractKey(contract);
      const original = botContractsRef.current.get(id);

      if (!original) continue;

      processedRef.current.add(id);
      // FreshEdge V8.8 post-settlement rotation
      rapidPortfolioLastMoveV88Ref.current = 0;
      rapidPortfolioBusyV88Ref.current = false;
      hardRiskStartedAtRef.current = 0;
      weakSetupStartedAtRef.current = 0;
      // FreshEdge V8.7 settlement rescan clock
      lastEntryAttemptV87Ref.current = Date.now();
      oneMinuteSwitchBusyV87Ref.current = false;
      botContractsRef.current.delete(id);

      const result = resultOf(contract);
      const profit = profitOf(contract, original.stake);
      const replayTicks =
        activeReplayTicksRef.current.get(id) || [];

      activeReplayTicksRef.current.delete(id);

      const diagnosis = diagnoseFreshEdgeTrade(
        original,
        result
      );

      const exitAnalysis = replayTicks.at(-1) || null;
      const confidenceChange = exitAnalysis
        ? Number(exitAnalysis.confidence || 0) -
          Number(original.confidence || 0)
        : 0;
      const continuationChange = exitAnalysis
        ? Number(exitAnalysis.continuation || 0) -
          Number(original.continuation || 0)
        : 0;
      const reversalChange = exitAnalysis
        ? Number(exitAnalysis.reversal || 0) -
          Number(original.reversalRisk || 0)
        : 0;

      setStats((current) => ({
        runs: current.runs + 1,
        wins: current.wins + (result === "WON" ? 1 : 0),
        losses:
          current.losses + (result === "LOST" ? 1 : 0),
        profit: current.profit + profit,
        history: [
          {
            ...original,
            result,
            profit,
            diagnosis,
            replayTicks,
            exitAnalysis,
            replayDelta: {
              confidence: confidenceChange,
              continuation: continuationChange,
              reversal: reversalChange,
            },
            settledAt: Date.now(),
          },
          ...current.history,
        ].slice(0, 50),
      }));

      if (result === "LOST") {
        lastLossDirectionV85Ref.current =
          original.direction || "";

        lastLossDirectionUntilV85Ref.current =
          Date.now() +
          Number(
            settings.sameDirectionLossBlockSeconds || 18
          ) *
            1000;
        lossCooldownUntilV85Ref.current =
          Date.now() +
          Number(settings.lossCooldownSeconds || 8) *
            1000;
        setBlockedMarkets((current) => ({
          ...current,
          [original.symbol]:
            Date.now() +
            Number(settings.marketBlockSeconds) * 1000,
        }));

        setMessage(
          `${original.market} lost Â· ${diagnosis.code}: ${diagnosis.summary} Learning memory now has ${learning.totalTrades + 1} trades. ${diagnosis.nextAction}`
        );
        appendTimeline(
          "LOST",
          `${original.market} Â· ${diagnosis.code} Â· ${diagnosis.summary}`,
          {
            contractId: original.contractId,
            profit,
          }
        );
        const nextRecoveryPolicy =
          freshEdgeRecoveryPolicy(
            diagnosis.code,
            settings
          );

        setRecoveryState({
          active: true,
          sourceSymbol: original.symbol,
          sourceDirection: original.direction,
          requiredTicks: Number(
            nextRecoveryPolicy.freshTicks
          ),
          freshTicks: 0,
          cause: diagnosis.code,
        });
        setBlockedMarkets((current) => ({
          ...current,
          [original.symbol]:
            Date.now() +
            Number(settings.recoveryMarketBlockSeconds || 20) * 1000,
        }));

        const cooldownMs =
          Number(settings.lossCooldownSeconds || 8) * 1000;

        setMessage(
          `${original.market} lost Â· ${diagnosis.code}. Cooling down for ${Number(
            settings.lossCooldownSeconds || 8
          )}s before rebuilding from fresh data.`
        );

        window.setTimeout(() => {
          void switchMarket(
            "Loss cooldown completed; rebuilding on a fresh market."
          );
        }, cooldownMs);
      } else {
        setMessage(
          `${original.market} won ${profit.toFixed(2)} USD Â· ${diagnosis.summary} Learning memory now has ${learning.totalTrades + 1} trades.`
        );
        appendTimeline(
          "WON",
          `${original.market} Â· ${diagnosis.summary}`,
          {
            contractId: original.contractId,
            profit,
          }
        );
        setRecoveryState({
          active: false,
          sourceSymbol: "",
          requiredTicks: 0,
          freshTicks: 0,
          cause: "",
          sourceDirection: "",
        });
        hardRiskStartedAtRef.current = 0;
        weakSetupStartedAtRef.current = 0;
        marketWarmupCountV85Ref.current = 0;
        lossCooldownUntilV85Ref.current = 0;
        lastLossDirectionV85Ref.current = "";
        lastLossDirectionUntilV85Ref.current = 0;
      setMarketStartedAt(Date.now());
      }
    }
  }, [
    openContracts,
    settings.marketBlockSeconds,
    switchMarket,
    learning.totalTrades,
    appendTimeline,
    settings.freshRecoveryTicks,
    settings.recoveryMarketBlockSeconds,
  ]);

  useEffect(() => {
    if (!sessionStopped || !running) return;
    setRunning(false);
    setMessage(
      stats.profit >= Number(settings.takeProfit)
        ? "Take-profit reached. FreshEdge stopped."
        : "Stop-loss reached. FreshEdge stopped."
    );
  }, [
    sessionStopped,
    running,
    stats.profit,
    settings.takeProfit,
  ]);

  const resetSession = () => {
    setRunning(false);
    setStats(INITIAL_STATS);
    setConfirmation({ key: "", ticks: 0 });
    setBlockedMarkets({});
    setMarketScores({});
    setTimeline([]);
    setConfidenceTrail([]);
    setSelectedReplayId("");
    setRecoveryState({
      active: false,
      sourceSymbol: "",
      requiredTicks: 0,
      freshTicks: 0,
      cause: "",
      sourceDirection: "",
    });
    processedRef.current.clear();
    botContractsRef.current.clear();
    activeReplayTicksRef.current.clear();
    marketWarmupCountV85Ref.current = 0;
    lossCooldownUntilV85Ref.current = 0;
    lastLossDirectionV85Ref.current = "";
    lastLossDirectionUntilV85Ref.current = 0;
    setMessage("FreshEdge V8.5 session reset.");
  };

  return (
    <div className="appShell freshEdgeShell">
      <Sidebar />

      <main className="mainArea">
        <Topbar />

        <section className="freshEdgeHeader">
          <div>
            <small>STANDALONE BOT</small>
            <h1>FreshEdge AI V8.8</h1>
            <small>STRICT ENTRY GUARD</small>
            <p>
              Deep replay Â· latency telemetry Â· diagnosis-based recovery
            </p>
          </div>

          <div className="freshEdgeHeaderActions">
            <strong className={running ? "running" : ""}>
              {running ? "RUNNING" : "STOPPED"}
            </strong>

            <button
              type="button"
              onClick={() => {
                if (sessionStopped) {
                  setStats((current) => ({
                    ...INITIAL_STATS,
                    history: current.history,
                  }));

                  setConfirmation({
                    key: "",
                    ticks: 0,
                  });

                  setBlockedMarkets({});
                  setMarketScores({});
                  setTimeline([]);
                  setConfidenceTrail([]);
                  setSelectedReplayId("");

                  setRecoveryState({
                    active: false,
                    sourceSymbol: "",
                    requiredTicks: 0,
                    freshTicks: 0,
                    cause: "",
                    sourceDirection: "",
                  });

                  processedRef.current.clear();
                  botContractsRef.current.clear();
                  activeReplayTicksRef.current.clear();
                }

                hardRiskStartedAtRef.current = 0;
      weakSetupStartedAtRef.current = 0;
      marketWarmupCountV85Ref.current = 0;
      setMarketStartedAt(Date.now());
                setRunning(true);

                setMessage(
                  sessionStopped
                    ? "FreshEdge re-armed. New session started; learning history preserved."
                    : "FreshEdge started."
                );
              }}
              disabled={running}
            >
              Start
            </button>

            <button
              type="button"
              onClick={() => setRunning(false)}
              disabled={!running}
            >
              Stop
            </button>

            <button type="button" onClick={resetSession}>
              Reset
            </button>
          </div>
        </section>

        <section className="freshEdgeMarketBar">
          <MarketSelector
            markets={markets}
            value={symbol}
            onChange={(value) => {
              setConfirmation({ key: "", ticks: 0 });
              hardRiskStartedAtRef.current = 0;
      weakSetupStartedAtRef.current = 0;
      marketWarmupCountV85Ref.current = 0;
      setMarketStartedAt(Date.now());
              void changeSymbol(value);
            }}
            disabled={loadingMarket}
          />

          <article>
            <span>Account feed</span>
            <strong>
              {authenticatedFeed
                ? "AUTHENTICATED"
                : connected
                ? "ANALYSIS ONLY"
                : "CONNECTING"}
            </strong>
          </article>

          <article>
            <span>Price</span>
            <strong>
              {Number.isFinite(Number(currentPrice))
                ? Number(currentPrice).toFixed(
                    market?.decimals || 3
                  )
                : "â€”"}
            </strong>
          </article>

          <article>
            <span>Fresh ticks</span>
            <strong>{prices.length}</strong>
          </article>
        </section>

        <section className="freshEdgeDecision">
          <div>
            <small>LIVE DECISION</small>
            <h2>{analysis.decision}</h2>
            <p>{analysis.reason}</p>
          </div>

          <div className="freshEdgeDecisionGrid">
            {[
              ["Direction", analysis.direction || "WAIT"],
              ["Confidence", `${analysis.confidence.toFixed(1)}%`],
              ["Quality", `${analysis.quality.toFixed(1)}%`],
              ["Votes", `${Number(analysis.voteConsensus || 0).toFixed(1)}%`],
              ["Continuation", `${Number(analysis.continuation || 0).toFixed(1)}%`],
              ["Noise", `${analysis.noise.toFixed(1)}%`],
              ["Reversal", `${analysis.reversalRisk.toFixed(1)}%`],
              ["Spike ratio", Number(analysis.spikeRatio || 0).toFixed(2)],
              [
                "Adaptive gate",
                `${Number(
                  analysis.adaptiveThresholds?.confidence ||
                    settings.minimumConfidence
                ).toFixed(1)}%`,
              ],
            ].map(([label, value]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        </section>

        <section className="freshEdgeV5Decision">
          <header>
            <div>
              <small>V7 LIVE DECISION</small>
              <h3>Confidence movement and WAIT reasons</h3>
            </div>
            <strong>
              {analysis.decision === "BUY"
                ? `${analysis.direction} QUALIFIED`
                : `${missingWaitReasons.length} BLOCKERS`}
            </strong>
          </header>

          <div className="freshEdgeConfidenceTrail">
            {confidenceTrail.slice(-12).map((point, index, values) => {
              const previous = values[index - 1];
              const delta = previous
                ? point.confidence - previous.confidence
                : 0;

              return (
                <article key={`${point.time}-${index}`}>
                  <span>{point.direction}</span>
                  <strong>{point.confidence.toFixed(1)}%</strong>
                  <b className={delta >= 0 ? "up" : "down"}>
                    {delta >= 0 ? "+" : ""}
                    {delta.toFixed(1)}
                  </b>
                </article>
              );
            })}
          </div>

          <div className={`freshEdgeStability ${confidenceStability.ready ? "pass" : "wait"}`}>
            <article>
              <span>Confidence stability</span>
              <strong>
                {confidenceStability.ready ? "ENTRY SAFE" : "ENTRY BLOCKED"}
              </strong>
            </article>
            <article>
              <span>Trend</span>
              <strong>
                {confidenceStability.trend >= 0 ? "+" : ""}
                {confidenceStability.trend.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Maximum drop</span>
              <strong>
                {confidenceStability.drop.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Protection</span>
              <strong>
                max {settings.maximumConfidenceDrop}% drop
              </strong>
            </article>
          </div>

          <div className="freshEdgeWaitGrid">
            {waitReasons.map((item) => (
              <article
                key={item.label}
                className={item.pass ? "pass" : "fail"}
              >
                <b>{item.pass ? "PASS" : "WAIT"}</b>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </article>
            ))}
          </div>

          <p>
            {analysis.decision === "BUY"
              ? `Signal confirmed ${confirmation.ticks}/${settings.confirmationTicks} ticks.`
              : `Waiting for ${missingWaitReasons
                  .map((item) => item.label)
                  .join(", ") || "fresh confirmation"}. Estimated check ${settings.waitEstimateSeconds}s.`}
          </p>
        </section>

        <section className="freshEdgeRecoveryPanel">
          <header>
            <div>
              <small>V7 DIAGNOSIS RECOVERY</small>
              <h3>No old-signal recovery</h3>
            </div>
            <strong>{recoveryState.active ? "REBUILDING" : "NORMAL"}</strong>
          </header>
          <div>
            <article>
              <span>Source market</span>
              <strong>{recoveryState.sourceSymbol || "NONE"}</strong>
            </article>
            <article>
              <span>Fresh ticks</span>
              <strong>
                {recoveryState.freshTicks}/
                {recoveryState.requiredTicks ||
                  settings.freshRecoveryTicks}
              </strong>
            </article>
            <article>
              <span>Cause</span>
              <strong>{recoveryState.cause || "NONE"}</strong>
            </article>
            <article>
              <span>Recovery action</span>
              <strong>
                {recoveryState.active
                  ? recoveryPolicy.action
                  : "NORMAL"}
              </strong>
            </article>
            <article>
              <span>Extra confirmations</span>
              <strong>
                {recoveryState.active
                  ? recoveryPolicy.extraTicks
                  : 0}
              </strong>
            </article>
            <article>
              <span>Duration adjustment</span>
              <strong>
                {recoveryState.active
                  ? `+${recoveryPolicy.durationExtra}s`
                  : "0s"}
              </strong>
            </article>
            <article>
              <span>Entry permission</span>
              <strong>{recoveryReady ? "READY" : "WAIT"}</strong>
            </article>
          </div>
          <p>
            {recoveryState.active
              ? recoveryPolicy.description
              : "Normal fresh-entry rules apply."}
          </p>
        </section>

        <section className="freshEdgeV4Live">
          <header>
            <div>
              <small>V4 LIVE EDGE</small>
              <h3>Decision score breakdown</h3>
            </div>
            <strong>
              {analysis.decision === "BUY"
                ? `${analysis.direction} READY`
                : "FILTERING"}
            </strong>
          </header>

          <div className="freshEdgeMeterGrid">
            {Object.entries(
              analysis.componentScores || {}
            ).map(([key, value]) => (
              <article key={key}>
                <span>{key}</span>
                <div>
                  <i
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(100, Number(value || 0))
                      )}%`,
                    }}
                  />
                </div>
                <strong>
                  {Number(value || 0).toFixed(1)}%
                </strong>
              </article>
            ))}
          </div>
        </section>

        <section className="freshEdgeScannerBoard">
          <header>
            <div>
              <small>V7 MARKET SNAPSHOT SCANNER</small>
              <h3>Recent market decisions and rejection reasons</h3>
            </div>
            <strong>{scannerBoard.length} SNAPSHOTS</strong>
          </header>

          <div className="freshEdgeScannerGrid">
            {scannerBoard.length ? (
              scannerBoard.map((item) => (
                <article
                  key={item.symbol}
                  className={
                    item.status === "CANDIDATE"
                      ? "candidate"
                      : "rejected"
                  }
                >
                  <div>
                    <strong>{item.label}</strong>
                    <b>{Number(item.score || 0).toFixed(1)}</b>
                  </div>
                  <span>
                    {item.direction} Â· C{" "}
                    {Number(item.confidence || 0).toFixed(1)}
                    % Â· Q{" "}
                    {Number(item.quality || 0).toFixed(1)}%
                  </span>
                  <small>{item.rejectionReason}</small>
                  <em>{item.status}</em>
                </article>
              ))
            ) : (
              <p>Visit markets to build fresh scanner snapshots.</p>
            )}
          </div>
        </section>

        <section className="freshEdgeRanking">
          <header>
            <div>
              <small>V4 PARALLEL RANKING</small>
              <h3>Recently scanned markets</h3>
            </div>
            <strong>
              {rankedMarkets.length} CANDIDATES
            </strong>
          </header>

          <div className="freshEdgeRankingGrid">
            {rankedMarkets.length ? (
              rankedMarkets.map((item, index) => (
                <article key={item.symbol}>
                  <span>#{index + 1}</span>
                  <strong>{item.label}</strong>
                  <b>
                    {Number(item.score || 0).toFixed(1)}
                  </b>
                  <small>
                    {item.direction} Â· C{" "}
                    {Number(
                      item.confidence || 0
                    ).toFixed(1)}
                    % Â· Q{" "}
                    {Number(
                      item.quality || 0
                    ).toFixed(1)}
                    %
                  </small>
                </article>
              ))
            ) : (
              <p>Collecting ranked market snapshots...</p>
            )}
          </div>
        </section>

        <section className="freshEdgeTimeline">
          <header>
            <div>
              <small>V4 TRADE TIMELINE</small>
              <h3>Every decision and outcome</h3>
            </div>
            <strong>{timeline.length} EVENTS</strong>
          </header>

          <div className="freshEdgeTimelineList">
            {timeline.length ? (
              timeline.map((event) => (
                <article key={event.id}>
                  <time>
                    {new Date(event.time).toLocaleTimeString()}
                  </time>
                  <b>{event.type}</b>
                  <span>{event.detail}</span>
                </article>
              ))
            ) : (
              <p>No timeline events yet.</p>
            )}
          </div>
        </section>

        <section className="freshEdgeLearningChanges">
          <header>
            <div>
              <small>V7 SELF-CORRECTION</small>
              <h3>How settled trades changed the filters</h3>
            </div>
            <strong>
              {learning.totalTrades} LEARNED TRADES
            </strong>
          </header>

          <div className="freshEdgeLearningChangesGrid">
            {learningChanges.map((item) => {
              const delta = item.learned - item.base;

              return (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <strong>
                    {item.base.toFixed(1)}% â†’{" "}
                    {item.learned.toFixed(1)}%
                  </strong>
                  <b className={delta > 0 ? "raised" : "same"}>
                    {delta > 0 ? "+" : ""}
                    {delta.toFixed(1)}
                  </b>
                </article>
              );
            })}
            <article>
              <span>Dominant loss cause</span>
              <strong>{dominantLossCause.code}</strong>
              <b>{dominantLossCause.count} trades</b>
            </article>
          </div>

          <p>
            Learning only adjusts bounded gates and weights. Every new
            entry still needs current ticks, confirmation and confidence
            stability.
          </p>
        </section>

        <section className="freshEdgeLearning">
          <header>
            <div>
              <small>V3 ADAPTIVE LEARNING</small>
              <h3>What FreshEdge has learned</h3>
            </div>
            <strong>
              {learning.totalTrades} TRADES
            </strong>
          </header>

          <div className="freshEdgeLearningGrid">
            <article>
              <span>Learned win rate</span>
              <strong>
                {learning.winRate.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Required confidence</span>
              <strong>
                {Number(
                  analysis.adaptiveThresholds
                    ?.confidence ||
                    settings.minimumConfidence
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Required quality</span>
              <strong>
                {Number(
                  analysis.adaptiveThresholds
                    ?.quality ||
                    settings.minimumQuality
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Required votes</span>
              <strong>
                {Number(
                  analysis.adaptiveThresholds
                    ?.votes ||
                    settings.minimumVotes
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Quality weight</span>
              <strong>
                {(
                  learning.weights.quality * 100
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Votes weight</span>
              <strong>
                {(
                  learning.weights.votes * 100
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Continuation weight</span>
              <strong>
                {(
                  learning.weights.continuation *
                  100
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Risk weight</span>
              <strong>
                {(
                  learning.weights.risk * 100
                ).toFixed(1)}
                %
              </strong>
            </article>
          </div>

          <div className="freshEdgeHeatmap">
            <article>
              <span>RISE probability</span>
              <strong>
                {directionHeatmap.RISE.toFixed(1)}%
              </strong>
              <small>
                Learned {learning.directions.RISE.rate.toFixed(
                  1
                )}%
              </small>
            </article>
            <article>
              <span>FALL probability</span>
              <strong>
                {directionHeatmap.FALL.toFixed(1)}%
              </strong>
              <small>
                Learned {learning.directions.FALL.rate.toFixed(
                  1
                )}%
              </small>
            </article>
          </div>

          <div className="freshEdgeCauseGrid">
            {Object.entries(learning.causes).map(
              ([code, count]) => (
                <article key={code}>
                  <span>{code}</span>
                  <strong>{count}</strong>
                </article>
              )
            )}
          </div>
        </section>

        <section className="freshEdgeExplain">
          <header>
            <div>
              <small>WHY THIS TRADE CAN HAPPEN</small>
              <h3>Live entry explanation</h3>
            </div>
            <strong>
              {analysis.decision === "BUY"
                ? "QUALIFIED"
                : "FILTERING"}
            </strong>
          </header>

          <div className="freshEdgeExplainGrid">
            {(analysis.entryReasons || [
              analysis.reason,
            ]).map((reason, index) => (
              <article key={`${reason}-${index}`}>
                <span>{index + 1}</span>
                <strong>{reason}</strong>
              </article>
            ))}
          </div>

          <p>
            Entry confirmation: {confirmation.ticks}/
            {settings.confirmationTicks} live ticks. Market changes
            after {settings.maximumMarketSeconds}s without a valid setup.
          </p>
        </section>

        <section className="freshEdgeSettings">
          {[
            ["Stake", "stake", 0.35, 100, 0.05],
            ["Fresh ticks", "minimumTicks", 10, 60, 1],
            ["Duration", "duration", 5, 120, 5],
            ["Confidence", "minimumConfidence", 50, 90, 1],
            ["Quality", "minimumQuality", 45, 90, 1],
            ["Votes", "minimumVotes", 45, 90, 1],
            ["Continuation", "minimumContinuation", 40, 90, 1],
            ["Max noise", "maximumNoise", 40, 95, 1],
            ["Max reversal", "maximumReversal", 40, 95, 1],
            ["Confirm ticks", "confirmationTicks", 1, 5, 1],
            ["Market seconds", "maximumMarketSeconds", 5, 60, 1],
            ["Cycle deadline", "decisionCycleSeconds", 30, 59, 1],
            ["Fast expiry", "durationFastSeconds", 10, 30, 1],
            ["Normal expiry", "durationNormalSeconds", 10, 30, 1],
            ["Patient expiry", "durationPatientSeconds", 10, 30, 1],
            ["Risk hold", "hardRiskHoldSeconds", 5, 30, 1],
            ["Weak hold", "weakSetupHoldSeconds", 5, 30, 1],
            ["Take profit", "takeProfit", 0.5, 100, 0.5],
            ["Stop loss", "stopLoss", 0.5, 100, 0.5],
            ["Rank switch", "rankingSwitchMargin", 1, 15, 0.5],
            ["Rank min", "rankingMinimumScore", 30, 90, 1],
            ["Stability ticks", "stabilityTicks", 2, 8, 1],
            ["Max confidence drop", "maximumConfidenceDrop", 0.5, 15, 0.5],
            ["Replay ticks", "replayTickLimit", 10, 100, 5],
            ["Latency warning", "latencyWarningMs", 100, 5000, 100],
            ["Recovery ticks", "freshRecoveryTicks", 6, 40, 1],
            ["Wait estimate", "waitEstimateSeconds", 1, 15, 1],
          ].map(([label, key, min, max, step]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                min={min}
                max={max}
                step={step}
                value={settings[key]}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    [key]: Number(event.target.value),
                  }))
                }
              />
            </label>
          ))}
        </section>

        <div className="freshEdgeMessage">
          {tradeError || message}
        </div>

        <section className="freshEdgeV7Telemetry">
          <header>
            <div>
              <small>V7 EXECUTION TELEMETRY</small>
              <h3>Client-to-Deriv order response timing</h3>
            </div>
            <strong>
              {stats.history[0]?.orderLatencyMs
                ? `${Number(
                    stats.history[0].orderLatencyMs
                  ).toFixed(0)}ms`
                : "NO SAMPLE"}
            </strong>
          </header>

          <div>
            <article>
              <span>Latest response</span>
              <strong>
                {stats.history[0]?.orderLatencyMs
                  ? `${Number(
                      stats.history[0].orderLatencyMs
                    ).toFixed(0)} ms`
                  : "â€”"}
              </strong>
            </article>
            <article>
              <span>Latency status</span>
              <strong>
                {Number(
                  stats.history[0]?.orderLatencyMs || 0
                ) > Number(settings.latencyWarningMs)
                  ? "SLOW"
                  : stats.history[0]?.orderLatencyMs
                  ? "NORMAL"
                  : "WAITING"}
              </strong>
            </article>
            <article>
              <span>Replay ticks</span>
              <strong>
                {stats.history[0]?.replayTicks?.length || 0}
              </strong>
            </article>
            <article>
              <span>Measurement</span>
              <strong>CLIENT â†’ API RESPONSE</strong>
            </article>
          </div>
          <p>
            This is browser request-to-response time. It is not a
            guaranteed broker execution timestamp.
          </p>
        </section>

        <section className="freshEdgeBottom">
          <div className="freshEdgeExecution">
            <header>
              <div>
                <small>LIVE EXECUTION</small>
                <h3>FreshEdge monitor</h3>
              </div>
              <strong>{activeBotTrades.length} OPEN</strong>
            </header>

            {activeBotTrades.length ? (
              activeBotTrades.map((contract) => {
                const id = contractKey(contract);
                const original =
                  botContractsRef.current.get(id);

                return (
                  <article key={id}>
                    <strong>
                      {original?.direction || "OPEN"}
                    </strong>
                    <span>
                      {original?.market || contract?.symbol}
                    </span>
                    <span>{id}</span>
                  </article>
                );
              })
            ) : (
              <p>No open FreshEdge trades.</p>
            )}
          </div>

          <div className="freshEdgePerformance">
            <header>
              <small>PERFORMANCE</small>
              <h3>Isolated session</h3>
            </header>

            <div>
              <article>
                <span>Runs</span>
                <strong>{stats.runs}</strong>
              </article>
              <article>
                <span>Wins</span>
                <strong>{stats.wins}</strong>
              </article>
              <article>
                <span>Losses</span>
                <strong>{stats.losses}</strong>
              </article>
              <article>
                <span>P/L</span>
                <strong>{stats.profit.toFixed(2)}</strong>
              </article>
            </div>
          </div>
        </section>

        <section className="freshEdgeReplay">
          <header>
            <div>
              <small>V7 DEEP TRADE REPLAY</small>
              <h3>Open a settled trade to inspect its signal</h3>
            </div>
            <strong>{selectedReplayId ? "OPEN" : "SELECT TRADE"}</strong>
          </header>

          {(() => {
            const trade = stats.history.find(
              (item) => `${item.contractId}-${item.settledAt}` === selectedReplayId
            );

            if (!trade) {
              return <p>Select a trade from the journal below.</p>;
            }

            return (
              <div className="freshEdgeReplayBody">
                <article><span>Market / side</span><strong>{trade.market} Â· {trade.direction}</strong></article>
                <article><span>Entry edge</span><strong>C {Number(trade.confidence || 0).toFixed(1)}% Â· Q {Number(trade.quality || 0).toFixed(1)}%</strong></article>
                <article><span>Result</span><strong className={trade.result === "WON" ? "won" : "lost"}>{trade.result} {Number(trade.profit || 0).toFixed(2)}</strong></article>
                <article><span>Diagnosis</span><strong>{trade.diagnosis?.code || "SETTLED"}</strong></article>
                <div className="freshEdgeReplaySteps">
                  {(trade.entryTimeline || []).slice().reverse().map((event) => (
                    <div key={event.id}>
                      <time>{new Date(event.time).toLocaleTimeString()}</time>
                      <b>{event.type}</b>
                      <span>{event.detail}</span>
                    </div>
                  ))}
                  <div>
                    <time>{new Date(trade.settledAt).toLocaleTimeString()}</time>
                    <b>{trade.result}</b>
                    <span>{trade.diagnosis?.summary || "Trade settled."}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </section>

        {selectedReplay && (
          <section className="freshEdgeV7DeepReplay">
            <header>
              <div>
                <small>V7 TICK-BY-TICK REPLAY</small>
                <h3>
                  {selectedReplay.market} Â·{" "}
                  {selectedReplay.direction}
                </h3>
              </div>
              <strong>{selectedReplay.result}</strong>
            </header>

            <div className="freshEdgeV7ReplaySummary">
              <article>
                <span>Entry confidence</span>
                <strong>
                  {Number(
                    selectedReplay.confidence || 0
                  ).toFixed(1)}
                  %
                </strong>
              </article>
              <article>
                <span>Confidence change</span>
                <strong>
                  {Number(
                    selectedReplay.replayDelta?.confidence || 0
                  ) >= 0
                    ? "+"
                    : ""}
                  {Number(
                    selectedReplay.replayDelta?.confidence || 0
                  ).toFixed(1)}
                  %
                </strong>
              </article>
              <article>
                <span>Continuation change</span>
                <strong>
                  {Number(
                    selectedReplay.replayDelta
                      ?.continuation || 0
                  ) >= 0
                    ? "+"
                    : ""}
                  {Number(
                    selectedReplay.replayDelta
                      ?.continuation || 0
                  ).toFixed(1)}
                  %
                </strong>
              </article>
              <article>
                <span>Reversal change</span>
                <strong>
                  {Number(
                    selectedReplay.replayDelta?.reversal || 0
                  ) >= 0
                    ? "+"
                    : ""}
                  {Number(
                    selectedReplay.replayDelta?.reversal || 0
                  ).toFixed(1)}
                  %
                </strong>
              </article>
              <article>
                <span>Order response</span>
                <strong>
                  {Number(
                    selectedReplay.orderLatencyMs || 0
                  ).toFixed(0)}
                  ms
                </strong>
              </article>
              <article>
                <span>Recovery logic</span>
                <strong>
                  {selectedReplay.recoveryPolicyAtEntry
                    ?.action || "NORMAL"}
                </strong>
              </article>
            </div>

            <div className="freshEdgeV7Ticks">
              {(selectedReplay.replayTicks || []).length ? (
                selectedReplay.replayTicks.map(
                  (tick, index) => (
                    <article
                      key={`${tick.time}-${index}`}
                      className={
                        index === 0 ? "entry" : ""
                      }
                    >
                      <time>
                        {new Date(
                          tick.time
                        ).toLocaleTimeString()}
                      </time>
                      <strong>
                        {Number(tick.price).toFixed(
                          market?.decimals || 3
                        )}
                      </strong>
                      <span>
                        C{" "}
                        {Number(
                          tick.confidence || 0
                        ).toFixed(1)}
                        %
                      </span>
                      <span>
                        K{" "}
                        {Number(
                          tick.continuation || 0
                        ).toFixed(1)}
                        %
                      </span>
                      <span>
                        R{" "}
                        {Number(
                          tick.reversal || 0
                        ).toFixed(1)}
                        %
                      </span>
                    </article>
                  )
                )
              ) : (
                <p>
                  No post-entry ticks were captured. This can happen
                  when the bot switches away from the contract market.
                </p>
              )}
            </div>
          </section>
        )}

        <section className="freshEdgeJournal">
          <header>
            <small>TRADE JOURNAL</small>
            <h3>FreshEdge trades only</h3>
          </header>

          {stats.history.length ? (
            stats.history.map((trade) => (
              <article
                key={`${trade.contractId}-${trade.settledAt}`}
                className="freshEdgeJournalRow"
                role="button"
                tabIndex={0}
                onClick={() =>
                  setSelectedReplayId(
                    `${trade.contractId}-${trade.settledAt}`
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    setSelectedReplayId(
                      `${trade.contractId}-${trade.settledAt}`
                    );
                  }
                }}
              >
                <div>
                  <strong>{trade.market}</strong>
                  <span>{trade.direction}</span>
                </div>

                <div>
                  <span>
                    Why entered Â· memory{" "}
                    {trade.learningTrades || 0} trades
                  </span>
                  <strong>
                    {(trade.entryReasons || []).join(" Â· ") ||
                      `C ${Number(trade.confidence).toFixed(
                        1
                      )}% Â· Q ${Number(trade.quality).toFixed(
                        1
                      )}%`}
                  </strong>
                </div>

                <div>
                  <span>Outcome diagnosis</span>
                  <strong>
                    {trade.diagnosis?.code || "SETTLED"}
                  </strong>
                  <small>
                    {trade.diagnosis?.summary || "Trade settled."}
                  </small>
                </div>

                <div>
                  <span>Next protection</span>
                  <strong>
                    {trade.diagnosis?.nextAction ||
                      "Continue fresh scan."}
                  </strong>
                </div>

                <b
                  className={
                    trade.result === "WON" ? "won" : "lost"
                  }
                >
                  {trade.result}{" "}
                  {Number(trade.profit).toFixed(2)}
                </b>
              </article>
            ))
          ) : (
            <p>No settled FreshEdge trades yet.</p>
          )}
        </section>

        <footer className="freshEdgeFooter">
          FreshEdge V8.8 uses rapid sequential portfolio rotation, cached ranking, six-second risk exits and twenty-second no-entry refresh. It filters entries but cannot guarantee wins. Test on Demo.
        </footer>
      </main>
    </div>
  );
}










