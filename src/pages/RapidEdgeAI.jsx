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
import "../styles/RapidEdgeAI.css";

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, Number(value || 0)));

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function symbolOf(item) {
  return String(
    item?.symbol ??
      item?.value ??
      item?.id ??
      ""
  );
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

function lastDigitOf(item) {
  const quote = quoteOf(item);

  if (!Number.isFinite(quote)) return null;

  const normalized = quote.toFixed(5).replace(".", "");
  const digit = Number(normalized.at(-1));

  return Number.isInteger(digit) ? digit : null;
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
      (
        Number(item?.sell_price || 0) -
        Number(item?.buy_price || 0)
      )
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

function theoreticalWinRate(side, barrier) {
  if (side === "OVER") {
    return ((9 - Number(barrier)) / 10) * 100;
  }

  return (Number(barrier) / 10) * 100;
}

function estimatedProfitRatio(side, barrier) {
  const probability = theoreticalWinRate(side, barrier) / 100;

  return Math.max(
    0.05,
    0.94 / Math.max(0.1, probability) - 1
  );
}

function candidateKey(candidate, symbol) {
  return [
    String(symbol || ""),
    String(candidate?.side || ""),
    Number(candidate?.barrier ?? -1),
  ].join(":");
}


function recentSettledTrades(trades, limit = 20) {
  return (Array.isArray(trades) ? trades : [])
    .filter((trade) =>
      ["WON", "LOST"].includes(
        String(trade?.status || "")
      )
    )
    .slice(0, limit);
}

function performanceSummary(trades) {
  const settled = recentSettledTrades(trades, 20);
  const wins = settled.filter(
    (trade) => trade.status === "WON"
  ).length;
  const losses = settled.length - wins;
  const profit = settled.reduce(
    (total, trade) =>
      total + Number(trade?.profit || 0),
    0
  );

  return {
    count: settled.length,
    wins,
    losses,
    profit,
    winRate: settled.length
      ? (wins / settled.length) * 100
      : 50,
  };
}

function candidatePerformance(
  trades,
  symbol,
  candidate
) {
  if (!candidate) {
    return {
      count: 0,
      winRate: 50,
      profit: 0,
      lossStreak: 0,
    };
  }

  const matching = recentSettledTrades(
    trades,
    60
  ).filter(
    (trade) =>
      String(trade?.symbol || "") ===
        String(symbol || "") &&
      String(trade?.side || "") ===
        String(candidate.side || "") &&
      Number(trade?.barrier) ===
        Number(candidate.barrier)
  );

  let lossStreak = 0;

  for (const trade of matching) {
    if (trade.status !== "LOST") break;
    lossStreak += 1;
  }

  const wins = matching.filter(
    (trade) => trade.status === "WON"
  ).length;

  return {
    count: matching.length,
    winRate: matching.length
      ? (wins / matching.length) * 100
      : 50,
    profit: matching.reduce(
      (total, trade) =>
        total + Number(trade?.profit || 0),
      0
    ),
    lossStreak,
  };
}

function marketPerformance(trades, symbol) {
  const matching = recentSettledTrades(
    trades,
    80
  ).filter(
    (trade) =>
      String(trade?.symbol || "") ===
      String(symbol || "")
  );

  let lossStreak = 0;

  for (const trade of matching) {
    if (trade.status !== "LOST") break;
    lossStreak += 1;
  }

  const wins = matching.filter(
    (trade) => trade.status === "WON"
  ).length;

  return {
    count: matching.length,
    winRate: matching.length
      ? (wins / matching.length) * 100
      : 50,
    profit: matching.reduce(
      (total, trade) =>
        total + Number(trade?.profit || 0),
      0
    ),
    lossStreak,
  };
}

function enrichCandidate(
  candidate,
  trades,
  symbol
) {
  if (!candidate) return null;

  const global = performanceSummary(trades);
  const contract = candidatePerformance(
    trades,
    symbol,
    candidate
  );
  const market = marketPerformance(
    trades,
    symbol
  );

  const marketQuality = clamp(
    Number(candidate.consistency || 0) * 0.45 +
      Number(candidate.probability || 0) * 0.25 +
      market.winRate * 0.20 +
      Math.max(
        0,
        Math.min(10, market.profit * 20)
      ),
    0,
    100
  );

  const executionConfidence = clamp(
    Number(candidate.probability || 0) * 0.42 +
      Math.max(
        0,
        Number(candidate.expectedValue || 0) *
          120
      ) +
      contract.winRate * 0.20 +
      global.winRate * 0.12 +
      Number(candidate.consistency || 0) *
        0.16 -
      contract.lossStreak * 10 -
      market.lossStreak * 8,
    0,
    100
  );

  const adaptiveRisk = clamp(
    Number(candidate.risk || 100) +
      contract.lossStreak * 13 +
      market.lossStreak * 10 +
      Math.max(0, 60 - contract.winRate) *
        0.25,
    0,
    100
  );

  const qualityScore = clamp(
    Number(candidate.probability || 0) * 0.35 +
      Math.max(
        0,
        Number(candidate.expectedValue || 0) *
          100
      ) *
        0.25 +
      marketQuality * 0.20 +
      executionConfidence * 0.20 -
      adaptiveRisk * 0.15,
    0,
    100
  );

  const calibratedProbability = clamp(
    Number(candidate.probability || 0) * 0.58 +
      contract.winRate * 0.16 +
      market.winRate * 0.14 +
      global.winRate * 0.12 -
      contract.lossStreak * 8 -
      market.lossStreak * 7,
    5,
    96
  );

  return {
    ...candidate,
    marketQuality,
    executionConfidence,
    adaptiveRisk,
    qualityScore,
    calibratedProbability,
    contractWinRate: contract.winRate,
    contractLossStreak: contract.lossStreak,
    marketWinRate: market.winRate,
    marketLossStreak: market.lossStreak,
    recentGlobalWinRate: global.winRate,
  };
}

function analyzeSpeedCandidates(digits) {
  const clean = (Array.isArray(digits) ? digits : [])
    .map(Number)
    .filter(
      (digit) =>
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-60);

  if (clean.length < 8) {
    return {
      sample: clean.length,
      candidates: [],
      best: null,
    };
  }

  const short = clean.slice(-20);
  const medium = clean.slice(-40);

  const rows = [];

  for (const side of ["OVER", "UNDER"]) {
    const barriers =
      side === "OVER"
        ? [1, 2, 3, 4]
        : [5, 6, 7, 8];

    for (const barrier of barriers) {
      const wins = (sample) =>
        sample.filter((digit) =>
          side === "OVER"
            ? digit > barrier
            : digit < barrier
        ).length;

      const pShort =
        (wins(short) / Math.max(1, short.length)) * 100;
      const pMedium =
        (wins(medium) / Math.max(1, medium.length)) * 100;
      const pLong =
        (wins(clean) / Math.max(1, clean.length)) * 100;

      const probability =
        pShort * 0.52 +
        pMedium * 0.30 +
        pLong * 0.18;

      const profitRatio =
        estimatedProfitRatio(side, barrier);

      const expectedValue =
        (probability / 100) * profitRatio -
        (1 - probability / 100);

      const consistency =
        100 -
        Math.min(
          100,
          Math.abs(pShort - pMedium) * 2.2 +
            Math.abs(pMedium - pLong) * 1.4
        );

      const votes = [
        pShort >= theoreticalWinRate(side, barrier),
        pMedium >= theoreticalWinRate(side, barrier),
        pLong >= theoreticalWinRate(side, barrier),
        expectedValue >= 0,
        consistency >= 55,
      ].filter(Boolean).length;

      const overOnePenalty =
        side === "OVER" && barrier === 1
          ? probability >= 92 && expectedValue >= 0.02
            ? 0
            : 16
          : 0;

      const risk = clamp(
        100 - consistency +
          Math.max(0, 70 - probability) * 0.55 +
          Math.max(0, -expectedValue * 100) * 1.5,
        0,
        100
      );

      const score = clamp(
        probability * 0.46 +
          consistency * 0.20 +
          votes * 6 +
          expectedValue * 120 -
          risk * 0.18 -
          overOnePenalty,
        0,
        100
      );

      rows.push({
        side,
        barrier,
        probability,
        expectedValue,
        profitRatio,
        consistency,
        votes,
        risk,
        score,
        contract: `${side} ${barrier}`,
      });
    }
  }

  rows.sort((a, b) => {
    const evDifference =
      Number(b.expectedValue || 0) -
      Number(a.expectedValue || 0);

    if (Math.abs(evDifference) >= 0.008) {
      return evDifference;
    }

    return Number(b.score || 0) - Number(a.score || 0);
  });

  return {
    sample: clean.length,
    candidates: rows,
    best: rows[0] || null,
  };
}

function ladderQualification(candidate, ageMs) {
  if (!candidate) {
    return {
      qualified: false,
      stage: "WARMING",
      reason: "NO_CANDIDATE",
    };
  }

  const probability = Number(candidate.probability || 0);
  const expectedValue = Number(candidate.expectedValue || -1);
  const votes = Number(candidate.votes || 0);
  const risk = Number(candidate.risk || 100);

  if (ageMs < 3000) {
    return {
      qualified:
        probability >= 74 &&
        expectedValue >= 0.005 &&
        votes >= 3 &&
        risk <= 52,
      stage: "STRICT",
      reason: "STRICT_GATE",
    };
  }

  if (ageMs < 6000) {
    return {
      qualified:
        probability >= 69 &&
        expectedValue >= 0 &&
        votes >= 2 &&
        risk <= 58,
      stage: "BALANCED",
      reason: "BALANCED_GATE",
    };
  }

  return {
    qualified:
      probability >= 65 &&
      expectedValue >= -0.004 &&
      votes >= 2 &&
      risk <= 62,
    stage: ageMs >= 8000 ? "WATCHDOG" : "RELAXED",
    reason: "WATCHDOG_GATE",
  };
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

export default function RapidEdgeAI() {
  const {
    markets = [],
    symbol = "",
    connected = false,
    authenticatedFeed = false,
    loadingMarket = false,
    prices = [],
    digitHistory = [],
    currentPrice = null,
    lastDigit = null,
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
  const [stake, setStake] = useState(0.35);
  const [durationTicks, setDurationTicks] = useState(1);
  const [allowReal, setAllowReal] = useState(false);
  const [message, setMessage] = useState(
    "RapidEdge V4 Speed Core is ready."
  );
  const [trades, setTrades] = useState([]);
  const [clock, setClock] = useState(Date.now());
  const [lastSettlementAt, setLastSettlementAt] =
    useState(Date.now());
  const [lastLossKey, setLastLossKey] = useState("");
  const [lastLossAt, setLastLossAt] = useState(0);
  const [lastEntryAt, setLastEntryAt] = useState(0);
  const [marketEnteredAt, setMarketEnteredAt] =
    useState(Date.now());
  const [switches, setSwitches] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [pauseUntil, setPauseUntil] = useState(0);
  const [marketBlocks, setMarketBlocks] = useState({});
  const [contractBlocks, setContractBlocks] = useState({});
  const [postLossAnchorCount, setPostLossAnchorCount] = useState(null);
  const [postLossMarket, setPostLossMarket] = useState("");
  const [confirmationAnchor, setConfirmationAnchor] = useState(null);
  const [executionAttempts, setExecutionAttempts] = useState(0);
  const [executionSuccesses, setExecutionSuccesses] = useState(0);
  const [executionFailures, setExecutionFailures] = useState(0);
  const [lastExecutionError, setLastExecutionError] = useState("");
  const [lastBuyRequestAt, setLastBuyRequestAt] = useState(0);
  const [loopStatus, setLoopStatus] = useState("IDLE");

  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const recentRunTimesRef = useRef([]);
  const audioRef = useRef(null);

  const marketSymbols = useMemo(
    () =>
      (Array.isArray(markets) ? markets : [])
        .map(symbolOf)
        .filter(Boolean),
    [markets]
  );

  const digits = useMemo(() => {
    const direct = (
      Array.isArray(digitHistory)
        ? digitHistory
        : []
    )
      .map(Number)
      .filter(
        (digit) =>
          Number.isInteger(digit) &&
          digit >= 0 &&
          digit <= 9
      );

    if (direct.length) {
      return direct.slice(-60);
    }

    return (Array.isArray(prices) ? prices : [])
      .map(lastDigitOf)
      .filter((digit) => digit !== null)
      .slice(-60);
  }, [digitHistory, prices]);

  const analysis = useMemo(
    () => analyzeSpeedCandidates(digits),
    [digits]
  );

  const digitQuality = useMemo(() => {
    const unique = new Set(digits);
    const allSame =
      digits.length >= 8 && unique.size <= 1;

    return {
      count: digits.length,
      unique: unique.size,
      allSame,
      ready:
        digits.length >= 12 &&
        unique.size >= 3,
    };
  }, [digits]);


  const postLossTicksCollected =
    postLossAnchorCount === null
      ? 999
      : Math.max(
          0,
          digits.length -
            Number(postLossAnchorCount || 0)
        );

  const postLossRevalidated =
    postLossAnchorCount === null ||
    postLossTicksCollected >= 24;

  const confirmationTicksCollected =
    confirmationAnchor === null
      ? 999
      : Math.max(
          0,
          digits.length -
            Number(confirmationAnchor || 0)
        );

  const blockedLossKey =
    clock - lastLossAt < 4000
      ? lastLossKey
      : "";

  const rankedCandidates = useMemo(() => {
    const now = Date.now();

    return analysis.candidates
      .map((candidate) =>
        enrichCandidate(
          candidate,
          trades,
          symbol
        )
      )
      .filter(Boolean)
      .filter((candidate) => {
        const key = candidateKey(
          candidate,
          symbol
        );

        return (
          key !== blockedLossKey &&
          Number(contractBlocks[key] || 0) <=
            now
        );
      })
      .sort(
        (a, b) =>
          Number(b.qualityScore || 0) -
          Number(a.qualityScore || 0)
      );
  }, [
    analysis.candidates,
    trades,
    symbol,
    blockedLossKey,
    contractBlocks,
    clock,
  ]);

  const marketBlocked =
    Number(marketBlocks[symbol] || 0) >
    clock;

  const best =
    digitQuality.ready &&
    !marketBlocked
      ? rankedCandidates[0] || null
      : null;

  const scanAgeMs =
    clock -
    Math.max(
      Number(lastSettlementAt || 0),
      Number(marketEnteredAt || 0)
    );

  const baseLadder = ladderQualification(
    best,
    scanAgeMs
  );

  const qualityReady =
    Boolean(best) &&
    Number(best.expectedValue || -1) > 0 &&
    Number(best.marketQuality || 0) >= 75 &&
    Number(
      best.executionConfidence || 0
    ) >= 80 &&
    Number(best.adaptiveRisk || 100) < 20 &&
    Number(best.qualityScore || 0) >= 78 &&
    Number(best.contractLossStreak || 0) ===
      0 &&
    Number(best.marketLossStreak || 0) === 0 &&
    postLossRevalidated;

  const immediateQualityEntry =
    qualityReady &&
    Number(best.calibratedProbability || 0) >=
      90 &&
    Number(best.executionConfidence || 0) >=
      88;

  const confirmationRequired =
    qualityReady &&
    Number(best.calibratedProbability || 0) >=
      82 &&
    Number(best.calibratedProbability || 0) < 90;

  const confirmedQualityEntry =
    confirmationRequired &&
    confirmationTicksCollected >= 2;

  const oneMinuteFallback =
    Boolean(best) &&
    digitQuality.ready &&
    qualityReady &&
    scanAgeMs >= 45000 &&
    Number(best.calibratedProbability || 0) >=
      80 &&
    Number(best.qualityScore || 0) >= 80 &&
    confirmationTicksCollected >= 2;

  const ladder = {
    ...baseLadder,
    qualified:
      immediateQualityEntry ||
      confirmedQualityEntry ||
      oneMinuteFallback,
    stage: immediateQualityEntry
      ? "QUALITY_FAST"
      : oneMinuteFallback
      ? "60S_QUALITY"
      : confirmedQualityEntry
      ? "QUALITY_2T_CONFIRM"
      : confirmationRequired
      ? "WAIT_2_TICKS"
      : postLossRevalidated
      ? baseLadder.stage
      : "POST_LOSS_RECHECK",
  };

  const hasOpenTrade = trades.some(
    (trade) => trade.status === "OPEN"
  );

  const runsThisMinute = useMemo(() => {
    const cutoff = clock - 60000;

    return recentRunTimesRef.current.filter(
      (time) => time >= cutoff
    ).length;
  }, [clock, trades]);

  const stats = useMemo(() => {
    const settled = trades.filter((trade) =>
      ["WON", "LOST"].includes(trade.status)
    );
    const wins = settled.filter(
      (trade) => trade.status === "WON"
    ).length;
    const losses = settled.length - wins;
    const profit = settled.reduce(
      (total, trade) =>
        total + Number(trade.profit || 0),
      0
    );

    return {
      runs: settled.length,
      wins,
      losses,
      profit,
      winRate: settled.length
        ? (wins / settled.length) * 100
        : 0,
    };
  }, [trades]);

  const playTone = useCallback(
    async (type) => {
      if (!soundEnabled) return;

      try {
        const AudioContextClass =
          window.AudioContext ||
          window.webkitAudioContext;

        if (!AudioContextClass) return;

        if (!audioRef.current) {
          audioRef.current =
            new AudioContextClass();
        }

        const context = audioRef.current;

        if (context.state === "suspended") {
          await context.resume();
        }

        const oscillator =
          context.createOscillator();
        const gain = context.createGain();
        const now = context.currentTime;

        oscillator.type =
          type === "LOST"
            ? "triangle"
            : "sine";

        oscillator.frequency.setValueAtTime(
          type === "WON"
            ? 1120
            : type === "LOST"
            ? 240
            : 620,
          now
        );

        if (type === "LOST") {
          oscillator.frequency.exponentialRampToValueAtTime(
            130,
            now + 0.28
          );
        }

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(
          0.07,
          now + 0.01
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          now + 0.32
        );

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.34);
      } catch {
        // Audio is optional.
      }
    },
    [soundEnabled]
  );

  const rotateMarket = useCallback(
    async (reason) => {
      if (
        !marketSymbols.length ||
        loadingMarket ||
        hasOpenTrade
      ) {
        return;
      }

      const currentIndex = Math.max(
        0,
        marketSymbols.indexOf(symbol)
      );

      const next =
        marketSymbols[
          (currentIndex + 1) %
            marketSymbols.length
        ];

      if (!next || next === symbol) return;

      setMessage(
        `${reason} · switching ${symbol} → ${next}`
      );
      setMarketEnteredAt(Date.now());
      setSwitches((value) => value + 1);

      try {
        await changeSymbol(next);
      } catch (error) {
        setMessage(
          error?.message ||
            "Market switch failed."
        );
      }
    },
    [
      marketSymbols,
      loadingMarket,
      hasOpenTrade,
      symbol,
      changeSymbol,
    ]
  );

  const executeTrade = useCallback(
    async () => {
      if (
        !running ||
        !connected ||
        !best ||
        !ladder.qualified ||
        hasOpenTrade ||
        busyRef.current
      ) {
        return false;
      }

      const now = Date.now();

      if (now - lastBuyRequestAt < 650) {
        return false;
      }

      if (
        !authenticatedFeed ||
        !selectedAccountId
      ) {
        setLastExecutionError(
          "Choose a connected Deriv Demo or Real account."
        );
        setMessage(
          "EXECUTION BLOCKED · authenticated Deriv account is not ready."
        );
        return false;
      }

      if (
        selectedAccountType !== "demo" &&
        !allowReal
      ) {
        setRunning(false);
        setLastExecutionError(
          "Real execution is locked."
        );
        setMessage(
          "Real execution is locked. Enable it manually."
        );
        return false;
      }

      recentRunTimesRef.current =
        recentRunTimesRef.current.filter(
          (time) => time >= now - 60000
        );

      if (
        recentRunTimesRef.current.length >= 20
      ) {
        setMessage(
          "20-runs-per-minute cap reached."
        );
        return false;
      }

      if (now - lastEntryAt < 2200) {
        return false;
      }

      busyRef.current = true;
      setLoopStatus("BUY_SENT");
      setLastBuyRequestAt(now);
      setExecutionAttempts((value) => value + 1);
      setLastExecutionError("");
      setMessage(
        `BUY REQUEST · ${best.contract} · ${pct(
          best.calibratedProbability
        )} · ${ladder.stage}`
      );

      try {
        const request = Promise.resolve(
          placeTrade({
            symbol,
            contractType:
              best.side === "OVER"
                ? "DIGITOVER"
                : "DIGITUNDER",
            amount: Math.max(
              0.35,
              Number(stake || 0.35)
            ),
            basis: "stake",
            duration: Math.max(
              1,
              Number(durationTicks || 1)
            ),
            durationUnit: "t",
            barrier: String(best.barrier),
          })
        );

        const timeout = new Promise((_, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                "Deriv buy request timed out after 12 seconds."
              )
            );
          }, 12000);
        });

        const result = await Promise.race([
          request,
          timeout,
        ]);

        const contractId = String(
          result?.contractId ||
            result?.contract_id ||
            result?.buy?.contract_id ||
            result?.raw?.buy?.contract_id ||
            result?.raw?.data?.buy?.contract_id ||
            ""
        );

        if (!contractId) {
          throw new Error(
            "Deriv purchase returned no contract ID."
          );
        }

        const trade = {
          id: contractId,
          contractId,
          symbol,
          side: best.side,
          barrier: best.barrier,
          contract: best.contract,
          stake: Number(stake || 0.35),
          probability: best.calibratedProbability,
          rawProbability: best.probability,
          expectedValue: best.expectedValue,
          stage: ladder.stage,
          status: "OPEN",
          profit: 0,
          createdAt: now,
        };

        recentRunTimesRef.current.push(now);
        setLastEntryAt(now);
        setTrades((current) => [
          trade,
          ...current,
        ].slice(0, 100));
        setMessage(
          `OPENED ${best.contract} · contract ${contractId} · ${ladder.stage}`
        );

        if (typeof refreshContract === "function") {
          Promise.resolve(
            refreshContract(contractId)
          ).catch(() => {});
        }

        setExecutionSuccesses((value) => value + 1);
        setLoopStatus("BUY_SUCCESS");
        void playTone("OPEN");
        return true;
      } catch (error) {
        const failure =
          error instanceof Error
            ? error.message
            : tradeError || "Trade failed.";

        setExecutionFailures((value) => value + 1);
        setLastExecutionError(failure);
        setLoopStatus("BUY_FAILED");
        setMessage(`BUY FAILED · ${failure}`);
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [
      running,
      connected,
      authenticatedFeed,
      selectedAccountId,
      best,
      ladder,
      hasOpenTrade,
      selectedAccountType,
      allowReal,
      lastEntryAt,
      lastBuyRequestAt,
      placeTrade,
      refreshContract,
      symbol,
      stake,
      durationTicks,
      tradeError,
      playTone,
    ]
  );

  const executionBlockReason = useMemo(() => {
    if (!running) return "BOT_STOPPED";
    if (!connected) return "FEED_OFFLINE";
    if (!authenticatedFeed) return "AUTH_NOT_READY";
    if (!selectedAccountId) return "ACCOUNT_NOT_SELECTED";
    if (pauseUntil > clock) {
      return "LOSS_PAUSE";
    }
    if (marketBlocked) {
      return "MARKET_BLOCKED";
    }
    if (!postLossRevalidated) {
      return `POST_LOSS_TICKS_${postLossTicksCollected}_OF_24`;
    }
    if (!digitQuality.ready) {
      return digitQuality.allSame
        ? "BAD_TICK_DECIMALS"
        : "WAITING_LIVE_DIGITS";
    }
    if (!best) return "NO_CANDIDATE";
    if (!qualityReady) {
      return "QUALITY_GATE";
    }
    if (
      confirmationRequired &&
      confirmationTicksCollected < 2
    ) {
      return `CONFIRM_TICKS_${confirmationTicksCollected}_OF_2`;
    }
    if (!ladder.qualified) return "NOT_QUALIFIED";
    if (hasOpenTrade) return "OPEN_TRADE_EXISTS";
    if (busyRef.current) return "LOCAL_BUY_BUSY";
    if (Date.now() - lastEntryAt < 2200) {
      return "ENTRY_GAP";
    }
    if (
      selectedAccountType !== "demo" &&
      !allowReal
    ) {
      return "REAL_LOCKED";
    }
    return "READY_TO_BUY";
  }, [
    running,
    connected,
    authenticatedFeed,
    selectedAccountId,
    pauseUntil,
    marketBlocked,
    postLossRevalidated,
    postLossTicksCollected,
    digitQuality.ready,
    digitQuality.allSame,
    best,
    qualityReady,
    confirmationRequired,
    confirmationTicksCollected,
    ladder.qualified,
    hasOpenTrade,
    lastEntryAt,
    selectedAccountType,
    allowReal,
    clock,
  ]);

  useEffect(() => {
    const needsConfirmation =
      Boolean(best) &&
      qualityReady &&
      Number(
        best.calibratedProbability || 0
      ) >= 82 &&
      Number(
        best.calibratedProbability || 0
      ) < 90;

    if (needsConfirmation) {
      if (confirmationAnchor === null) {
        setConfirmationAnchor(digits.length);
      }
    } else if (confirmationAnchor !== null) {
      setConfirmationAnchor(null);
    }
  }, [
    best?.side,
    best?.barrier,
    best?.calibratedProbability,
    qualityReady,
    digits.length,
    confirmationAnchor,
  ]);

  useEffect(() => {
    setLoopStatus(executionBlockReason);

    if (executionBlockReason === "READY_TO_BUY") {
      void executeTrade();
    }
  }, [
    executionBlockReason,
    executeTrade,
    clock,
  ]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setClock(Date.now()),
      150
    );

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected && typeof connect === "function") {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  useEffect(() => {
    if (!running) return;

    if (
      ladder.qualified &&
      !hasOpenTrade &&
      !busyRef.current
    ) {
      setMessage(
        `QUALIFIED · ${best?.contract || "candidate"} · direct buy loop firing`
      );
      return;
    }

    if (
      !digitQuality.ready &&
      scanAgeMs >= 8000 &&
      !hasOpenTrade &&
      !busyRef.current
    ) {
      setMessage(
        digitQuality.allSame
          ? "BAD TICK DECIMALS · reconnecting market feed"
          : "WAITING LIVE DIGITS · reconnecting market feed"
      );

      Promise.resolve(connect()).catch(() => {});
      setLastSettlementAt(Date.now());
      return;
    }

    if (
      digitQuality.ready &&
      !ladder.qualified &&
      scanAgeMs >= 8000 &&
      !hasOpenTrade &&
      !busyRef.current
    ) {
      void rotateMarket(
        "8s watchdog found no acceptable entry"
      );
      setLastSettlementAt(Date.now());
    }
  }, [
    running,
    ladder.qualified,
    best?.contract,
    digitQuality.ready,
    digitQuality.allSame,
    hasOpenTrade,
    scanAgeMs,
    rotateMarket,
    connect,
    clock,
  ]);

  useEffect(() => {
    if (!Array.isArray(openContracts)) return;

    for (const contract of openContracts) {
      const id = contractIdOf(contract);
      const status = statusOf(contract);

      if (
        !id ||
        !["WON", "LOST"].includes(status)
      ) {
        continue;
      }

      const processKey = `${id}:${status}`;

      if (processedRef.current.has(processKey)) {
        continue;
      }

      processedRef.current.add(processKey);

      setTrades((current) => {
        const existing = current.find(
          (trade) =>
            String(trade.contractId) === id
        );

        if (!existing) return current;

        const settled = {
          ...existing,
          status,
          profit: profitOf(contract),
          settledAt: Date.now(),
        };

        if (status === "LOST") {
          const now = Date.now();
          const lossKey = candidateKey(
            settled,
            settled.symbol
          );

          setLastLossKey(lossKey);
          setLastLossAt(now);

          const latestSettled = [
            settled,
            ...current.filter(
              (trade) =>
                ["WON", "LOST"].includes(
                  String(trade.status || "")
                ) &&
                String(trade.id) !==
                  String(settled.id)
            ),
          ];

          const marketMemory =
            marketPerformance(
              latestSettled,
              settled.symbol
            );

          const contractMemory =
            candidatePerformance(
              latestSettled,
              settled.symbol,
              settled
            );

          if (
            contractMemory.lossStreak >= 2
          ) {
            setContractBlocks((blocks) => ({
              ...blocks,
              [lossKey]: now + 30000,
            }));
          } else {
            setContractBlocks((blocks) => ({
              ...blocks,
              [lossKey]: now + 10000,
            }));
          }

          setPostLossAnchorCount(digits.length);
          setPostLossMarket(settled.symbol);
          setConfirmationAnchor(null);

          if (marketMemory.lossStreak >= 3) {
            setMarketBlocks((blocks) => ({
              ...blocks,
              [settled.symbol]:
                now + 30000,
            }));
            setPauseUntil(now + 5000);
          } else if (
            marketMemory.lossStreak >= 2
          ) {
            setPauseUntil(now + 3000);
          } else {
            setPauseUntil(now + 1500);
          }
        } else {
          setPauseUntil(0);
          setPostLossAnchorCount(null);
          setPostLossMarket("");
        }

        setLastSettlementAt(Date.now());
        setMessage(
          `${status} ${settled.contract} · P/L ${money(settled.profit)} · rescanning now`
        );
        void playTone(status);

        return current.map((trade) =>
          String(trade.contractId) === id
            ? settled
            : trade
        );
      });
    }
  }, [openContracts, playTone]);

  async function testQualifiedBuy() {
    setMessage("MANUAL TEST BUY · checking current qualified candidate");

    if (!best || !ladder.qualified) {
      setLoopStatus("MANUAL_TEST_NOT_QUALIFIED");
      setLastExecutionError(
        "Current candidate is not qualified."
      );
      return;
    }

    await executeTrade();
  }

  function start() {
    setRunning(true);
    setLastSettlementAt(Date.now());
    setMarketEnteredAt(Date.now());
    setMessage(
      "RapidEdge V4.6 started · calibrated probability and post-loss revalidation active."
    );
    void playTone("OPEN");
  }

  function stop() {
    setRunning(false);
    setMessage("RapidEdge V4.6 stopped.");
  }

  function reset() {
    setRunning(false);
    setTrades([]);
    setLastLossKey("");
    setLastLossAt(0);
    setPauseUntil(0);
    setMarketBlocks({});
    setContractBlocks({});
    setPostLossAnchorCount(null);
    setPostLossMarket("");
    setConfirmationAnchor(null);
    setLastSettlementAt(Date.now());
    recentRunTimesRef.current = [];
    processedRef.current.clear();
    setExecutionAttempts(0);
    setExecutionSuccesses(0);
    setExecutionFailures(0);
    setLastExecutionError("");
    setLastBuyRequestAt(0);
    setLoopStatus("IDLE");
    setMessage("RapidEdge V4.6 session reset.");
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent oulPage">
        <Topbar
          title="RapidEdge AI V4.6 · Quality Revalidation"
          subtitle="Calibrated probability · strict quality gate · 2-tick confirmation · 24-tick post-loss recheck"
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
              setMarketEnteredAt(Date.now());
              setLastSettlementAt(Date.now());
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
              onClick={running ? stop : start}
            >
              {running ? "STOP BOT" : "START BOT"}
            </button>
            <button
              type="button"
              className="oulReset"
              onClick={testQualifiedBuy}
            >
              TEST BUY NOW
            </button>
          </div>
        </section>

        <section
          className={`oulDecision ${
            ladder.qualified ? "ready" : ""
          }`}
        >
          <div>
            <small>V4.6 QUALITY REVALIDATION</small>
            <h1>
              {best
                ? `${best.contract} · ${pct(
                    best.probability
                  )}`
                : "WARMING TICKS"}
            </h1>
            <p>
              {message}
            </p>
          </div>

          <div className="oulDecisionGrid">
            <article>
              <span>Stage</span>
              <strong>{ladder.stage}</strong>
            </article>
            <article>
              <span>Sample</span>
              <strong>{analysis.sample}/60</strong>
            </article>
            <article>
              <span>Unique Digits</span>
              <strong>{digitQuality.unique}</strong>
            </article>
            <article>
              <span>Last Digit</span>
              <strong>
                {Number.isInteger(Number(lastDigit))
                  ? Number(lastDigit)
                  : "—"}
              </strong>
            </article>
            <article>
              <span>Current Price</span>
              <strong>
                {Number.isFinite(Number(currentPrice))
                  ? Number(currentPrice)
                  : "—"}
              </strong>
            </article>
            <article>
              <span>Probability</span>
              <strong>
                {pct(best?.calibratedProbability)}
              </strong>
            </article>
            <article>
              <span>Raw Pattern</span>
              <strong>
                {pct(best?.probability)}
              </strong>
            </article>
            <article>
              <span>Market Quality</span>
              <strong>
                {pct(best?.marketQuality)}
              </strong>
            </article>
            <article>
              <span>Execution Confidence</span>
              <strong>
                {pct(
                  best?.executionConfidence
                )}
              </strong>
            </article>
            <article>
              <span>Adaptive Risk</span>
              <strong>
                {pct(best?.adaptiveRisk)}
              </strong>
            </article>
            <article>
              <span>Quality Score</span>
              <strong>
                {pct(best?.qualityScore)}
              </strong>
            </article>
            <article>
              <span>EV</span>
              <strong>
                {Number(
                  best?.expectedValue || 0
                ).toFixed(3)}
              </strong>
            </article>
            <article>
              <span>Votes</span>
              <strong>{best?.votes || 0}/5</strong>
            </article>
            <article>
              <span>Risk</span>
              <strong>{pct(best?.risk)}</strong>
            </article>
            <article>
              <span>Scan Age</span>
              <strong>
                {(scanAgeMs / 1000).toFixed(1)}s
              </strong>
            </article>
            <article>
              <span>Market Memory</span>
              <strong>
                {best
                  ? `${pct(
                      best.marketWinRate
                    )} · L${best.marketLossStreak}`
                  : "—"}
              </strong>
            </article>
            <article>
              <span>Contract Memory</span>
              <strong>
                {best
                  ? `${pct(
                      best.contractWinRate
                    )} · L${best.contractLossStreak}`
                  : "—"}
              </strong>
            </article>
            <article>
              <span>Protection</span>
              <strong>
                {pauseUntil > clock
                  ? `${Math.ceil(
                      (pauseUntil - clock) / 1000
                    )}s PAUSE`
                  : marketBlocked
                  ? "MARKET BLOCK"
                  : "CLEAR"}
              </strong>
            </article>
            <article>
              <span>Post-Loss Ticks</span>
              <strong>
                {postLossAnchorCount === null
                  ? "CLEAR"
                  : `${postLossTicksCollected}/24`}
              </strong>
            </article>
            <article>
              <span>Confirm Ticks</span>
              <strong>
                {confirmationRequired
                  ? `${confirmationTicksCollected}/2`
                  : "NOT NEEDED"}
              </strong>
            </article>
            <article>
              <span>Runs / 60s</span>
              <strong>{runsThisMinute}/20</strong>
            </article>
            <article>
              <span>Open Trade</span>
              <strong>
                {hasOpenTrade ? "YES" : "NO"}
              </strong>
            </article>
            <article>
              <span>Auth</span>
              <strong>
                {authenticatedFeed && selectedAccountId
                  ? "READY"
                  : "BLOCKED"}
              </strong>
            </article>
            <article>
              <span>Execution State</span>
              <strong title={loopStatus}>
                {loopStatus}
              </strong>
            </article>
            <article>
              <span>Buy Attempts</span>
              <strong>{executionAttempts}</strong>
            </article>
            <article>
              <span>Buy Success</span>
              <strong>{executionSuccesses}</strong>
            </article>
            <article>
              <span>Buy Failed</span>
              <strong>{executionFailures}</strong>
            </article>
            <article>
              <span>Last Buy Error</span>
              <strong title={lastExecutionError}>
                {lastExecutionError || "NONE"}
              </strong>
            </article>
          </div>
        </section>

        <section className="oulExecutionDiagnostic">
          <div>
            <small>EXECUTION PIPELINE</small>
            <strong>{loopStatus}</strong>
          </div>
          <div>
            <span>Auth</span>
            <b>
              {authenticatedFeed && selectedAccountId
                ? "READY"
                : "BLOCKED"}
            </b>
          </div>
          <div>
            <span>Hook tradeBusy</span>
            <b>{tradeBusy ? "TRUE" : "FALSE"}</b>
          </div>
          <div>
            <span>Local busy</span>
            <b>{busyRef.current ? "TRUE" : "FALSE"}</b>
          </div>
          <div>
            <span>Last Error</span>
            <b title={lastExecutionError}>
              {lastExecutionError || "NONE"}
            </b>
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
            <span>Ticks</span>
            <input
              type="number"
              min="1"
              max="10"
              value={durationTicks}
              onChange={(event) =>
                setDurationTicks(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Real Account</span>
            <select
              value={allowReal ? "ON" : "OFF"}
              onChange={(event) =>
                setAllowReal(
                  event.target.value === "ON"
                )
              }
            >
              <option value="OFF">LOCKED</option>
              <option value="ON">ENABLED</option>
            </select>
          </label>

          <label>
            <span>Sound</span>
            <select
              value={soundEnabled ? "ON" : "OFF"}
              onChange={(event) =>
                setSoundEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">ON</option>
              <option value="OFF">OFF</option>
            </select>
          </label>
        </section>

        <section className="oulStats">
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
            <span>Win Rate</span>
            <strong>{pct(stats.winRate)}</strong>
          </article>
          <article>
            <span>P/L</span>
            <strong>{money(stats.profit)}</strong>
          </article>
          <article>
            <span>Switches</span>
            <strong>{switches}</strong>
          </article>
          <article>
            <span>Market</span>
            <strong>{symbol || "—"}</strong>
          </article>
          <article>
            <span>Account</span>
            <strong>{selectedAccountType}</strong>
          </article>
          <article>
            <span>Feed</span>
            <strong>
              {connected ? "LIVE" : "OFFLINE"}
            </strong>
          </article>
          <article>
            <span>Trading Auth</span>
            <strong>
              {authenticatedFeed && selectedAccountId
                ? "READY"
                : "BLOCKED"}
            </strong>
          </article>
        </section>

        <section className="oulMainGrid">
          <article className="oulPanel">
            <header>
              <div>
                <small>LAST 60 DIGITS</small>
                <h2>Rolling Speed Window</h2>
              </div>
              <strong>{digits.length}</strong>
            </header>

            <div className="oulDigits">
              {digits.length ? (
                digits.map((digit, index) => (
                  <span key={`${digit}-${index}`}>
                    {digit}
                  </span>
                ))
              ) : (
                <p className="oulNoLiveDigits">
                  NO LIVE DIGITS RECEIVED
                </p>
              )}
            </div>
          </article>

          <article className="oulPanel">
            <header>
              <div>
                <small>FAST CANDIDATES</small>
                <h2>EV + Probability Ranking</h2>
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
                      {candidate.contract}
                    </strong>
                    <span>
                      P {pct(candidate.calibratedProbability)}
                    </span>
                    <span>
                      EV{" "}
                      {candidate.expectedValue.toFixed(
                        3
                      )}
                    </span>
                    <span>
                      Quality{" "}
                      {pct(
                        candidate.qualityScore
                      )}
                    </span>
                    <span>
                      Exec{" "}
                      {pct(
                        candidate.executionConfidence
                      )}
                    </span>
                    <span>
                      Risk{" "}
                      {pct(
                        candidate.adaptiveRisk
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
              <h2>RapidEdge V4.6 Trades</h2>
            </div>
          </header>

          <div className="oulTransactionScroll">
            <div className="oulTransactionHead">
              <span>Time</span>
              <span>Market</span>
              <span>Contract</span>
              <span>Stage</span>
              <span>Stake</span>
              <span>Status</span>
              <span>P/L</span>
              <span>Probability</span>
            </div>

            {trades.length ? (
              trades.map((trade) => (
                <div
                  className={`oulTransactionRow ${String(
                    trade.status || ""
                  ).toLowerCase()}`}
                  key={trade.id}
                >
                  <div className="oulTransactionMain">
                    <span>
                      {new Date(
                        trade.createdAt
                      ).toLocaleTimeString()}
                    </span>
                    <span>{trade.symbol}</span>
                    <span>{trade.contract}</span>
                    <span>{trade.stage}</span>
                    <span>{money(trade.stake)}</span>
                    <b>{trade.status}</b>
                    <span>{money(trade.profit)}</span>
                    <span>
                      {pct(trade.probability)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="oulNoTransactions">
                No RapidEdge V4.6 transactions yet.
              </p>
            )}
          </div>
        </section>

        <p className="oulDisclaimer">
          V4.6 waits for 24 new ticks after a loss and uses calibrated probability plus stricter quality limits. It may trade less often. Profit and win rate are not guaranteed. Test on demo first.
        </p>
      </main>
    </div>
  );
}
