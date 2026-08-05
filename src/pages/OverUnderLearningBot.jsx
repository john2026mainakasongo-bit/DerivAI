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

const MEMORY_KEY = "edgepilot:over-under-learning:v5";

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
  const status = String(
    item?.status || ""
  ).toUpperCase();

  if (
    item?.is_sold ||
    item?.is_expired ||
    ["WON", "LOST", "SOLD", "EXPIRED"].includes(
      status
    )
  ) {
    return status || "CLOSED";
  }

  return status || "OPEN";
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
  expectedProfitRatio = 0.34
) {
  const base = Math.max(
    0.35,
    Number(baseStake || 0.35)
  );

  if (!recovery?.active) {
    return base;
  }

  const attemptMultiplier =
    Number(recovery.attempts || 0) <= 1
      ? 1.5
      : 2;

  const targetStake =
    Number(recoveryTarget || 0) > 0
      ? Number(recoveryTarget || 0) /
        Math.max(
          0.05,
          Number(expectedProfitRatio || 0.34)
        )
      : base * attemptMultiplier;

  return Math.min(
    Math.max(0.35, Number(maximumStake || 1.4)),
    Math.max(
      base * attemptMultiplier,
      targetStake
    )
  );
}


function diagnoseOverUnderOutcome(trade, result) {
  const snapshot = trade?.entrySnapshot || {};

  if (result === "WON") {
    return {
      code: "SETUP_HELD",
      title: "Setup remained valid",
      summary:
        "Digit probability, transition edge and consistency held through settlement.",
      nextAction:
        "Store the pattern and keep bounded weights for similar fresh setups.",
    };
  }

  const score = Number(trade?.score || 0);
  const confidence = Number(trade?.confidence || 0);
  const probability = Number(trade?.probability || 0);
  const probabilityEdge = Number(snapshot.probabilityEdge || 0);
  const transitionEdge = Number(snapshot.transitionEdge || 0);
  const consistency = Number(snapshot.consistency || 0);
  const recentWinRate = Number(snapshot.recentWinRate || 50);

  if (probabilityEdge < 2.5) {
    return {
      code: "THIN_PROBABILITY_EDGE",
      title: "Probability edge was too thin",
      summary:
        "The selected barrier barely exceeded its learned break-even requirement.",
      nextAction:
        "Raise the required probability margin and avoid this exact setup temporarily.",
    };
  }

  if (transitionEdge < 52) {
    return {
      code: "TRANSITION_FAILED",
      title: "Digit transition did not continue",
      summary:
        "The recent digit transition pattern weakened after the order opened.",
      nextAction:
        "Increase transition weight and require two stronger confirmations.",
    };
  }

  if (consistency < 55) {
    return {
      code: "LOW_CONSISTENCY",
      title: "Digit flow was inconsistent",
      summary:
        "The winning-digit distribution was not stable enough for the short duration.",
      nextAction:
        "Wait for a cleaner digit window or rotate to another market.",
    };
  }

  if (recentWinRate < 55) {
    return {
      code: "WEAK_MEMORY_PATTERN",
      title: "Learned setup history was weak",
      summary:
        "This market, side and barrier had insufficient recent support.",
      nextAction:
        "Reduce its ranking and prefer candidates with stronger learned performance.",
    };
  }

  if (confidence < 70 || score < 70 || probability < 70) {
    return {
      code: "MARGINAL_ENTRY",
      title: "Entry safety margin was marginal",
      summary:
        "The setup passed, but confidence, score or probability was close to its gate.",
      nextAction:
        "Increase the adaptive gate for the next fresh candidate.",
    };
  }

  return {
    code: "DIGIT_VARIANCE",
    title: "Qualified setup lost to digit variance",
    summary:
      "The live setup was strong, but the settlement digit landed outside the expected set.",
    nextAction:
      "Do not repeat the same setup; rotate markets and rebuild the signal from fresh digits.",
  };
}

