import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyseTicks } from "../analysis/finalAnalysisEngine";

import "./FinalAnalysisBot.css";

const FINAL_AI_HISTORY_KEY = "edgepilot:final-ai:v15:transactions";
const FINAL_AI_MEMORY_KEY = "edgepilot:final-ai:v15:pattern-memory";
const FINAL_AI_CLUSTER_KEY = "edgepilot:final-ai:v15:cluster-memory";
const FINAL_AI_SETTINGS_KEY = "edgepilot:final-ai:v16:settings";

const money = (value) =>
  Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });


function marketMemoryPrefix(symbol) {
  return `${String(symbol || "UNKNOWN")}::`;
}

function scopedMemoryForMarket(memory, symbol) {
  const prefix = marketMemoryPrefix(symbol);

  return Object.fromEntries(
    Object.entries(memory || {})
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [
        key.slice(prefix.length),
        value,
      ])
  );
}

function classifyPatternQuality({
  sample = 0,
  wins = 0,
  losses = 0,
  winRate = 0,
  profit = 0,
} = {}) {
  if (
    sample >= 10 &&
    winRate >= 80 &&
    profit > 0 &&
    wins >= losses * 2
  ) {
    return "ELITE";
  }

  if (
    sample >= 5 &&
    winRate >= 70 &&
    profit > 0
  ) {
    return "GOLD";
  }

  if (
    sample >= 4 &&
    (
      winRate < 35 ||
      losses >= 4 ||
      profit < -0.7
    )
  ) {
    return "WEAK";
  }

  return "NORMAL";
}

function qualityWeight(tier) {
  if (tier === "ELITE") return 1.18;
  if (tier === "GOLD") return 1.10;
  if (tier === "WEAK") return 0.72;
  return 1;
}

function patternRows(memory) {
  return Object.entries(memory || {}).map(([key, value]) => {
    const wins = Number(value?.wins || 0);
    const losses = Number(value?.losses || 0);
    const sample = wins + losses;

    return {
      key,
      market: key.split("::")[0] || "UNKNOWN",
      signature:
        key.includes("::")
          ? key.split("::").slice(1).join("::")
          : key,
      wins,
      losses,
      sample,
      winRate: sample ? (wins / sample) * 100 : 0,
      profit: Number(value?.profit || 0),
      updatedAt: Number(value?.updatedAt || 0),
      tier: classifyPatternQuality({
        sample,
        wins,
        losses,
        winRate: sample ? (wins / sample) * 100 : 0,
        profit: Number(value?.profit || 0),
      }),
    };
  }).map((row) => ({
    ...row,
    qualityWeight: qualityWeight(row.tier),
  }));
}

function quoteOf(item) {
  if (typeof item === "number") return item;

  return Number(
    item?.quote ??
      item?.price ??
      item?.tick ??
      item?.value ??
      NaN
  );
}

function contractIdOf(item = {}) {
  return String(
    item?.contract_id ||
      item?.contractId ||
      item?.id ||
      ""
  );
}

function profitOf(item = {}) {
  const value = Number(
    item?.profit ??
      item?.profit_loss ??
      item?.pnl ??
      (Number(item?.sell_price || 0) -
        Number(item?.buy_price || 0))
  );

  return Number.isFinite(value) ? value : 0;
}

function statusOf(item = {}) {
  const raw = String(item?.status || "").toUpperCase();
  const profit = profitOf(item);

  if (
    item?.is_sold ||
    item?.is_expired ||
    ["WON", "LOST", "SOLD", "EXPIRED"].includes(raw)
  ) {
    if (raw === "WON" || raw === "LOST") return raw;
    if (profit > 0) return "WON";
    if (profit < 0) return "LOST";
    return "CLOSED";
  }

  return raw || "OPEN";
}