function aggregateLearning(memory = {}) {
  const rows = Object.values(memory || {});
  const causes = {};
  let trades = 0;
  let wins = 0;
  let losses = 0;

  rows.forEach((row) => {
    trades += Number(row?.trades || 0);
    wins += Number(row?.wins || 0);
    losses += Number(row?.losses || 0);

    Object.entries(row?.causes || {}).forEach(
      ([code, count]) => {
        causes[code] =
          Number(causes[code] || 0) +
          Number(count || 0);
      }
    );
  });

  const winRate = trades ? (wins / trades) * 100 : 50;
  const lossPressure = trades ? losses / trades : 0;

  return {
    trades,
    wins,
    losses,
    winRate,
    causes,
    weights: {
      liveScore: clamp(34 - lossPressure * 8, 24, 38),
      probability: clamp(24 + lossPressure * 7, 22, 34),
      transition: clamp(18 + lossPressure * 6, 16, 28),
      consistency: clamp(14 + lossPressure * 4, 12, 22),
      memory: clamp(10 + lossPressure * 5, 8, 18),
    },
    adaptiveGate: clamp(62 + lossPressure * 12, 62, 78),
  };
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
    diagnosis,
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
      causes: {
        ...(previous.causes || {}),
        [diagnosis?.code ||
        (won ? "SETUP_HELD" : "DIGIT_VARIANCE")]:
          Number(
            previous.causes?.[
              diagnosis?.code ||
                (won
                  ? "SETUP_HELD"
                  : "DIGIT_VARIANCE")
            ] || 0
          ) + 1,
      },
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
      "Over/Under AI V5 is ready with explainable learning."
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
  const [timeline, setTimeline] = useState([]);

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

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

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

  const learningSummary = useMemo(
    () => aggregateLearning(memory),
    [memory]
  );

  const appendTimeline = (type, detail) => {
    setTimeline((current) =>
      [
        {
          id: `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`,
          time: Date.now(),
          type,
          detail,
        },
        ...current,
      ].slice(0, 80)
    );
  };

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

          return {
            ...candidate,
            side,
            barrier,
            learned,
            adaptiveScore: candidateScore(
              candidate,
              learned
            ),
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
        .sort(
          (a, b) =>
            b.adaptiveScore -
            a.adaptiveScore
        ),
    [analysis.candidates, memory, symbol, marketBlocks]
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

  const bestKey = memoryKey(
    symbol,
    best.side,
    best.barrier
  );

  const blockedByLastLoss =
    lastLossKeyRef.current === bestKey;

  const recoveryScoreGate =
    Math.max(
      Number(minimumScore),
      Number(learningSummary.adaptiveGate || 62)
    ) +
    (recovery.active ? 6 : 0);

  const recoveryConfidenceGate =
    Number(minimumConfidence) +
    (recovery.active ? 5 : 0);

  const recoverySetupPass =
    !recovery.active ||
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
        (recovery.active ? 3 : 0) &&
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

  const nextEntry = {
    market: symbol,
    contract:
      best.side === "WAIT"
        ? "WAIT"
        : `${best.side} ${best.barrier}`,
    score: Number(best.adaptiveScore || 0),
    probability: Number(best.probability || 0),
    confirmations:
      confirmationRef.current.key === bestKey
        ? confirmationRef.current.ticks
        : 0,
    requiredConfirmations: 2,
    ready: confirmed,
  };

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
          recovery,
          maximumRecoveryStake,
          recoveryTarget,
          best.learned.profitRatio
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
          recovery,
          maximumRecoveryStake,
          recoveryTarget,
          best.learned.profitRatio
        ),
        recoveryMode: recovery.active,
        recoveryAttempt: recovery.attempts,
        confidence:
          analysis.confidence,
        score: best.adaptiveScore,
        probability: best.probability,
        learnedTrades:
          best.learned.trades,
        whyEntered: [
          `Adaptive score ${best.adaptiveScore.toFixed(1)}%`,
          `Probability ${best.probability.toFixed(1)}%`,
          `Required ${best.learned.requiredProbability.toFixed(1)}%`,
          `Transition ${Number(best.transitionEdge || 0).toFixed(1)}%`,
          `Consistency ${Number(best.consistency || 0).toFixed(1)}%`,
          `Memory ${best.learned.trades} trades · ${best.learned.recentWinRate.toFixed(1)}% recent`,
        ],
        entrySnapshot: {
          probabilityEdge: Number(best.probabilityEdge || 0),
          transitionEdge: Number(best.transitionEdge || 0),
          consistency: Number(best.consistency || 0),
          recentWinRate: Number(best.learned.recentWinRate || 50),
          requiredProbability: Number(best.learned.requiredProbability || 0),
        },
        status: "OPEN",
        profit: 0,
      };

      setTrades((current) =>
        [trade, ...current].slice(0, 50)
      );

      setStats((current) => ({
        ...current,
        runs: current.runs + 1,
      }));

      setMessage(
        `${recovery.active ? `RECOVERY ${recovery.attempts}/2` : "NORMAL"} · ${best.side} ${best.barrier} opened · stake ${recoveryStakeAmount(
          stake,
          recovery,
          maximumRecoveryStake,
          recoveryTarget,
          best.learned.profitRatio
        ).toFixed(2)} · score ${best.adaptiveScore.toFixed(
          1
        )}% · memory ${best.learned.trades} trades.`
      );

      appendTimeline(
        "OPEN",
        `${best.side} ${best.barrier} on ${symbol} · score ${best.adaptiveScore.toFixed(1)}% · probability ${best.probability.toFixed(1)}%.`
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

    const diagnosis =
      diagnoseOverUnderOutcome(
        settled,
        result
      );

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
        diagnosis,
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
              diagnosis,
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
      setRecovery({
        active: false,
        attempts: 0,
        previousLossKey: "",
        previousLossAmount: 0,
      });
      setRecoveryTarget(0);
      lastLossKeyRef.current = "";
      setMessage(
        `WIN ${settled.contract} · ${diagnosis.title}. ${diagnosis.nextAction}`
      );
      appendTimeline(
        "WON",
        `${settled.contract} on ${settled.symbol} · ${diagnosis.summary}`
      );
    } else {
      setConsecutiveLosses((current) => current + 1);
      setRecoveryTarget((current) =>
        Number(current || 0) +
        Math.abs(Number(settled.profit || 0))
      );
      setMarketBlocks((current) => ({
        ...current,
        [settled.symbol]:
          Date.now() + 60000,
      }));
      setRecovery((current) => ({
        active: true,
        attempts: Math.min(
          2,
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
        `LOSS ${settled.contract} · ${diagnosis.code}: ${diagnosis.summary} ${diagnosis.nextAction}`
      );
      appendTimeline(
        "LOST",
        `${settled.contract} on ${settled.symbol} · ${diagnosis.code} · ${diagnosis.summary}`
      );
    }

    if (
      result === "LOST" &&
      (
        consecutiveLosses >= 2 ||
        (
          settled.recoveryMode &&
          Number(settled.recoveryAttempt || 0) >= 2
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

  function toggle() {
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
    setMarketBlocks({});
    setStats({
      runs: 0,
      wins: 0,
      losses: 0,
      profit: 0,
      switches: 0,
    });
    processedRef.current = new Set();
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

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent oulPage">
        <Topbar
          title="Over/Under Adaptive Learning Bot V4"
          subtitle="Smart market rotation · non-forced recovery · continuous next-entry search"
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
              {recovery.active
                ? confirmed
                  ? "Fresh recovery setup passed stricter EV, confidence and confirmation gates."
                  : "Recovery is scanning all available markets. No trade will be forced without a clear setup."
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

        <section className="oulStats">
          <article>
            <span>Status</span>
            <strong>
              {running
                ? hasOpenTrade
                  ? "TRADE OPEN · STILL READING"
                  : "SCANNING"
                : "STOPPED"}
            </strong>
          </article>
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
            <span>Win rate</span>
            <strong>{pct(winRate)}</strong>
          </article>
          <article>
            <span>P/L</span>
            <strong>
              {stats.profit >= 0 ? "+" : ""}
              {stats.profit.toFixed(2)}
            </strong>
          </article>
          <article>
            <span>Switches</span>
            <strong>{stats.switches}</strong>
          </article>
          <article>
            <span>Stored setups</span>
            <strong>
              {Object.keys(memory).length}
            </strong>
          </article>
          <article>
            <span>Recovery</span>
            <strong>
              {recovery.active
                ? `${recovery.attempts}/2 ACTIVE`
                : "OFF"}
            </strong>
          </article>
          <article>
            <span>Recovery target</span>
            <strong>
              {recoveryTarget.toFixed(2)}
            </strong>
          </article>
          <article>
            <span>Market cooldown</span>
            <strong>
              {marketBlockRemaining(
                marketBlocks,
                symbol
              ) > 0
                ? `${Math.ceil(
                    marketBlockRemaining(
                      marketBlocks,
                      symbol
                    ) / 1000
                  )}s`
                : "CLEAR"}
            </strong>
          </article>
        </section>

        <section className="oulV5Learning">
          <header>
            <div>
              <small>V5 EXPLAINABLE LEARNING</small>
              <h2>What the bot has learned</h2>
            </div>
            <strong>{learningSummary.trades} TRADES</strong>
          </header>

          <div className="oulV5Stats">
            <article><span>Learned win rate</span><strong>{pct(learningSummary.winRate)}</strong></article>
            <article><span>Adaptive score gate</span><strong>{pct(learningSummary.adaptiveGate)}</strong></article>
            <article><span>Live-score weight</span><strong>{pct(learningSummary.weights.liveScore)}</strong></article>
            <article><span>Probability weight</span><strong>{pct(learningSummary.weights.probability)}</strong></article>
            <article><span>Transition weight</span><strong>{pct(learningSummary.weights.transition)}</strong></article>
            <article><span>Consistency weight</span><strong>{pct(learningSummary.weights.consistency)}</strong></article>
            <article><span>Memory weight</span><strong>{pct(learningSummary.weights.memory)}</strong></article>
          </div>

          <div className="oulV5Causes">
            {Object.entries(learningSummary.causes).length ?
              Object.entries(learningSummary.causes).map(([code, count]) => (
                <article key={code}><span>{code}</span><strong>{count}</strong></article>
              )) : <p>No settled learning patterns yet.</p>}
          </div>
        </section>

        <section className="oulV5NextEntry">
          <header>
            <div>
              <small>NEXT ENTRY PREDICTION</small>
              <h2>{nextEntry.contract}</h2>
            </div>
            <strong>{nextEntry.ready ? "READY" : "BUILDING"}</strong>
          </header>
          <div>
            <article><span>Market</span><strong>{nextEntry.market}</strong></article>
            <article><span>Score</span><strong>{pct(nextEntry.score)}</strong></article>
            <article><span>Probability</span><strong>{pct(nextEntry.probability)}</strong></article>
            <article><span>Confirmation</span><strong>{nextEntry.confirmations}/{nextEntry.requiredConfirmations} ticks</strong></article>
          </div>
        </section>

        <section className="oulV5Timeline">
          <header>
            <div>
              <small>DECISION TIMELINE</small>
              <h2>Open, win, loss and learning events</h2>
            </div>
            <strong>{timeline.length}</strong>
          </header>
          <div>
            {timeline.length ? timeline.map((event) => (
              <article key={event.id}>
                <time>{new Date(event.time).toLocaleTimeString()}</time>
                <b>{event.type}</b>
                <span>{event.detail}</span>
              </article>
            )) : <p>No timeline events yet.</p>}
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

        <section className="oulPanel">
          <header>
            <div>
              <small>SESSION JOURNAL</small>
              <h2>
                Open and settled trades
              </h2>
            </div>
            <strong>{trades.length}</strong>
          </header>

          <div className="oulTradeTable">
            <div className="head">
              <span>Time</span>
              <span>Market</span>
              <span>Contract</span>
              <span>Score</span>
              <span>Memory</span>
              <span>Status</span>
              <span>P/L</span>
            </div>

            {trades.map((trade) => (
              <div key={trade.id}>
                <span>
                  {new Date(
                    trade.time
                  ).toLocaleTimeString()}
                </span>
                <span>{trade.symbol}</span>
                <strong>
                  {trade.recoveryMode
                    ? `REC ${trade.recoveryAttempt} · `
                    : ""}
                  {trade.contract}
                </strong>
                <span>
                  {pct(trade.score)}
                </span>
                <span>
                  {trade.learnedTrades} trades
                </span>
                <b
                  className={String(
                    trade.status
                  ).toLowerCase()}
                >
                  {trade.status}
                </b>
                <b>
                  {Number(
                    trade.profit || 0
                  ).toFixed(2)}
                </b>

                <section className="oulTradeExplain">
                  <div>
                    <span>WHY ENTERED</span>
                    <strong>
                      {(trade.whyEntered || []).join(" · ") ||
                        "Waiting for entry explanation."}
                    </strong>
                  </div>
                  <div>
                    <span>WHY WON / LOST</span>
                    <strong>
                      {trade.diagnosis?.code ||
                        (trade.status === "OPEN"
                          ? "TRADE OPEN"
                          : "SETTLED")}
                    </strong>
                    <small>
                      {trade.diagnosis?.summary ||
                        "Outcome diagnosis appears after settlement."}
                    </small>
                  </div>
                  <div>
                    <span>NEXT PROTECTION</span>
                    <strong>
                      {trade.diagnosis?.nextAction ||
                        "Continue monitoring fresh digits."}
                    </strong>
                  </div>
                </section>
              </div>
            ))}

            {!trades.length ? (
              <p>No trades in this session.</p>
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