function Metric({ label, value }) {
  return (
    <article className="final-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

export default function FinalAnalysisBot() {
  const {
    markets = [],
    symbol = "",
    connected = false,
    authenticatedFeed = false,
    loadingMarket = false,
    prices = [],
    currentPrice = null,
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState("paper");
  const [stake, setStake] = useState(0.35);
  const [minimumConfidence, setMinimumConfidence] =
    useState(82);
  const [allowReal, setAllowReal] = useState(false);
  const [journal, setJournal] = useState([]);
  const [transactions, setTransactions] = useState(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(FINAL_AI_HISTORY_KEY) || "[]"
      );

      return Array.isArray(saved) ? saved.slice(0, 120) : [];
    } catch {
      return [];
    }
  });
  const [paperTrades, setPaperTrades] = useState([]);
  const [marketDataBank, setMarketDataBank] = useState({});
  const [marketTickSerials, setMarketTickSerials] = useState({});
  const [autoMarketSwitch, setAutoMarketSwitch] = useState(false);
  const [marketSwitchSeconds, setMarketSwitchSeconds] = useState(30);
  const [signalQueue, setSignalQueue] = useState([]);
  const [queueEnabled, setQueueEnabled] = useState(true);
  const [maxQueueSize, setMaxQueueSize] = useState(8);
  const [lastMarketSwitchAt, setLastMarketSwitchAt] = useState(Date.now());
  const [connectionLocked, setConnectionLocked] = useState(true);
  const [lastStableSymbol, setLastStableSymbol] = useState("");
  const [turboPortfolioSize, setTurboPortfolioSize] = useState(5);
  const [turboMode, setTurboMode] = useState(true);
  const [tickSerial, setTickSerial] = useState(0);
  const [adaptiveMemory, setAdaptiveMemory] = useState(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(FINAL_AI_MEMORY_KEY) || "{}"
      );
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  });

  const [clusterMemory, setClusterMemory] = useState(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(FINAL_AI_CLUSTER_KEY) || "{}"
      );
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  });
  const [message, setMessage] = useState(
    "Final AI is using the shared EdgePilot Deriv connection."
  );
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [protectionUntil, setProtectionUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [armedDirection, setArmedDirection] = useState("NONE");
  const [armedTicks, setArmedTicks] = useState(0);
  const [scanEndsAt, setScanEndsAt] = useState(
    () => Date.now() + 60000
  );
  const [scanCycle, setScanCycle] = useState(1);
  const [bestCandidate, setBestCandidate] = useState(null);
  const [usedRapidSlots, setUsedRapidSlots] = useState([]);
  const protectionRunRef = useRef(-1);
  const lastJournalAtRef = useRef(0);
  const viewportRef = useRef({
    x: 0,
    y: 0,
    lockUntil: 0,
  });
  const restoringViewportRef = useRef(false);

  const currentMarketTrades = paperTrades.filter(
    (trade) => trade.market === symbol
  );

  const totalOpenPaperTrades = paperTrades.length;

  const currentMarketDataCount =
    marketDataBank[symbol]?.prices?.length || 0;

  const availableMarketSymbols = (Array.isArray(markets) ? markets : [])
    .map((item) =>
      typeof item === "string"
        ? item
        : item?.symbol || item?.value || ""
    )
    .filter(Boolean);

  const turboMarketPool = availableMarketSymbols.slice(
    0,
    Math.max(2, Number(turboPortfolioSize || 5))
  );

  useEffect(() => {
    const rememberViewport = () => {
      if (restoringViewportRef.current) return;

      viewportRef.current = {
        ...viewportRef.current,
        x: window.scrollX,
        y: window.scrollY,
      };
    };

    window.addEventListener("scroll", rememberViewport, {
      passive: true,
    });

    rememberViewport();

    return () =>
      window.removeEventListener(
        "scroll",
        rememberViewport
      );
  }, []);

  useLayoutEffect(() => {
    const saved = viewportRef.current;

    if (
      Date.now() > Number(saved.lockUntil || 0)
    ) {
      return;
    }

    restoringViewportRef.current = true;

    const restore = () => {
      window.scrollTo({
        left: Number(saved.x || 0),
        top: Number(saved.y || 0),
        behavior: "auto",
      });
    };

    restore();

    const first = window.requestAnimationFrame(() => {
      restore();

      window.requestAnimationFrame(() => {
        restore();
        restoringViewportRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(first);
      restoringViewportRef.current = false;
    };
  }, [
    symbol,
    loadingMarket,
    marketDataBank,
    signalQueue.length,
  ]);

  const preserveViewportForSwitch = () => {
    viewportRef.current = {
      x: window.scrollX,
      y: window.scrollY,
      lockUntil: Date.now() + 2200,
    };
  };

  const scanRemainingSeconds = Math.max(
    0,
    Math.ceil((scanEndsAt - now) / 1000)
  );

  const scanExpired = now >= scanEndsAt;

  const rapidElapsedSeconds = Math.max(
    0,
    60 - scanRemainingSeconds
  );

  const rapidSlotIndex = Math.min(
    9,
    Math.floor(rapidElapsedSeconds / 6)
  );

  const rapidSlotUsed =
    usedRapidSlots.includes(rapidSlotIndex);

  const rapidSlotsUsed = usedRapidSlots.length;

  const adaptiveEntryThreshold =
    mode === "paper" && turboMode
      ? scanRemainingSeconds > 40
        ? 74
        : scanRemainingSeconds > 20
          ? 70
          : 66
      : scanRemainingSeconds > 30
        ? 82
        : scanRemainingSeconds > 15
          ? 76
          : 70;

  const lastDecisionRef = useRef("");
  const buyLockRef = useRef(false);
  const trackedContractsRef = useRef(new Set());

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      1000
    );

    return () => window.clearInterval(timer);
  }, []);

  const numericTicks = useMemo(
    () =>
      (Array.isArray(prices) ? prices : [])
        .map(quoteOf)
        .filter(Number.isFinite)
        .slice(-160),
    [prices]
  );

  const liveQuote = Number.isFinite(Number(currentPrice))
    ? Number(currentPrice)
    : numericTicks.at(-1) || 0;

  useEffect(() => {
    if (
      !connectionLocked ||
      loadingMarket ||
      !Number.isFinite(Number(liveQuote))
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setConnectionLocked(false);
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [
    connectionLocked,
    loadingMarket,
    liveQuote,
  ]);

  const marketMemory = useMemo(
    () => scopedMemoryForMarket(adaptiveMemory, symbol),
    [adaptiveMemory, symbol]
  );

  const marketClusterMemory = useMemo(
    () => scopedMemoryForMarket(clusterMemory, symbol),
    [clusterMemory, symbol]
  );

  const rollingExpectedValue = useMemo(() => {
    const recent = transactions
      .filter((row) =>
        ["WON", "LOST"].includes(String(row.result || ""))
      )
      .slice(0, 20);

    if (!recent.length) return 0;

    const total = recent.reduce(
      (sum, row) => sum + Number(row.profit || 0),
      0
    );

    return total / recent.length;
  }, [transactions]);

  const recentLossStreak = useMemo(() => {
    let streak = 0;

    for (const row of transactions) {
      if (row.result === "LOST") {
        streak += 1;
        continue;
      }

      if (row.result === "WON") break;
    }

    return streak;
  }, [transactions]);

  const protectionPaused =
    mode === "live" && now < protectionUntil;

  const analysis = useMemo(
    () =>
      analyseTicks(
        numericTicks,
        marketMemory,
        marketClusterMemory,
        {
          recentLossStreak,
          protectionPaused,
          rollingExpectedValue,
        }
      ),
    [
      numericTicks,
      marketMemory,
      marketClusterMemory,
      recentLossStreak,
      protectionPaused,
      rollingExpectedValue,
    ]
  );

  const currentPatternSample = Number(
    analysis.metrics?.learnedSample || 0
  );

  const currentPatternWins = Math.round(
    currentPatternSample *
      Number(analysis.metrics?.learnedWinRate || 0) /
      100
  );

  const currentPatternLosses = Math.max(
    0,
    currentPatternSample - currentPatternWins
  );

  const currentPatternTier = classifyPatternQuality({
    sample: currentPatternSample,
    wins: currentPatternWins,
    losses: currentPatternLosses,
    winRate: Number(
      analysis.metrics?.learnedWinRate || 0
    ),
    profit: Number(
      analysis.metrics?.learnedProfit || 0
    ),
  });

  const currentPatternWeight =
    qualityWeight(currentPatternTier);

  const qualityAdjustedThreshold = Math.max(
    58,
    Math.min(
      92,
      adaptiveEntryThreshold +
        (currentPatternTier === "ELITE"
          ? -8
          : currentPatternTier === "GOLD"
            ? -5
            : currentPatternTier === "WEAK"
              ? 12
              : 0)
    )
  );

  const weakPatternBlocked =
    currentPatternTier === "WEAK";

  const memoryCaps = {
    ELITE: 100,
    GOLD: 200,
    NORMAL: 50,
    WEAK: 0,
  };

  const continuousScoreReady =
    !weakPatternBlocked &&
    Boolean(analysis.continuousScore?.scoreQualified) &&
    Number(analysis.continuousScore?.weightedEntryScore || 0) >=
      qualityAdjustedThreshold &&
    ["RISE", "FALL"].includes(
      analysis.continuousScore?.direction
    );

  const rapidQualityThreshold =
    currentPatternTier === "ELITE"
      ? 60
      : currentPatternTier === "GOLD"
        ? 63
        : currentPatternTier === "WEAK"
          ? 78
          : 66;

  const rapidPaperReady =
    !weakPatternBlocked &&
    !rapidSlotUsed &&
    currentMarketTrades.length < 3 &&
    Boolean(analysis.rapidScore?.qualified) &&
    Number(analysis.rapidScore?.score || 0) >=
      rapidQualityThreshold &&
    ["RISE", "FALL"].includes(
      analysis.rapidScore?.direction
    );

  const strategyLab = useMemo(() => {
    const setups = Array.isArray(
      analysis.setupCandidates
    )
      ? analysis.setupCandidates
      : [];

    const directions = ["RISE", "FALL"];

    const ranked = directions
      .map((direction) => {
        const matching = setups
          .filter(
            (setup) =>
              setup.contract === direction
          )
          .sort(
            (a, b) =>
              Number(b.score || 0) -
              Number(a.score || 0)
          );

        const passed = matching.filter(
          (setup) => setup.passed
        );

        const source =
          passed.length >= 2
            ? passed
            : matching.slice(0, 4);

        const average = source.length
          ? source.reduce(
              (sum, setup) =>
                sum + Number(setup.score || 0),
              0
            ) / source.length
          : 0;

        const topScore = Number(
          matching[0]?.score || 0
        );

        const agreement =
          setups.length > 0
            ? matching.length / setups.length * 100
            : 0;

        const continuousAgreement =
          analysis.continuousScore?.direction ===
          direction;

        const rapidAgreement =
          analysis.rapidScore?.direction === direction;

        const voteAgreement =
          analysis.setupVoting?.direction === direction;

        const confirmationCount = [
          continuousAgreement,
          rapidAgreement,
          voteAgreement,
          Number(
            analysis.setupVoting?.agreementCount || 0
          ) >= 2,
          Number(
            analysis.continuousScore
              ?.weightedEntryScore || 0
          ) >= 68,
        ].filter(Boolean).length;

        const composite = Math.round(
          average * 0.42 +
            topScore * 0.22 +
            Math.min(100, agreement) * 0.12 +
            Number(
              analysis.continuousScore
                ?.weightedEntryScore || 0
            ) * 0.12 +
            Number(
              analysis.rapidScore?.score || 0
            ) * 0.12
        );

        const tests = [
          {
            id: "setup-consensus",
            label: "Setup consensus",
            passed:
              passed.length >= 2 ||
              matching.length >= 3,
          },
          {
            id: "direction-confirmation",
            label: "Direction confirmation",
            passed: confirmationCount >= 3,
          },
          {
            id: "score-strength",
            label: "Composite strength",
            passed: composite >= 70,
          },
          {
            id: "freshness",
            label: "Fresh tick signal",
            passed:
              analysis.continuousScore
                ?.signalFresh !== false,
          },
          {
            id: "pattern-quality",
            label: "Pattern quality",
            passed: !weakPatternBlocked,
          },
        ];

        const testsPassed = tests.filter(
          (test) => test.passed
        ).length;

        return {
          direction,
          composite,
          average: Math.round(average),
          topScore: Math.round(topScore),
          passedSetups: passed.length,
          matchingSetups: matching.length,
          confirmationCount,
          tests,
          testsPassed,
          qualified:
            testsPassed >= 4 &&
            composite >= 70 &&
            confirmationCount >= 3,
          strategy:
            matching[0]?.label ||
            `${direction} tick strategy`,
        };
      })
      .sort(
        (a, b) =>
          Number(b.qualified) -
            Number(a.qualified) ||
          b.testsPassed - a.testsPassed ||
          b.composite - a.composite
      );

    return {
      candidates: ranked,
      best: ranked[0] || null,
    };
  }, [
    analysis.setupCandidates,
    analysis.continuousScore,
    analysis.rapidScore,
    analysis.setupVoting,
    weakPatternBlocked,
  ]);

  const strongStrategy =
    strategyLab.best?.qualified
      ? strategyLab.best
      : null;

  const queueCandidate = useMemo(() => {
    const direction =
      strongStrategy?.direction ||
      analysis.rapidScore?.direction ||
      analysis.continuousScore?.direction ||
      analysis.setupVoting?.direction ||
      "NONE";

    const score = Math.max(
      Number(strongStrategy?.composite || 0),
      Number(analysis.rapidScore?.score || 0),
      Number(
        analysis.continuousScore?.weightedEntryScore || 0
      ),
      Number(analysis.setupVoting?.realConfidence || 0)
    );

    if (
      !["RISE", "FALL"].includes(direction) ||
      (
        !strongStrategy &&
        score < qualityAdjustedThreshold
      ) ||
      weakPatternBlocked ||
      currentMarketDataCount <
        (turboMode ? 12 : 20)
    ) {
      return null;
    }

    return {
      id: `${symbol}:${direction}:${Math.round(score)}`,
      market: symbol,
      direction,
      score: Math.round(score),
      tier: currentPatternTier,
      strategy:
        strongStrategy?.strategy ||
        "Composite tick strategy",
      testsPassed:
        Number(strongStrategy?.testsPassed || 0),
      createdAt: Date.now(),
      expiresAt: Date.now() + 4500,
    };
  }, [
    analysis.rapidScore,
    analysis.continuousScore,
    analysis.setupVoting,
    strongStrategy,
    qualityAdjustedThreshold,
    weakPatternBlocked,
    currentMarketDataCount,
    turboMode,
    currentPatternTier,
    symbol,
  ]);

  useEffect(() => {
    if (!running || !queueEnabled || !queueCandidate) return;

    setSignalQueue((current) => {
      const now = Date.now();

      const fresh = current.filter(
        (item) => item.expiresAt > now
      );

      const deduped = fresh.filter(
        (item) =>
          !(
            item.market === queueCandidate.market &&
            item.direction === queueCandidate.direction
          )
      );

      const tierRank = {
        ELITE: 4,
        GOLD: 3,
        NORMAL: 2,
        WEAK: 1,
      };

      return [queueCandidate, ...deduped]
        .sort((a, b) => {
          const tierDifference =
            (tierRank[b.tier] || 0) -
            (tierRank[a.tier] || 0);

          if (tierDifference !== 0) return tierDifference;
          if (b.score !== a.score) return b.score - a.score;
          return b.createdAt - a.createdAt;
        })
        .slice(0, Math.max(1, maxQueueSize));
    });
  }, [
    running,
    queueEnabled,
    queueCandidate,
    maxQueueSize,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSignalQueue((current) =>
        current.filter(
          (item) => item.expiresAt > Date.now()
        )
      );
    }, 500);

    return () => window.clearInterval(timer);
  }, []);

  const bestQueuedSignal =
    signalQueue.find(
      (item) =>
        item.market === symbol &&
        item.expiresAt > Date.now()
    ) || null;

  useEffect(() => {
    const armedNow =
      analysis.stage === "ARMED" ||
      analysis.decision === "BUY";

    if (
      !armedNow ||
      analysis.contract === "NONE"
    ) {
      setArmedDirection("NONE");
      setArmedTicks(0);
      return;
    }

    if (analysis.contract !== armedDirection) {
      setArmedDirection(analysis.contract);
      setArmedTicks(1);
      return;
    }

    setArmedTicks((value) => Math.min(9, value + 1));
  }, [
    analysis.stage,
    analysis.decision,
    analysis.contract,
    armedDirection,
  ]);

  const stableEntryReady =
    analysis.decision === "BUY" &&
    armedTicks >= 3 &&
    armedDirection === analysis.contract;

  const fullVoteEntryReady =
    Boolean(analysis.setupVoting?.qualified) &&
    Number(analysis.setupVoting?.agreementCount || 0) >= 3;

  const lateVoteEntryReady =
    scanRemainingSeconds <= 15 &&
    Number(analysis.setupVoting?.agreementCount || 0) >= 2 &&
    Number(analysis.setupVoting?.tickPressureScore || 0) >= 68 &&
    Number(analysis.setupVoting?.agreementPercent || 0) >= 60 &&
    ["RISE", "FALL"].includes(
      analysis.setupVoting?.direction
    );

  const tickEntryReady =
    fullVoteEntryReady || lateVoteEntryReady;

  const strongStrategyReady =
    mode === "paper" &&
    Boolean(strongStrategy) &&
    strongStrategy.testsPassed >= 4 &&
    strongStrategy.composite >= 70 &&
    currentMarketTrades.length < 3;

  const queuedEntryReady =
    mode === "paper" &&
    queueEnabled &&
    Boolean(bestQueuedSignal) &&
    currentMarketTrades.length < 3;

  const minuteEntryReady =
    strongStrategyReady ||
    queuedEntryReady ||
    stableEntryReady ||
    fullVoteEntryReady ||
    continuousScoreReady ||
    lateVoteEntryReady;

  const minuteEntryContract = strongStrategyReady
    ? strongStrategy?.direction
    : queuedEntryReady
      ? bestQueuedSignal?.direction
    : rapidPaperReady
      ? analysis.rapidScore?.direction
    : stableEntryReady
      ? analysis.contract
      : fullVoteEntryReady
        ? analysis.setupVoting?.direction
        : continuousScoreReady
          ? analysis.continuousScore?.direction
          : analysis.setupVoting?.direction ||
            analysis.tickSetup?.contract ||
            analysis.contract;

  const minuteEntryConfidence = strongStrategyReady
    ? Number(strongStrategy?.composite || 0)
    : queuedEntryReady
      ? Number(bestQueuedSignal?.score || 0)
    : rapidPaperReady
      ? Math.max(
        58,
        Math.min(
          88,
          Number(analysis.rapidScore?.score || 58)
        )
      )
    : stableEntryReady
      ? analysis.confidence
      : fullVoteEntryReady
        ? Math.max(
            58,
            Math.min(
              90,
              Number(
                analysis.setupVoting?.realConfidence || 58
              )
            )
          )
        : Math.max(
            58,
            Math.min(
              90,
              Number(
                analysis.continuousScore?.weightedEntryScore ||
                  analysis.setupVoting?.realConfidence ||
                  58
              )
            )
          );

  const minuteEntryMode = strongStrategyReady
    ? "STRATEGY_LAB"
    : queuedEntryReady
      ? "QUEUED_SIGNAL"
    : rapidPaperReady
      ? `RAPID_SLOT_${rapidSlotIndex + 1}`
    : stableEntryReady
      ? "CORE_CONFIRMED"
      : fullVoteEntryReady
        ? "3_SETUP_VOTE"
        : continuousScoreReady
          ? "CONTINUOUS_SCORE"
          : lateVoteEntryReady
            ? "2_VOTE_LATE"
            : "WAIT";

  const tickPressure = Number(
    analysis.setupVoting?.tickPressureScore || 0
  );

  const minuteTargetTicks = rapidPaperReady
    ? Number(analysis.rapidScore?.score || 0) >= 78
      ? 1
      : 2
    : tickPressure >= 82
      ? 2
      : tickPressure >= 70
        ? 3
        : 5;

  useEffect(() => {
    if (
      analysis.contract === "NONE" ||
      analysis.metrics.regime !== "TREND"
    ) {
      return;
    }

    const candidate = {
      contract: analysis.contract,
      confidence: Number(analysis.confidence || 0),
      probability: Number(analysis.probability || 0),
      ev: Number(analysis.metrics.expectedValue || 0),
      stability: Number(
        analysis.metrics.directionStability || 0
      ),
      stage: analysis.stage,
      setup: analysis.selectedSetup?.label || "Core setup",
      capturedAt: Date.now(),
    };

    const candidateScore =
      candidate.confidence * 0.32 +
      candidate.probability * 0.28 +
      candidate.stability * 0.25 +
      Math.max(0, candidate.ev) * 100 * 0.15;

    setBestCandidate((current) => {
      if (!current) {
        return {
          ...candidate,
          score: candidateScore,
        };
      }

      return candidateScore > Number(current.score || 0)
        ? {
            ...candidate,
            score: candidateScore,
          }
        : current;
    });
  }, [
    analysis.contract,
    analysis.confidence,
    analysis.probability,
    analysis.stage,
    analysis.metrics.regime,
    analysis.metrics.expectedValue,
    analysis.metrics.directionStability,
  ]);

  useEffect(() => {
    if (!scanExpired) return;

    setScanEndsAt(Date.now() + 60000);
    setScanCycle((value) => value + 1);
    setBestCandidate(null);
    setUsedRapidSlots([]);
    setArmedDirection("NONE");
    setArmedTicks(0);

    setMessage(
      "SCAN RESET · no fresh qualified entry was found within 60 seconds. Starting a new market-analysis cycle."
    );
  }, [scanExpired]);

  const stats = useMemo(() => {
    const settled = transactions.filter((item) =>
      ["WON", "LOST"].includes(item.result)
    );
    const wins = settled.filter(
      (item) => item.result === "WON"
    ).length;
    const losses = settled.filter(
      (item) => item.result === "LOST"
    ).length;
    const profit = settled.reduce(
      (sum, item) => sum + Number(item.profit || 0),
      0
    );

    return {
      runs: settled.length,
      wins,
      losses,
      profit,
      rate: settled.length
        ? Math.round((wins / settled.length) * 100)
        : 0,
    };
  }, [transactions]);

  useEffect(() => {
    if (
      recentLossStreak < 2 ||
      stats.runs === protectionRunRef.current
    ) {
      return;
    }

    const pauseMs =
      recentLossStreak >= 3 ? 90000 : 45000;

    protectionRunRef.current = stats.runs;
    setProtectionUntil(Date.now() + pauseMs);
    setMessage(
      `LOSS PROTECTION · ${recentLossStreak} consecutive losses · paused for ${Math.round(
        pauseMs / 1000
      )} seconds`
    );
  }, [recentLossStreak, stats.runs]);

  const learningSummary = useMemo(() => {
    const rows = patternRows(adaptiveMemory);
    const totalSamples = rows.reduce(
      (sum, row) => sum + row.sample,
      0
    );
    const totalWins = rows.reduce(
      (sum, row) => sum + row.wins,
      0
    );
    const totalLosses = rows.reduce(
      (sum, row) => sum + row.losses,
      0
    );
    const totalProfit = rows.reduce(
      (sum, row) => sum + row.profit,
      0
    );

    const mature = rows.filter(
      (row) => row.sample >= 8
    );
    const profitable = mature.filter(
      (row) => row.winRate >= 60 && row.profit > 0
    );
    const blocked = mature.filter(
      (row) => row.winRate < 60 || row.profit <= 0
    );

    const topPatterns = [...rows]
      .filter(
        (row) =>
          row.sample >= 2 &&
          row.winRate >= 60 &&
          row.profit > 0
      )
      .sort(
        (a, b) =>
          b.winRate - a.winRate ||
          b.sample - a.sample ||
          b.profit - a.profit
      )
      .slice(0, 10);

    const weakPatterns = [...rows]
      .filter(
        (row) =>
          row.sample >= 2 &&
          (row.winRate < 50 || row.profit < 0)
      )
      .sort(
        (a, b) =>
          a.winRate - b.winRate ||
          a.profit - b.profit ||
          b.sample - a.sample
      )
      .slice(0, 10);

    return {
      rows,
      totalPatterns: rows.length,
      totalSamples,
      totalWins,
      totalLosses,
      totalProfit,
      globalWinRate: totalSamples
        ? (totalWins / totalSamples) * 100
        : 0,
      maturePatterns: mature.length,
      profitablePatterns: profitable.length,
      blockedPatterns: blocked.length,
      topPatterns,
      weakPatterns,
      elitePatterns: rows.filter(
        (row) => row.tier === "ELITE"
      ),
      goldPatterns: rows.filter(
        (row) => row.tier === "GOLD"
      ),
      normalPatterns: rows.filter(
        (row) => row.tier === "NORMAL"
      ),
      qualityWeakPatterns: rows.filter(
        (row) => row.tier === "WEAK"
      ),
      bestPattern: topPatterns[0] || null,
      worstPattern: weakPatterns[0] || null,
    };
  }, [adaptiveMemory]);

  useEffect(() => {
    if (!running) return;

    setAdaptiveMemory((current) => {
      let changed = false;
      const next = {};

      for (const [key, value] of Object.entries(current || {})) {
        const wins = Number(value?.wins || 0);
        const losses = Number(value?.losses || 0);
        const sample = wins + losses;
        const profit = Number(value?.profit || 0);
        const winRate = sample
          ? (wins / sample) * 100
          : 0;

        const tier = classifyPatternQuality({
          sample,
          wins,
          losses,
          winRate,
          profit,
        });

        const expiredWeak =
          tier === "WEAK" &&
          sample >= 6 &&
          (
            losses >= 5 ||
            winRate < 25 ||
            profit <= -1.05
          );

        if (expiredWeak || tier === "WEAK") {
          changed = true;
          continue;
        }

        next[key] = {
          ...value,
          tier,
          qualityWeight: qualityWeight(tier),
        };
      }

      const grouped = Object.entries(next).reduce(
        (result, [key, value]) => {
          const tier = value?.tier || "NORMAL";
          if (!result[tier]) result[tier] = [];
          result[tier].push([key, value]);
          return result;
        },
        {}
      );

      const capped = {};

      Object.entries(grouped).forEach(
        ([tier, entries]) => {
          const limit = memoryCaps[tier] ?? 50;

          entries
            .sort(
              (a, b) =>
                Number(b[1]?.profit || 0) -
                  Number(a[1]?.profit || 0) ||
                Number(b[1]?.updatedAt || 0) -
                  Number(a[1]?.updatedAt || 0)
            )
            .slice(0, limit)
            .forEach(([key, value]) => {
              capped[key] = value;
            });

          if (entries.length > limit) changed = true;
        }
      );

      return changed ? capped : current;
    });
  }, [running, stats.runs]);

  const recentPerformance = useMemo(() => {
    const rows = transactions.slice(0, 100);
    const settled = rows.filter((row) =>
      ["WON", "LOST"].includes(String(row.result || ""))
    );
    const wins = settled.filter(
      (row) => row.result === "WON"
    ).length;
    const losses = settled.length - wins;
    const profit = settled.reduce(
      (sum, row) => sum + Number(row.profit || 0),
      0
    );

    const confidenceValues = settled
      .map((row) => Number(row.confidence))
      .filter(Number.isFinite);

    const averageConfidence = confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) /
        confidenceValues.length
      : 0;

    return {
      sample: settled.length,
      wins,
      losses,
      winRate: settled.length
        ? (wins / settled.length) * 100
        : 0,
      profit,
      averageConfidence,
    };
  }, [transactions]);

  const currentPatternMature =
    Number(analysis.metrics.learnedSample || 0) >= 8;

  const currentPatternLiveReady =
    currentPatternMature &&
    Number(analysis.metrics.learnedWinRate || 0) >= 60 &&
    Number(analysis.metrics.learnedProfit || 0) > 0 &&
    Number(analysis.metrics.expectedValue || 0) > 0;

  const learningPhase = protectionPaused
    ? "PROTECTION"
    : Number(analysis.metrics.learnedSample || 0) < 4 ||
        Number(analysis.metrics.clusterSample || 0) < 6
      ? "LEARN"
      : !currentPatternLiveReady
        ? "VALIDATE"
        : "EXECUTE";

  const protectionSeconds = Math.max(
    0,
    Math.ceil((protectionUntil - now) / 1000)
  );

  const executionReady =
    connected &&
    authenticatedFeed &&
    Boolean(selectedAccountId);

  const previousQuoteRef = useRef(null);

  useEffect(() => {
    if (
      symbol &&
      Number.isFinite(Number(liveQuote)) &&
      !loadingMarket
    ) {
      setLastStableSymbol(symbol);
    }
  }, [symbol, liveQuote, loadingMarket]);

  useEffect(() => {
    if (!Number.isFinite(Number(liveQuote)) || !symbol) return;

    const changed =
      previousQuoteRef.current !== null &&
      Number(previousQuoteRef.current) !== Number(liveQuote);

    if (changed) {
      setTickSerial((value) => value + 1);

      setMarketTickSerials((current) => ({
        ...current,
        [symbol]: Number(current[symbol] || 0) + 1,
      }));
    }

    setMarketDataBank((current) => {
      const existing = current[symbol] || {
        prices: [],
        updatedAt: 0,
      };

      const nextPrices = [
        ...existing.prices,
        Number(liveQuote),
      ].slice(-160);

      return {
        ...current,
        [symbol]: {
          prices: nextPrices,
          updatedAt: Date.now(),
          quote: Number(liveQuote),
        },
      };
    });

    previousQuoteRef.current = Number(liveQuote);
  }, [liveQuote, symbol]);

  useEffect(() => {
    if (
      !running ||
      !autoMarketSwitch ||
      connectionLocked ||
      loadingMarket ||
      totalOpenPaperTrades > 0 ||
      Date.now() - lastMarketSwitchAt <
        Math.max(
          20,
          Number(marketSwitchSeconds || 30)
        ) * 1000
    ) {
      return;
    }

    const pool =
      turboMarketPool.length >= 2
        ? turboMarketPool
        : availableMarketSymbols;

    if (pool.length < 2) return;

    const currentIndex = Math.max(0, pool.indexOf(symbol));

    const ranked = pool
      .filter((market) => market !== symbol)
      .map((market) => {
        const cached = marketDataBank[market] || {};
        const prices = Array.isArray(cached.prices)
          ? cached.prices
          : [];

        const recent = prices.slice(-18);
        const changes = recent
          .slice(1)
          .map((value, index) => value - recent[index]);

        const movement = changes.reduce(
          (sum, value) => sum + Math.abs(value),
          0
        );

        const directional = Math.abs(
          changes.reduce((sum, value) => sum + value, 0)
        );

        const activityScore =
          prices.length >= 20
            ? Math.min(
                100,
                prices.length * 0.7 +
                  movement * 18 +
                  directional * 22
              )
            : prices.length * 2;

        const openCount = paperTrades.filter(
          (trade) => trade.market === market
        ).length;

        const nextDistance =
          (pool.indexOf(market) - currentIndex + pool.length) %
          pool.length;

        return {
          market,
          activityScore,
          dataCount: prices.length,
          openCount,
          nextDistance,
          updatedAt: Number(cached.updatedAt || 0),
        };
      })
      .filter((item) => item.openCount < 3)
      .sort((a, b) => {
        const aReady = a.dataCount >= 20 ? 1 : 0;
        const bReady = b.dataCount >= 20 ? 1 : 0;

        if (aReady !== bReady) return bReady - aReady;
        if (a.activityScore !== b.activityScore) {
          return b.activityScore - a.activityScore;
        }
        if (a.updatedAt !== b.updatedAt) {
          return a.updatedAt - b.updatedAt;
        }
        return a.nextDistance - b.nextDistance;
      });

    const nextMarket =
      ranked[0]?.market ||
      pool[(currentIndex + 1) % pool.length];

    if (!nextMarket || nextMarket === symbol) return;

    setConnectionLocked(true);
    setLastMarketSwitchAt(Date.now());
    setScanEndsAt(Date.now() + 60000);
    setUsedRapidSlots([]);
    setBestCandidate(null);
    setArmedDirection("NONE");
    setArmedTicks(0);
    setMessage(
      `TURBO PORTFOLIO · ${symbol} → ${nextMarket} · ${totalOpenPaperTrades} open`
    );

    preserveViewportForSwitch();

    void Promise.resolve(changeSymbol(nextMarket))
      .finally(() => {
        window.setTimeout(() => {
          setConnectionLocked(false);
        }, 2500);
      });
  }, [
    running,
    autoMarketSwitch,
    connectionLocked,
    turboMode,
    loadingMarket,
    symbol,
    marketDataBank,
    marketSwitchSeconds,
    lastMarketSwitchAt,
    totalOpenPaperTrades,
    paperTrades,
    turboMarketPool,
    availableMarketSymbols,
    changeSymbol,
  ]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FINAL_AI_HISTORY_KEY,
        JSON.stringify(transactions.slice(0, 120))
      );
    } catch {
      // Storage can be unavailable in private browsing.
    }
  }, [transactions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FINAL_AI_MEMORY_KEY,
        JSON.stringify(adaptiveMemory)
      );
    } catch {
      // Ignore storage errors.
    }
  }, [adaptiveMemory]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FINAL_AI_CLUSTER_KEY,
        JSON.stringify(clusterMemory)
      );
    } catch {
      // Ignore storage errors.
    }
  }, [clusterMemory]);

  useEffect(() => {
    if (!analysis.ready) return;

    const key = [
      analysis.stage,
      analysis.decision,
      analysis.contract,
      analysis.reason,
    ].join("|");

    const nowMs = Date.now();

    if (
      key === lastDecisionRef.current ||
      nowMs - lastJournalAtRef.current < 5000
    ) {
      return;
    }

    lastDecisionRef.current = key;
    lastJournalAtRef.current = nowMs;

    setJournal((current) =>
      [
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString(),
          decision: analysis.decision,
          contract: analysis.contract,
          confidence: analysis.confidence,
          risk: analysis.risk,
          reason: analysis.reason,
        },
        ...current,
      ].slice(0, 60)
    );
  }, [analysis]);

  useEffect(() => {
    if (
      !running ||
      mode !== "paper" ||
      buyLockRef.current ||
      currentMarketTrades.length >= 3 ||
      totalOpenPaperTrades >= 12 ||
      rapidSlotUsed ||
      !(
        rapidPaperReady ||
        minuteEntryReady
      ) ||
      scanExpired ||
      !analysis.metrics.signalFresh ||
      minuteEntryConfidence < minimumConfidence ||
      Date.now() < cooldownUntil ||
      protectionPaused ||
      !liveQuote ||
      currentMarketDataCount < (turboMode ? 12 : 20)
    ) {
      return;
    }

    buyLockRef.current = true;

    if (queuedEntryReady && bestQueuedSignal) {
      setSignalQueue((current) =>
        current.filter(
          (item) => item.id !== bestQueuedSignal.id
        )
      );
    }

    if (rapidPaperReady) {
      setUsedRapidSlots((current) =>
        current.includes(rapidSlotIndex)
          ? current
          : [...current, rapidSlotIndex]
      );
    }

    setPaperTrades((current) => [
      ...current,
      {
      id: crypto.randomUUID(),
      market: symbol,
      contract: minuteEntryContract,
      entry: liveQuote,
      stake: Number(stake),
      confidence: minuteEntryConfidence,
      entryMode: minuteEntryMode,
      targetTicks: minuteTargetTicks,
      tickSetup: analysis.tickSetup?.setup || "SCANNING",
      agreementCount:
        Number(analysis.setupVoting?.agreementCount || 0),
      agreementPercent:
        Number(analysis.setupVoting?.agreementPercent || 0),
      tickPressure:
        Number(analysis.setupVoting?.tickPressureScore || 0),
      weightedEntryScore:
        Number(
          analysis.continuousScore?.weightedEntryScore || 0
        ),
      adaptiveThreshold: qualityAdjustedThreshold,
      patternTier: currentPatternTier,
      patternWeight: currentPatternWeight,
      rapidSlot: rapidPaperReady
        ? rapidSlotIndex + 1
        : null,
      rapidScore:
        Number(analysis.rapidScore?.score || 0),
      setup:
        minuteEntryMode === "3_SETUP_VOTE" ||
        minuteEntryMode === "2_VOTE_LATE"
          ? `${minuteEntryMode} · ${analysis.setupVoting?.agreementCount || 0} setups`
          : minuteEntryMode === "CORE_CONFIRMED"
            ? analysis.selectedSetup?.label || "Core confirmed"
            : analysis.selectedSetup?.label ||
            bestCandidate?.setup ||
            "Minute candidate",
      memorySignature:
        analysis.metrics.memorySignature
          ? `${marketMemoryPrefix(symbol)}${analysis.metrics.memorySignature}`
          : "",
      clusterSignature:
        analysis.metrics.clusterSignature
          ? `${marketMemoryPrefix(symbol)}${analysis.metrics.clusterSignature}`
          : "",
      entrySerial: tickSerial,
      openedAt: new Date().toLocaleTimeString(),
      marketEntrySerial:
        Number(marketTickSerials[symbol] || 0),
    },
    ]);

    setMessage(
      `PAPER ENTRY · ${minuteEntryContract} · ${minuteEntryConfidence}% · ${minuteEntryMode} · ${minuteTargetTicks} ticks`
    );

    window.setTimeout(() => {
      buyLockRef.current = false;
    }, 1400);
  }, [
    analysis,
    strongStrategyReady,
    strongStrategy,
    queuedEntryReady,
    bestQueuedSignal,
    rapidPaperReady,
    rapidSlotUsed,
    rapidSlotIndex,
    minuteEntryReady,
    minuteEntryContract,
    minuteEntryConfidence,
    minuteEntryMode,
    minuteTargetTicks,
    fullVoteEntryReady,
    continuousScoreReady,
    lateVoteEntryReady,
    tickEntryReady,
    adaptiveEntryThreshold,
    stableEntryReady,
    scanExpired,
    liveQuote,
    minimumConfidence,
    mode,
    numericTicks.length,
    paperTrades,
    running,
    stake,
    symbol,
    tickSerial,
    cooldownUntil,
  ]);

  useEffect(() => {
    if (
      !symbol ||
      !Number.isFinite(Number(liveQuote)) ||
      paperTrades.length === 0
    ) {
      return;
    }

    const marketSerial =
      Number(marketTickSerials[symbol] || 0);

    const settled = paperTrades.filter(
      (trade) =>
        trade.market === symbol &&
        marketSerial >=
          Number(trade.marketEntrySerial || 0) +
            Math.max(
              1,
              Number(trade.targetTicks || 2)
            )
    );

    if (settled.length === 0) return;

    const completed = settled.map((trade) => {
      const exit = Number(liveQuote);
      const won =
        trade.contract === "RISE"
          ? exit > Number(trade.entry)
          : exit < Number(trade.entry);

      const profit = won
        ? Number(trade.stake) * 0.92
        : -Number(trade.stake);

      return {
        ...trade,
        exit,
        result: won ? "WON" : "LOST",
        profit,
        source: "PAPER",
        closedAt: new Date().toLocaleTimeString(),
      };
    });

    setTransactions((current) =>
      [...completed.reverse(), ...current].slice(0, 120)
    );

    for (const result of completed) {
      const won = result.result === "WON";

      if (result.memorySignature) {
        setAdaptiveMemory((current) => {
          const previous =
            current[result.memorySignature] || {
              wins: 0,
              losses: 0,
              profit: 0,
            };

          return {
            ...current,
            [result.memorySignature]: {
              wins:
                Number(previous.wins || 0) +
                (won ? 1 : 0),
              losses:
                Number(previous.losses || 0) +
                (won ? 0 : 1),
              profit:
                Number(previous.profit || 0) +
                Number(result.profit || 0),
              updatedAt: Date.now(),
              tier: classifyPatternQuality({
                sample:
                  Number(previous.wins || 0) +
                  Number(previous.losses || 0) +
                  1,
                wins:
                  Number(previous.wins || 0) +
                  (won ? 1 : 0),
                losses:
                  Number(previous.losses || 0) +
                  (won ? 0 : 1),
                winRate:
                  (
                    Number(previous.wins || 0) +
                    (won ? 1 : 0)
                  ) /
                  Math.max(
                    1,
                    Number(previous.wins || 0) +
                      Number(previous.losses || 0) +
                      1
                  ) *
                  100,
                profit:
                  Number(previous.profit || 0) +
                  Number(result.profit || 0),
              }),
            },
          };
        });
      }

      if (result.clusterSignature) {
        setClusterMemory((current) => {
          const previous =
            current[result.clusterSignature] || {
              wins: 0,
              losses: 0,
              profit: 0,
            };

          return {
            ...current,
            [result.clusterSignature]: {
              wins:
                Number(previous.wins || 0) +
                (won ? 1 : 0),
              losses:
                Number(previous.losses || 0) +
                (won ? 0 : 1),
              profit:
                Number(previous.profit || 0) +
                Number(result.profit || 0),
              updatedAt: Date.now(),
            },
          };
        });
      }
    }

    const settledIds = new Set(
      settled.map((trade) => trade.id)
    );

    setPaperTrades((current) =>
      current.filter(
        (trade) => !settledIds.has(trade.id)
      )
    );

    const net = completed.reduce(
      (sum, result) => sum + Number(result.profit || 0),
      0
    );

    setMessage(
      `${symbol} · ${completed.length} PAPER SETTLED · ${
        net >= 0 ? "+" : ""
      }$${money(net)}`
    );

    setCooldownUntil(Date.now() + (turboMode ? 250 : 600));
  }, [
    liveQuote,
    symbol,
    paperTrades,
    marketTickSerials,
  ]);

  useEffect(() => {
    for (const contract of Array.isArray(openContracts)
      ? openContracts
      : []) {
      const id = contractIdOf(contract);
      if (!id) continue;

      const status = statusOf(contract);

      if (status === "OPEN") {
        if (typeof refreshContract === "function") {
          void refreshContract(id);
        }
        continue;
      }

      if (trackedContractsRef.current.has(id)) continue;
      trackedContractsRef.current.add(id);

      const profit = profitOf(contract);

      setTransactions((current) =>
        [
          {
            id,
            market:
              contract?.underlying ||
              contract?.symbol ||
              symbol,
            contract:
              contract?.contract_type ||
              contract?.contractType ||
              "LIVE",
            entry:
              contract?.entry_spot ??
              contract?.entry_tick ??
              "—",
            exit:
              contract?.exit_tick ??
              contract?.exit_spot ??
              "—",
            stake:
              contract?.buy_price ??
              contract?.stake ??
              stake,
            confidence:
              contract?.confidence ??
              analysis.confidence,
            result: status,
            profit,
            source: "DERIV",
            closedAt: new Date().toLocaleTimeString(),
          },
          ...current,
        ].slice(0, 120)
      );

      setMessage(
        `DERIV ${status} · ${
          profit >= 0 ? "+" : ""
        }$${money(profit)}`
      );
    }
  }, [
    analysis.confidence,
    openContracts,
    refreshContract,
    stake,
    symbol,
  ]);

  async function executeLiveSignal() {
    if (buyLockRef.current || tradeBusy) return;

    if (!executionReady) {
      setMessage(
        "Log in with Deriv and select an account before live execution."
      );
      return;
    }

    if (
      selectedAccountType !== "demo" &&
      !allowReal
    ) {
      setMessage(
        "Real account is locked. Enable real execution manually."
      );
      return;
    }

    if (
      !stableEntryReady ||
      scanExpired ||
      !analysis.metrics.signalFresh ||
      analysis.contract === "NONE" ||
      analysis.confidence < minimumConfidence
    ) {
      setMessage(
        "Signal has not passed the Final AI execution gate."
      );
      return;
    }

    if (protectionPaused) {
      setMessage(
        `LIVE BLOCKED · loss protection has ${protectionSeconds}s remaining.`
      );
      return;
    }

    if (!currentPatternLiveReady) {
      setMessage(
        "LIVE BLOCKED · current pattern needs at least 8 samples, 60% learned wins, positive learned profit and positive EV."
      );
      return;
    }

    buyLockRef.current = true;

    try {
      setMessage(
        `SENDING DERIV BUY · ${analysis.contract} · ${analysis.confidence}%`
      );

      const response = await placeTrade({
        symbol,
        contractType:
          analysis.contract === "RISE"
            ? "CALL"
            : "PUT",
        amount: Math.max(
          0.35,
          Number(stake || 0.35)
        ),
        basis: "stake",
        duration: 5,
        durationUnit: "t",
      });

      const contractId = contractIdOf(
        response?.buy ||
          response?.proposal_open_contract ||
          response
      );

      setMessage(
        contractId
          ? `DERIV BUY SENT · CONTRACT ${contractId}`
          : "DERIV BUY SENT · waiting for contract update"
      );
    } catch (error) {
      setMessage(
        error?.message ||
          tradeError ||
          "Deriv rejected the buy request."
      );
    } finally {
      window.setTimeout(() => {
        buyLockRef.current = false;
      }, 1800);
    }
  }

  useEffect(() => {
    if (
      !running ||
      mode !== "live" ||
      buyLockRef.current ||
      tradeBusy ||
      !minuteEntryReady ||
      scanExpired ||
      (
        stableEntryReady &&
        !analysis.metrics.signalFresh
      ) ||
      (
        stableEntryReady &&
        analysis.confidence < minimumConfidence
      ) ||

      !currentPatternLiveReady ||
      protectionPaused
    ) {
      return;
    }

    void executeLiveSignal();
    // execute only when a new qualified decision appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    analysis.decision,
    analysis.contract,
    analysis.confidence,
    minimumConfidence,
    mode,
    running,
    symbol,
  ]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent final-integrated-page final-v7-page final-v14-page final-v15-page final-v16-page final-v17-page final-v18-page final-v19-page final-v20-page final-v21-page final-v22-page final-v23-page final-v24-page final-v25-page final-v26-page final-v27-page final-v28-page final-v28-1-page">
        <Topbar
          title="EdgePilot Final AI"
          subtitle="Shared Deriv login · live analysis · decision journal · paper and guarded live execution"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <nav className="final-section-nav" aria-label="Final AI sections">
          <a href="#final-execution">Execution</a>
          <a href="#final-analysis">Analysis</a>
          <a href="#final-trades">Trades</a>
          <a href="#final-learning">Learning</a>
          <a href="#final-patterns">Patterns</a>
        </nav>

        <section
          id="final-execution"
          className="final-account-strip final-section-anchor"
        >
          <div>
            <span>Feed</span>
            <strong>
              {connected ? "LIVE" : "OFFLINE"}
            </strong>
          </div>
          <div>
            <span>Trading auth</span>
            <strong>
              {authenticatedFeed && selectedAccountId
                ? "READY"
                : "BLOCKED"}
            </strong>
          </div>
          <div>
            <span>Account</span>
            <strong>
              {selectedAccountType || "—"}
            </strong>
          </div>
          <div>
            <span>Account ID</span>
            <strong>
              {selectedAccountId || "Not selected"}
            </strong>
          </div>
          <div className="final-wide-message">
            <span>Status</span>
            <strong>{tradeError || message}</strong>
          </div>
        </section>

        <section className="final-control-grid final-section-anchor">
          <label>
            Market
            <MarketSelector
              markets={markets}
              value={symbol}
              disabled={loadingMarket}
              onChange={(next) => {
                setConnectionLocked(true);
                setLastMarketSwitchAt(Date.now());
                setScanEndsAt(Date.now() + 60000);
                setUsedRapidSlots([]);
                preserveViewportForSwitch();

                void Promise.resolve(changeSymbol(next))
                  .finally(() => {
                    window.setTimeout(() => {
                      setConnectionLocked(false);
                    }, 2500);
                  });
              }}
            />
          </label>

          <label>
            Stake
            <input
              min="0.35"
              step="0.01"
              type="number"
              value={stake}
              onChange={(event) =>
                setStake(event.target.value)
              }
            />
          </label>

          <label>
            Minimum confidence
            <input
              min="60"
              max="95"
              type="number"
              value={minimumConfidence}
              onChange={(event) =>
                setMinimumConfidence(
                  Number(event.target.value)
                )
              }
            />
          </label>

          <label>
            Signal queue
            <select
              value={queueEnabled ? "on" : "off"}
              onChange={(event) =>
                setQueueEnabled(
                  event.target.value === "on"
                )
              }
            >
              <option value="on">ON</option>
              <option value="off">OFF</option>
            </select>
          </label>

          <label>
            Queue size
            <select
              value={maxQueueSize}
              onChange={(event) =>
                setMaxQueueSize(
                  Number(event.target.value)
                )
              }
            >
              <option value="4">4 signals</option>
              <option value="8">8 signals</option>
              <option value="12">12 signals</option>
            </select>
          </label>

          <label>
            Turbo portfolio
            <select
              value={turboMode ? "on" : "off"}
              onChange={(event) =>
                setTurboMode(event.target.value === "on")
              }
            >
              <option value="on">ON</option>
              <option value="off">OFF</option>
            </select>
          </label>

          <label>
            Markets in pool
            <select
              value={turboPortfolioSize}
              onChange={(event) =>
                setTurboPortfolioSize(
                  Number(event.target.value)
                )
              }
            >
              <option value="3">3 markets</option>
              <option value="5">5 markets</option>
              <option value="7">7 markets</option>
            </select>
          </label>

          <label>
            Connection lock
            <select
              value={connectionLocked ? "locked" : "ready"}
              onChange={(event) =>
                setConnectionLocked(
                  event.target.value === "locked"
                )
              }
            >
              <option value="locked">
                LOCKED · stable market
              </option>
              <option value="ready">
                READY · allow rotation
              </option>
            </select>
          </label>

          <label>
            Auto market switch
            <select
              value={autoMarketSwitch ? "on" : "off"}
              onChange={(event) =>
                setAutoMarketSwitch(
                  event.target.value === "on"
                )
              }
            >
              <option value="on">ON</option>
              <option value="off">OFF</option>
            </select>
          </label>

          <label>
            Switch every
            <select
              value={marketSwitchSeconds}
              onChange={(event) =>
                setMarketSwitchSeconds(
                  Number(event.target.value)
                )
              }
            >
              <option value="20">20 seconds</option>
              <option value="30">30 seconds</option>
              <option value="45">45 seconds</option>
              <option value="60">60 seconds</option>
            </select>
          </label>

          <label>
            Execution mode
            <select
              value={mode}
              onChange={(event) => {
                setRunning(false);
                setMode(event.target.value);
              }}
            >
              <option value="paper">
                Paper trading
              </option>
              <option value="live">
                Deriv live execution
              </option>
              <option value="analysis">
                Analysis only
              </option>
            </select>
          </label>

          <label className="final-real-lock">
            Real account
            <select
              value={allowReal ? "enabled" : "locked"}
              onChange={(event) =>
                setAllowReal(
                  event.target.value === "enabled"
                )
              }
            >
              <option value="locked">
                LOCKED
              </option>
              <option value="enabled">
                ENABLED
              </option>
            </select>
          </label>

          <button
            className={
              running ? "final-stop" : "final-start"
            }
            onClick={() =>
              setRunning((value) => !value)
            }
          >
            {running ? "STOP FINAL AI" : "START FINAL AI"}
          </button>

          {mode === "live" && (
            <button
              className="final-test-buy"
              disabled={
                tradeBusy ||
                !executionReady ||
                analysis.decision !== "BUY"
              }
              onClick={() => void executeLiveSignal()}
            >
              BUY QUALIFIED SIGNAL
            </button>
          )}
        </section>

        <section id="final-analysis" className="final-hero-grid final-section-anchor">
          <article
            className={`final-decision final-decision-${analysis.decision.toLowerCase()}`}
          >
            <div className="final-decision-head">
              <span>FINAL AI DECISION</span>
              <div className="final-stage-badges">
                <em>{analysis.stage || "SCAN"}</em>
                <strong>{analysis.decision}</strong>
              </div>
            </div>

            <div className="final-contract">
              {analysis.contract}
            </div>

            <p>{analysis.reason}</p>

            <div className="final-filter-list">
              {(analysis.checks || []).map((item) => (
                <div
                  key={item.label}
                  className={
                    item.passed
                      ? "final-filter-pass"
                      : "final-filter-fail"
                  }
                >
                  <span>{item.passed ? "✓" : "✗"}</span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </div>
              ))}
            </div>

            <div className="final-score-row">
              <div>
                <small>Confidence</small>
                <strong>
                  {analysis.confidence}%
                </strong>
              </div>
              <div>
                <small>Probability</small>
                <strong>
                  {analysis.probability}%
                </strong>
              </div>
              <div>
                <small>Risk</small>
                <strong>{analysis.risk}</strong>
              </div>
              <div>
                <small>Live quote</small>
                <strong>{liveQuote || "—"}</strong>
              </div>
            </div>
          </article>

          <article className="final-open-card">
            <span>EXECUTION STATE</span>
            <strong>
              {protectionPaused
                ? `PROTECTION · ${protectionSeconds}s`
                : mode === "live"
                  ? executionReady
                    ? `${learningPhase} · DERIV READY`
                    : "DERIV BLOCKED"
                  : totalOpenPaperTrades > 0
                    ? `${totalOpenPaperTrades} OPEN · ${currentMarketTrades.length} ON ${symbol}`
                    : `${learningPhase} · ${mode.toUpperCase()}`}
            </strong>
            <p>
              {totalOpenPaperTrades > 0
                ? `Turbo portfolio scanning continues · ${currentMarketDataCount} cached ticks on ${symbol}`
                : message}
            </p>
            <small>
              Selected account:{" "}
              {selectedAccountType || "none"}
            </small>
            <small>
              Pattern memory:{" "}
              {analysis.metrics.learnedSample || 0} samples ·{" "}
              {analysis.metrics.learnedWinRate || 50}% wins ·{" "}
              {currentPatternLiveReady
                ? "LIVE READY"
                : "LEARNING"}
            </small>
            <small>
              Phase: {learningPhase} · Scan #{scanCycle}:{" "}
              {scanRemainingSeconds}s · Slot {rapidSlotIndex + 1}/10 · Used{" "}
              {rapidSlotsUsed}/10 · Entry: {minuteEntryMode} · Loss streak:{" "}
              {recentLossStreak}
              {protectionPaused
                ? ` · resumes in ${protectionSeconds}s`
                : ""}
            </small>
          </article>
        </section>

        <section className="final-metrics-grid final-metrics-section">
          <Metric
            label="Momentum"
            value={analysis.metrics.momentum}
          />
          <Metric
            label="Trend"
            value={analysis.metrics.trend}
          />
          <Metric
            label="Volatility"
            value={analysis.metrics.volatility}
          />
          <Metric
            label="Entropy"
            value={`${analysis.metrics.entropy}%`}
          />
          <Metric
            label="Bayesian"
            value={`${analysis.metrics.bayesian}%`}
          />
          <Metric
            label="Transition"
            value={`${analysis.metrics.transition}%`}
          />
          <Metric
            label="Observed cycle"
            value={analysis.metrics.cycle || "None"}
          />
          <Metric
            label="Regime"
            value={analysis.metrics.regime}
          />
          <Metric
            label="Reversal risk"
            value={`${analysis.metrics.reversalRisk ?? 0}%`}
          />
          <Metric
            label="Consecutive"
            value={analysis.metrics.consecutiveDirection ?? 0}
          />
          <Metric
            label="Momentum decay"
            value={analysis.metrics.momentumDecay ?? "NO"}
          />
          <Metric
            label="Signal age"
            value={analysis.metrics.signalAge ?? 0}
          />
          <Metric
            label="Learned sample"
            value={analysis.metrics.learnedSample ?? 0}
          />
          <Metric
            label="Learned win rate"
            value={`${analysis.metrics.learnedWinRate ?? 50}%`}
          />
          <Metric
            label="Expected value"
            value={
              Number(analysis.metrics.expectedValue || 0) >= 0
                ? `+${analysis.metrics.expectedValue ?? 0}`
                : analysis.metrics.expectedValue ?? 0
            }
          />
          <Metric
            label="Learned P/L"
            value={`${Number(analysis.metrics.learnedProfit || 0) >= 0 ? "+" : ""}$${money(
              analysis.metrics.learnedProfit || 0
            )}`}
          />
          <Metric
            label="Live pattern gate"
            value={
              currentPatternLiveReady
                ? "READY"
                : "LEARNING"
            }
          />
          <Metric
            label="Cluster sample"
            value={analysis.metrics.clusterSample ?? 0}
          />
          <Metric
            label="Cluster win rate"
            value={`${analysis.metrics.clusterWinRate ?? 50}%`}
          />
          <Metric
            label="Cluster P/L"
            value={`${Number(analysis.metrics.clusterProfit || 0) >= 0 ? "+" : ""}$${money(
              analysis.metrics.clusterProfit || 0
            )}`}
          />
          <Metric
            label="Blacklist"
            value={
              analysis.metrics.exactBlacklisted ||
              analysis.metrics.clusterBlacklisted
                ? "BLOCKED"
                : "CLEAR"
            }
          />
          <Metric label="AI phase" value={learningPhase} />
          <Metric label="Loss streak" value={recentLossStreak} />
          <Metric
            label="Loss penalty"
            value={`-${analysis.metrics.recentLossPenalty ?? 0}`}
          />
          <Metric
            label="Required confirm"
            value={`${analysis.metrics.requiredConsecutive ?? 2}/4`}
          />
          <Metric
            label="Protection"
            value={
              protectionPaused
                ? `${protectionSeconds}s`
                : "READY"
            }
          />
          <Metric
            label="Adaptive gate"
            value={
              analysis.metrics.adaptiveMarketGate
                ? "PASSED"
                : "BLOCKED"
            }
          />
          <Metric
            label="Direction stability"
            value={`${analysis.metrics.directionStability ?? 0}%`}
          />
          <Metric
            label="Armed persistence"
            value={`${armedTicks}/3`}
          />
          <Metric
            label="Entry ready"
            value={stableEntryReady ? "YES" : "NO"}
          />
          <Metric
            label="Scan cycle"
            value={`#${scanCycle}`}
          />
          <Metric
            label="Scan remaining"
            value={`${scanRemainingSeconds}s`}
          />
          <Metric
            label="Signal freshness"
            value={
              analysis.metrics.signalFresh
                ? "FRESH"
                : "STALE"
            }
          />
          <Metric
            label="Best candidate"
            value={
              bestCandidate
                ? `${bestCandidate.contract} ${Math.round(
                    bestCandidate.score
                  )}`
                : "SCANNING"
            }
          />
          <Metric
            label="Selected setup"
            value={
              analysis.selectedSetup
                ? analysis.selectedSetup.label
                : "SCANNING"
            }
          />
          <Metric
            label="Setup score"
            value={
              analysis.selectedSetup
                ? `${analysis.selectedSetup.score}%`
                : "0%"
            }
          />
          <Metric
            label="Signal queue"
            value={`${signalQueue.length}/${maxQueueSize}`}
          />
          <Metric
            label="Best queued"
            value={
              bestQueuedSignal
                ? `${bestQueuedSignal.direction} ${bestQueuedSignal.score}%`
                : "NONE"
            }
          />
          <Metric
            label="Pattern tier"
            value={currentPatternTier}
          />
          <Metric
            label="Quality weight"
            value={`${currentPatternWeight.toFixed(2)}x`}
          />
          <Metric
            label="Quality threshold"
            value={`${qualityAdjustedThreshold}%`}
          />
          <Metric
            label="Elite memory"
            value={learningSummary.elitePatterns.length}
          />
          <Metric
            label="Gold memory"
            value={learningSummary.goldPatterns.length}
          />
          <Metric
            label="Weak memory"
            value={learningSummary.qualityWeakPatterns.length}
          />
          <Metric
            label="Connection lock"
            value={connectionLocked ? "LOCKED" : "READY"}
          />
          <Metric
            label="Stable market"
            value={lastStableSymbol || symbol || "WAIT"}
          />
          <Metric
            label="Feed state"
            value={
              loadingMarket
                ? "CONNECTING"
                : Number.isFinite(Number(liveQuote))
                  ? "STABLE"
                  : "WAIT"
            }
          />
          <Metric
            label="Turbo mode"
            value={turboMode ? "ON" : "OFF"}
          />
          <Metric
            label="Turbo pool"
            value={`${turboMarketPool.length} markets`}
          />
          <Metric
            label="Decision speed"
            value={`${marketSwitchSeconds}s rotation`}
          />
          <Metric
            label="Open portfolio"
            value={totalOpenPaperTrades}
          />
          <Metric
            label="Current market open"
            value={currentMarketTrades.length}
          />
          <Metric
            label="Market data"
            value={`${currentMarketDataCount} ticks`}
          />
          <Metric
            label="Markets cached"
            value={Object.keys(marketDataBank).length}
          />
          <Metric
            label="Market rotation"
            value={autoMarketSwitch ? "AUTO" : "MANUAL"}
          />
          <Metric
            label="Rapid slots used"
            value={`${rapidSlotsUsed}/10`}
          />
          <Metric
            label="Current slot"
            value={`${rapidSlotIndex + 1}/10`}
          />
          <Metric
            label="Slot status"
            value={rapidSlotUsed ? "USED" : "READY"}
          />
          <Metric
            label="Rapid score"
            value={`${analysis.rapidScore?.score || 0}%`}
          />
          <Metric
            label="Rapid direction"
            value={analysis.rapidScore?.direction || "NONE"}
          />
          <Metric
            label="Minute entry mode"
            value={minuteEntryMode}
          />
          <Metric
            label="Tick setup"
            value={analysis.tickSetup?.setup || "SCANNING"}
          />
          <Metric
            label="Tick direction"
            value={analysis.tickSetup?.contract || "NONE"}
          />
          <Metric
            label="Tick score"
            value={`${analysis.tickSetup?.score || 0}%`}
          />
          <Metric
            label="Tick consensus"
            value={`${analysis.tickSetup?.consensus || 0}%`}
          />
          <Metric
            label="Target ticks"
            value={minuteTargetTicks}
          />
          <Metric
            label="Vote direction"
            value={analysis.setupVoting?.direction || "NONE"}
          />
          <Metric
            label="Setup agreement"
            value={`${analysis.setupVoting?.agreementCount || 0}/${analysis.setupVoting?.totalPassedVotes || 0}`}
          />
          <Metric
            label="Agreement"
            value={`${analysis.setupVoting?.agreementPercent || 0}%`}
          />
          <Metric
            label="Tick pressure"
            value={`${analysis.setupVoting?.tickPressureScore || 0}%`}
          />
          <Metric
            label="Real confidence"
            value={`${analysis.setupVoting?.realConfidence || 0}%`}
          />
          <Metric
            label="Continuous score"
            value={`${analysis.continuousScore?.weightedEntryScore || 0}%`}
          />
          <Metric
            label="Entry threshold"
            value={`${adaptiveEntryThreshold}%`}
          />
          <Metric
            label="Tick flow weight"
            value={`${analysis.continuousScore?.tickFlowScore || 0}%`}
          />
          <Metric
            label="Momentum weight"
            value={`${analysis.continuousScore?.momentumScore || 0}%`}
          />
          <Metric
            label="Trend weight"
            value={`${analysis.continuousScore?.trendScore || 0}%`}
          />
          <Metric
            label="Transition weight"
            value={`${analysis.continuousScore?.transitionScore || 0}%`}
          />
          <Metric
            label="Bayesian weight"
            value={`${analysis.continuousScore?.bayesianScore || 0}%`}
          />
          <Metric
            label="Historical weight"
            value={`${analysis.continuousScore?.historicalScore || 0}%`}
          />
          <Metric
            label="Pattern weight"
            value={`${analysis.continuousScore?.patternScore || 0}%`}
          />
          <Metric
            label="Late entry gate"
            value={
              scanRemainingSeconds <= 15
                ? "OPEN"
                : `${scanRemainingSeconds - 15}s`
            }
          />
          <Metric
            label="Armed"
            value={
              analysis.metrics.armedQualified
                ? "YES"
                : "NO"
            }
          />
          <Metric
            label="Trend strength"
            value={`${analysis.metrics.trendStrength ?? 0}%`}
          />
          <Metric
            label="Bayesian target"
            value={`${analysis.metrics.bayesianThreshold ?? 70}%`}
          />
          <Metric
            label="Transition target"
            value={`${analysis.metrics.transitionThreshold ?? 70}%`}
          />
          <Metric
            label="EV target"
            value={`+${analysis.metrics.evThreshold ?? 0.12}`}
          />
          <Metric
            label="Rolling EV"
            value={
              Number(rollingExpectedValue || 0) >= 0
                ? `+${Number(rollingExpectedValue || 0).toFixed(3)}`
                : Number(rollingExpectedValue || 0).toFixed(3)
            }
          />
        </section>

        <section className="final-tick-windows">
          {(analysis.tickSetup?.windows || []).map((window) => (
            <article key={window.size}>
              <span>{window.size} ticks</span>
              <strong>{window.direction}</strong>
              <small>{window.dominance}% pressure</small>
            </article>
          ))}
        </section>

        <section className="final-score-engine">
          <div className="final-score-engine-head">
            <div>
              <span>CONTINUOUS TICK SCORE</span>
              <strong>
                {analysis.continuousScore?.direction || "NONE"} ·{" "}
                {analysis.continuousScore?.weightedEntryScore || 0}%
              </strong>
            </div>
            <div>
              <span>CURRENT THRESHOLD</span>
              <strong>{adaptiveEntryThreshold}%</strong>
            </div>
          </div>

          <div className="final-score-track">
            <div
              className="final-score-fill"
              style={{
                width: `${Math.min(
                  100,
                  Math.max(
                    0,
                    Number(
                      analysis.continuousScore?.weightedEntryScore ||
                        0
                    )
                  )
                )}%`,
              }}
            />
          </div>
        </section>

        <section className="final-v28-1-connection-bar">
          <div>
            <span>CONNECTION MODE</span>
            <strong>
              {connectionLocked
                ? "MARKET LOCKED · NO AUTO RECONNECT LOOP"
                : "ROTATION READY"}
            </strong>
          </div>

          <div>
            <span>ACTIVE FEED</span>
            <strong>
              {loadingMarket
                ? "CONNECTING"
                : `${symbol || lastStableSymbol} · STABLE`}
            </strong>
          </div>

          <div>
            <span>ROTATION RULE</span>
            <strong>
              {autoMarketSwitch
                ? `ONLY WHEN NO OPEN TRADE · ${marketSwitchSeconds}s`
                : "AUTO SWITCH OFF"}
            </strong>
          </div>
        </section>

        <section className="final-v28-strategy-lab">
          <div className="final-v28-strategy-head">
            <div>
              <span>STRONGEST STRATEGY</span>
              <strong>
                {strategyLab.best
                  ? `${strategyLab.best.direction} · ${strategyLab.best.composite}%`
                  : "SCANNING"}
              </strong>
              <small>
                {strategyLab.best?.strategy ||
                  "Comparing market setups"}
              </small>
            </div>

            <div>
              <span>TEST RESULT</span>
              <strong>
                {strategyLab.best
                  ? `${strategyLab.best.testsPassed}/5 PASSED`
                  : "0/5"}
              </strong>
              <small>
                {strategyLab.best?.qualified
                  ? "STRONG SIGNAL READY"
                  : "TESTING SETUPS"}
              </small>
            </div>
          </div>

          <div className="final-v28-test-grid">
            {(strategyLab.best?.tests || [
              { id: "a", label: "Setup consensus", passed: false },
              { id: "b", label: "Direction confirmation", passed: false },
              { id: "c", label: "Composite strength", passed: false },
              { id: "d", label: "Fresh tick signal", passed: false },
              { id: "e", label: "Pattern quality", passed: false },
            ]).map((test) => (
              <article
                key={test.id}
                className={test.passed ? "passed" : ""}
              >
                <span>{test.passed ? "PASS" : "TEST"}</span>
                <strong>{test.label}</strong>
              </article>
            ))}
          </div>
        </section>

        <section className="final-vote-summary">
          <article>
            <span>RISE votes</span>
            <strong>{analysis.setupVoting?.riseVotes || 0}</strong>
          </article>
          <article>
            <span>FALL votes</span>
            <strong>{analysis.setupVoting?.fallVotes || 0}</strong>
          </article>
          <article>
            <span>Selected direction</span>
            <strong>{analysis.setupVoting?.direction || "NONE"}</strong>
          </article>
          <article>
            <span>Entry requirement</span>
            <strong>
              {scanRemainingSeconds <= 15
                ? "2 votes + 68 pressure"
                : "3 matching votes"}
            </strong>
          </article>
        </section>

        <section className="final-setup-lanes">
          {(analysis.setupCandidates || []).map((setup) => (
            <article
              key={setup.id}
              className={
                setup.passed
                  ? "final-setup-lane passed"
                  : "final-setup-lane"
              }
            >
              <span>{setup.label}</span>
              <strong>
                {setup.contract} · {setup.score}%
              </strong>
              <small>
                {setup.passed ? "QUALIFIED" : "SCANNING"}
              </small>
            </article>
          ))}
        </section>

        <section className="final-stats-grid">
          <Metric label="Runs" value={stats.runs} />
          <Metric label="Wins" value={stats.wins} />
          <Metric label="Losses" value={stats.losses} />
          <Metric
            label="Win rate"
            value={`${stats.rate}%`}
          />
          <Metric
            label="Net P/L"
            value={`${stats.profit >= 0 ? "+" : ""}$${money(
              stats.profit
            )}`}
          />
        </section>

        <section className="final-v27-queue-panel">
          <div className="final-v27-queue-head">
            <div>
              <span>SIGNAL QUEUE</span>
              <strong>
                {signalQueue.length} fresh signals
              </strong>
            </div>
            <div>
              <span>BEST READY</span>
              <strong>
                {bestQueuedSignal
                  ? `${bestQueuedSignal.market} · ${bestQueuedSignal.direction} · ${bestQueuedSignal.score}%`
                  : "NONE"}
              </strong>
            </div>
          </div>

          <div className="final-v27-queue-list">
            {signalQueue.slice(0, 8).map((item) => (
              <article key={`${item.id}:${item.createdAt}`}>
                <span>{item.market}</span>
                <strong>{item.direction}</strong>
                <small>
                  {item.score}% · {item.tier}
                </small>
                <small>
                  {item.strategy || "Composite strategy"}
                </small>
              </article>
            ))}

            {signalQueue.length === 0 ? (
              <article className="empty">
                <span>SCANNING</span>
                <strong>NO FRESH SIGNAL</strong>
                <small>
                  Signals expire after 4.5 seconds
                </small>
              </article>
            ) : null}
          </div>
        </section>

        <section className="final-v26-quality-grid">
          <article className="final-v26-quality-card elite">
            <span>ELITE MEMORY</span>
            <strong>
              {learningSummary.elitePatterns.length}
            </strong>
            <small>
              10+ samples · 80%+ wins · positive P/L
            </small>
          </article>

          <article className="final-v26-quality-card gold">
            <span>GOLD MEMORY</span>
            <strong>
              {learningSummary.goldPatterns.length}
            </strong>
            <small>
              5+ samples · 70%+ wins · positive P/L
            </small>
          </article>

          <article className="final-v26-quality-card normal">
            <span>NORMAL MEMORY</span>
            <strong>
              {learningSummary.normalPatterns.length}
            </strong>
            <small>
              Still collecting quality evidence
            </small>
          </article>

          <article className="final-v26-quality-card weak">
            <span>WEAK / PRUNED</span>
            <strong>
              {learningSummary.qualityWeakPatterns.length}
            </strong>
            <small>
              Weak setups are blocked and deleted after repeated losses
            </small>
          </article>
        </section>

        <section id="final-trades" className="final-bottom-grid final-section-anchor">
          <article className="final-panel">
            <div className="final-panel-title">
              <div>
                <span>TRANSACTIONS</span>
                <h2>
                  Paper and Deriv contract results
                </h2>
              </div>
              <div className="final-clear-actions">
                <button
                  onClick={() => {
                    setTransactions([]);
                    try {
                      window.localStorage.removeItem(
                        FINAL_AI_HISTORY_KEY
                      );
                    } catch {
                      // Ignore storage errors.
                    }
                  }}
                >
                  Clear trades
                </button>
                <button
                  onClick={() => {
                    setAdaptiveMemory({});
                    setClusterMemory({});
                    try {
                      window.localStorage.removeItem(
                        FINAL_AI_MEMORY_KEY
                      );
                      window.localStorage.removeItem(
                        FINAL_AI_CLUSTER_KEY
                      );
                    } catch {
                      // Ignore storage errors.
                    }
                  }}
                >
                  Reset memory
                </button>
              </div>
            </div>

            <div className="final-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Source</th>
                    <th>Market</th>
                    <th>Contract</th>
                    <th>Entry / Exit</th>
                    <th>Confidence</th>
                    <th>Result</th>
                    <th>P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((item) => (
                    <tr key={item.id}>
                      <td>{item.closedAt}</td>
                      <td>{item.source}</td>
                      <td>{item.market}</td>
                      <td>{item.contract}</td>
                      <td>
                        {item.entry} / {item.exit}
                      </td>
                      <td>
                        {item.confidence ?? "—"}%
                      </td>
                      <td
                        className={
                          item.result === "WON"
                            ? "final-win"
                            : "final-loss"
                        }
                      >
                        {item.result}
                      </td>
                      <td
                        className={
                          item.profit >= 0
                            ? "final-win"
                            : "final-loss"
                        }
                      >
                        {item.profit >= 0 ? "+" : ""}$
                        {money(item.profit)}
                      </td>
                    </tr>
                  ))}

                  {!transactions.length && (
                    <tr>
                      <td
                        colSpan="8"
                        className="final-empty"
                      >
                        No completed transactions yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="final-panel">
            <div className="final-panel-title">
              <div>
                <span>DECISION JOURNAL</span>
                <h2>
                  Why Final AI waited or entered
                </h2>
              </div>
              <button onClick={() => setJournal([])}>
                Clear
              </button>
            </div>

            <div className="final-journal">
              {journal.map((item) => (
                <div
                  key={item.id}
                  className="final-journal-row"
                >
                  <time>{item.time}</time>
                  <strong>{item.decision}</strong>
                  <span>{item.contract}</span>
                  <span>{item.confidence}%</span>
                  <span>{item.risk}</span>
                  <p>{item.reason}</p>
                </div>
              ))}

              {!journal.length && (
                <div className="final-empty">
                  Waiting for shared Deriv ticks…
                </div>
              )}
            </div>
          </article>
        </section>


        <section id="final-learning" className="final-learning-dashboard final-section-anchor">
          <div className="final-learning-head">
            <div>
              <span>ADAPTIVE PATTERN DATABASE</span>
              <h2>Learning dashboard</h2>
            </div>

            <div className="final-learning-summary">
              <Metric
                label="Patterns"
                value={learningSummary.totalPatterns}
              />
              <Metric
                label="Samples"
                value={learningSummary.totalSamples}
              />
              <Metric
                label="Global wins"
                value={`${Math.round(
                  learningSummary.globalWinRate
                )}%`}
              />
              <Metric
                label="Profitable"
                value={learningSummary.profitablePatterns}
              />
              <Metric
                label="Blocked"
                value={learningSummary.blockedPatterns}
              />
              <Metric
                label="Learned P/L"
                value={`${learningSummary.totalProfit >= 0 ? "+" : ""}$${money(
                  learningSummary.totalProfit
                )}`}
              />
              <Metric
                label="Last 100 win rate"
                value={`${Math.round(
                  recentPerformance.winRate
                )}%`}
              />
              <Metric
                label="Last 100 P/L"
                value={`${recentPerformance.profit >= 0 ? "+" : ""}$${money(
                  recentPerformance.profit
                )}`}
              />
              <Metric
                label="Avg confidence"
                value={`${Math.round(
                  recentPerformance.averageConfidence
                )}%`}
              />
            </div>
          </div>

          <div className="final-pattern-highlight-grid">
            <article className="final-pattern-highlight final-pattern-best">
              <span>BEST PATTERN</span>
              <strong>
                {learningSummary.bestPattern
                  ? `${learningSummary.bestPattern.market} · ${Math.round(
                      learningSummary.bestPattern.winRate
                    )}%`
                  : "LEARNING"}
              </strong>
              <small>
                {learningSummary.bestPattern
                  ? `${learningSummary.bestPattern.sample} samples · ${
                      learningSummary.bestPattern.profit >= 0 ? "+" : ""
                    }$${money(learningSummary.bestPattern.profit)}`
                  : "Needs profitable repeated samples"}
              </small>
            </article>

            <article className="final-pattern-highlight final-pattern-worst">
              <span>WORST PATTERN</span>
              <strong>
                {learningSummary.worstPattern
                  ? `${learningSummary.worstPattern.market} · ${Math.round(
                      learningSummary.worstPattern.winRate
                    )}%`
                  : "NONE BLOCKED"}
              </strong>
              <small>
                {learningSummary.worstPattern
                  ? `${learningSummary.worstPattern.sample} samples · ${
                      learningSummary.worstPattern.profit >= 0 ? "+" : ""
                    }$${money(learningSummary.worstPattern.profit)}`
                  : "No repeated losing pattern yet"}
              </small>
            </article>

            <article className="final-pattern-highlight">
              <span>LAST 100 TRADES</span>
              <strong>
                {recentPerformance.wins}W / {recentPerformance.losses}L
              </strong>
              <small>
                {recentPerformance.sample} settled ·{" "}
                {Math.round(recentPerformance.winRate)}% wins
              </small>
            </article>

            <article className="final-pattern-highlight">
              <span>LIVE GATE</span>
              <strong>
                {currentPatternLiveReady
                  ? "READY"
                  : "LEARNING"}
              </strong>
              <small>
                8 samples · 60% wins · positive pattern P/L and EV
              </small>
            </article>

            <article className="final-pattern-highlight final-phase-card">
              <span>AI PHASE</span>
              <strong>{learningPhase}</strong>
              <small>
                {learningPhase === "LEARN"
                  ? "Collecting paper outcomes"
                  : learningPhase === "VALIDATE"
                    ? "Checking repeated pattern quality"
                    : learningPhase === "PROTECTION"
                      ? `Paused ${protectionSeconds}s after losses`
                      : "Pattern is mature for guarded execution"}
              </small>
            </article>
          </div>

          <div id="final-patterns" className="final-learning-grid final-section-anchor">
            <article className="final-panel">
              <div className="final-panel-title">
                <div>
                  <span>TOP PATTERNS</span>
                  <h2>Best learned setups</h2>
                </div>
              </div>

              <div className="final-pattern-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th>Pattern</th>
                      <th>Sample</th>
                      <th>Wins</th>
                      <th>Win rate</th>
                      <th>P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {learningSummary.topPatterns.map(
                      (row) => (
                        <tr key={row.key}>
                          <td>{row.market}</td>
                          <td title={row.signature}>
                            {row.signature}
                          </td>
                          <td>{row.sample}</td>
                          <td>
                            {row.wins}/{row.losses}
                          </td>
                          <td className="final-win">
                            {Math.round(row.winRate)}%
                          </td>
                          <td
                            className={
                              row.profit >= 0
                                ? "final-win"
                                : "final-loss"
                            }
                          >
                            {row.profit >= 0 ? "+" : ""}$
                            {money(row.profit)}
                          </td>
                        </tr>
                      )
                    )}

                    {!learningSummary.topPatterns.length && (
                      <tr>
                        <td
                          colSpan="6"
                          className="final-empty"
                        >
                          Learning needs at least two
                          samples for a pattern.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>

            <article className="final-panel">
              <div className="final-panel-title">
                <div>
                  <span>WEAK PATTERNS</span>
                  <h2>Setups to avoid</h2>
                </div>
              </div>

              <div className="final-pattern-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th>Pattern</th>
                      <th>Sample</th>
                      <th>Losses</th>
                      <th>Win rate</th>
                      <th>P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {learningSummary.weakPatterns.map(
                      (row) => (
                        <tr key={row.key}>
                          <td>{row.market}</td>
                          <td title={row.signature}>
                            {row.signature}
                          </td>
                          <td>{row.sample}</td>
                          <td>
                            {row.losses}/{row.wins}
                          </td>
                          <td className="final-loss">
                            {Math.round(row.winRate)}%
                          </td>
                          <td
                            className={
                              row.profit >= 0
                                ? "final-win"
                                : "final-loss"
                            }
                          >
                            {row.profit >= 0 ? "+" : ""}$
                            {money(row.profit)}
                          </td>
                        </tr>
                      )
                    )}

                    {!learningSummary.weakPatterns.length && (
                      <tr>
                        <td
                          colSpan="6"
                          className="final-empty"
                        >
                          No weak learned patterns yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          </div>
        </section>

        <footer className="final-disclaimer">
          Live execution is guarded by Deriv authentication,
          account selection, confidence threshold and a manual
          real-account lock. No analysis score guarantees profit.
        </footer>
      </main>
    </div>
  );
}
