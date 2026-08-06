import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import useDerivTicks from "../hooks/useDerivTicks";
import styles from "./GeminiXEngine.module.css";

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(
    maximum,
    Math.max(minimum, Number(value) || 0)
  );
}

function percent(value) {
  return `${clamp(value).toFixed(1)}%`;
}

function buildDigitDistribution(digits) {
  const counts = Array(10).fill(0);

  for (const digit of digits) {
    if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
      counts[digit] += 1;
    }
  }

  const total = Math.max(1, digits.length);

  return counts.map((count, digit) => ({
    digit,
    count,
    percent: (count / total) * 100,
  }));
}

function shannonEntropy(digits) {
  if (!digits.length) return 0;

  const distribution = buildDigitDistribution(digits);
  const entropy = distribution.reduce((total, row) => {
    if (!row.count) return total;
    const probability = row.count / digits.length;
    return total - probability * Math.log2(probability);
  }, 0);

  return clamp((entropy / Math.log2(10)) * 100);
}

function transitionScore(digits) {
  if (digits.length < 3) return 50;

  let changes = 0;

  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] !== digits[index - 1]) {
      changes += 1;
    }
  }

  return clamp(
    (changes / Math.max(1, digits.length - 1)) * 100
  );
}

function longestRun(digits) {
  if (!digits.length) return 0;

  let longest = 1;
  let current = 1;

  for (let index = 1; index < digits.length; index += 1) {
    if (digits[index] === digits[index - 1]) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }

  return longest;
}

function contractIdOf(contract) {
  return String(
    contract?.contract_id ||
      contract?.contractId ||
      contract?.id ||
      contract?.proposal_open_contract?.contract_id ||
      contract?.data?.contract_id ||
      ""
  );
}

function normalizedContract(contract) {
  return (
    contract?.proposal_open_contract ||
    contract?.data?.proposal_open_contract ||
    contract?.data ||
    contract ||
    {}
  );
}

function contractIsSettled(contract) {
  const row = normalizedContract(contract);
  const status = String(
    row?.status ||
      row?.contract_status ||
      ""
  ).toUpperCase();

  return Boolean(
    row?.is_sold ||
      row?.is_expired ||
      ["WON", "LOST", "SOLD"].includes(status)
  );
}

function contractResult(contract) {
  const row = normalizedContract(contract);
  const status = String(
    row?.status ||
      row?.contract_status ||
      ""
  ).toUpperCase();

  const profit = Number(
    row?.profit ??
      row?.profit_loss ??
      row?.pl ??
      0
  );

  if (
    status === "WON" ||
    (contractIsSettled(row) && profit > 0)
  ) {
    return "WON";
  }

  if (
    status === "LOST" ||
    (contractIsSettled(row) && profit < 0)
  ) {
    return "LOST";
  }

  return contractIsSettled(row)
    ? "SOLD"
    : "OPEN";
}

function contractTimestamp(contract) {
  const row = normalizedContract(contract);

  const values = [
    row?.date_start,
    row?.purchase_time,
    row?.entry_tick_time,
    row?.transaction_time,
    row?.created_at,
    row?.createdAt,
  ];

  for (const value of values) {
    const number = Number(value);

    if (Number.isFinite(number) && number > 0) {
      return number > 1000000000000
        ? number
        : number * 1000;
    }

    const parsed = Date.parse(String(value || ""));

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function contractRows(openContracts, firstSeenMap, now) {
  const rows = Array.isArray(openContracts)
    ? openContracts
    : [];
  const seen = new Set();

  return rows
    .filter((contract) => {
      const id = contractIdOf(contract);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((contract) => {
      const row = normalizedContract(contract);

      const startedAt =
        contractTimestamp(row);

      const localFirstSeen = Number(
        firstSeenMap?.get(
          contractIdOf(contract)
        ) || 0
      );

      const referenceTime =
        startedAt || localFirstSeen;

      const ageMs = referenceTime
        ? now - referenceTime
        : 0;

      const staleOpen =
        !contractIsSettled(row) &&
        ageMs >= 12000;

      return {
        ...row,
        contractId: contractIdOf(contract),
        result: staleOpen
          ? "STALE"
          : contractResult(row),
        settled: contractIsSettled(row),
        staleOpen,
        startedAt,
        ageMs,
        profit: Number(
          row?.profit ??
            row?.profit_loss ??
            row?.pl ??
            0
        ),
      };
    });
}

function settledTradeStatus(trade) {
  const status = String(
    trade?.status ||
      trade?.contract_status ||
      trade?.state ||
      ""
  ).toUpperCase();

  if (
    status.includes("WON") ||
    status === "WIN"
  ) {
    return "WON";
  }

  if (
    status.includes("LOST") ||
    status === "LOSS"
  ) {
    return "LOST";
  }

  return "";
}

function tradeProfit(trade) {
  const candidates = [
    trade?.profit,
    trade?.profit_loss,
    trade?.pl,
    trade?.pnl,
  ];

  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }

  return 0;
}

function recentPerformance(transactions, limit = 20) {
  const settled = (Array.isArray(transactions)
    ? transactions
    : []
  )
    .map((trade) => ({
      ...trade,
      normalizedStatus:
        settledTradeStatus(trade),
    }))
    .filter((trade) =>
      ["WON", "LOST"].includes(
        trade.normalizedStatus
      )
    )
    .slice(0, limit);

  const wins = settled.filter(
    (trade) =>
      trade.normalizedStatus === "WON"
  ).length;

  const losses = settled.length - wins;
  const profit = settled.reduce(
    (sum, trade) => sum + tradeProfit(trade),
    0
  );

  let lossStreak = 0;

  for (const trade of settled) {
    if (trade.normalizedStatus !== "LOST") {
      break;
    }

    lossStreak += 1;
  }

  return {
    settled,
    wins,
    losses,
    profit,
    lossStreak,
    winRate: settled.length
      ? (wins / settled.length) * 100
      : 50,
  };
}

function contractRiskClass(candidate) {
  const side = String(
    candidate?.contractType || ""
  );

  const barrier = Number(
    candidate?.barrier ?? -1
  );

  if (
    (side === "DIGITOVER" && barrier <= 2) ||
    (side === "DIGITUNDER" && barrier >= 7)
  ) return "LOW";

  if (
    (side === "DIGITOVER" && barrier <= 4) ||
    (side === "DIGITUNDER" && barrier >= 5)
  ) return "MEDIUM";

  return "HIGH";
}

function normalizedTradeLabel(trade) {
  const type = String(
    trade?.contract_type ||
      trade?.contractType ||
      ""
  ).toUpperCase();

  const barrier = Math.abs(
    Number(
      trade?.barrier ??
        trade?.barrier_value ??
        trade?.prediction ??
        -1
    )
  );

  if (
    type === "DIGITOVER" &&
    Number.isFinite(barrier) &&
    barrier >= 0
  ) {
    return `OVER ${barrier}`;
  }

  if (
    type === "DIGITUNDER" &&
    Number.isFinite(barrier) &&
    barrier >= 0
  ) {
    return `UNDER ${barrier}`;
  }

  return "";
}

function recentContractMemory(
  transactions,
  limit = 16
) {
  const rows = (Array.isArray(transactions)
    ? transactions
    : []
  )
    .map((trade) => ({
      label: normalizedTradeLabel(trade),
      result: settledTradeStatus(trade),
    }))
    .filter(
      (row) =>
        row.label &&
        ["WON", "LOST"].includes(row.result)
    )
    .slice(0, limit);

  const usage = new Map();
  const losses = new Map();

  for (const row of rows) {
    usage.set(
      row.label,
      Number(usage.get(row.label) || 0) + 1
    );

    if (row.result === "LOST") {
      losses.set(
        row.label,
        Number(losses.get(row.label) || 0) + 1
      );
    }
  }

  const latestSide = rows[0]?.label?.startsWith(
    "OVER"
  )
    ? "OVER"
    : rows[0]?.label?.startsWith("UNDER")
    ? "UNDER"
    : "";

  let sideStreak = 0;

  for (const row of rows) {
    if (
      !latestSide ||
      !row.label.startsWith(latestSide)
    ) {
      break;
    }

    sideStreak += 1;
  }

  return {
    usage,
    losses,
    latestSide,
    sideStreak,
  };
}

function safeContractCandidates(
  digits,
  transactions
) {
  const recent = digits.slice(-60);
  const distribution = buildDigitDistribution(recent);

  const probabilityOver = (barrier) =>
    distribution
      .filter((row) => row.digit > barrier)
      .reduce((total, row) => total + row.percent, 0);

  const probabilityUnder = (barrier) =>
    distribution
      .filter((row) => row.digit < barrier)
      .reduce((total, row) => total + row.percent, 0);

  const candidates = [
    { label: "OVER 1", contractType: "DIGITOVER", barrier: 1, probability: probabilityOver(1), baseRisk: 8 },
    { label: "OVER 2", contractType: "DIGITOVER", barrier: 2, probability: probabilityOver(2), baseRisk: 16 },
    { label: "OVER 3", contractType: "DIGITOVER", barrier: 3, probability: probabilityOver(3), baseRisk: 28 },
    { label: "OVER 4", contractType: "DIGITOVER", barrier: 4, probability: probabilityOver(4), baseRisk: 44 },
    { label: "OVER 5", contractType: "DIGITOVER", barrier: 5, probability: probabilityOver(5), baseRisk: 62 },
    { label: "UNDER 8", contractType: "DIGITUNDER", barrier: 8, probability: probabilityUnder(8), baseRisk: 8 },
    { label: "UNDER 7", contractType: "DIGITUNDER", barrier: 7, probability: probabilityUnder(7), baseRisk: 16 },
    { label: "UNDER 6", contractType: "DIGITUNDER", barrier: 6, probability: probabilityUnder(6), baseRisk: 28 },
    { label: "UNDER 5", contractType: "DIGITUNDER", barrier: 5, probability: probabilityUnder(5), baseRisk: 44 },
    { label: "UNDER 4", contractType: "DIGITUNDER", barrier: 4, probability: probabilityUnder(4), baseRisk: 62 },
  ];

  const memory = recentContractMemory(
    transactions,
    16
  );

  return candidates
    .map((candidate) => {
      const riskClass =
        contractRiskClass(candidate);

      const theoreticalProbability =
        candidate.contractType ===
        "DIGITOVER"
          ? ((9 - candidate.barrier) /
              10) *
            100
          : (candidate.barrier / 10) *
            100;

      const statisticalEdge =
        candidate.probability -
        theoreticalProbability;

      const estimatedPayoutMultiple =
        theoreticalProbability > 0
          ? 95 / theoreticalProbability
          : 0;

      const expectedValue =
        (candidate.probability / 100) *
          estimatedPayoutMultiple -
        1;

      const usageCount = Number(
        memory.usage.get(candidate.label) || 0
      );

      const lossCount = Number(
        memory.losses.get(candidate.label) || 0
      );

      const candidateSide =
        candidate.contractType ===
        "DIGITOVER"
          ? "OVER"
          : "UNDER";

      const repetitionPenalty =
        usageCount * 4.5 +
        lossCount * 7 +
        (
          memory.latestSide ===
            candidateSide &&
          memory.sideStreak >= 3
            ? Math.min(
                24,
                (memory.sideStreak - 2) * 6
              )
            : 0
        );

      const barrierPenalty =
        riskClass === "HIGH"
          ? 20
          : riskClass === "MEDIUM"
          ? 7
          : 0;

      const probabilityFloorPenalty =
        candidate.probability < 48
          ? (48 - candidate.probability) * 2
          : 0;

      const risk = clamp(
        candidate.baseRisk +
          barrierPenalty +
          probabilityFloorPenalty +
          Math.max(
            0,
            -statisticalEdge
          ) *
            1.8
      );

      const score =
        expectedValue * 115 +
        statisticalEdge * 2.4 +
        Math.min(
          18,
          candidate.probability * 0.18
        ) -
        risk * 0.38 -
        repetitionPenalty;

      return {
        ...candidate,
        theoreticalProbability,
        statisticalEdge,
        expectedValue,
        usageCount,
        lossCount,
        repetitionPenalty,
        riskClass,
        risk,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function analyseGemini({
  prices,
  digitHistory,
  minConfidence,
  transactions,
}) {
  const digits = digitHistory.slice(-180);
  const decisionDigits = digits.slice(-60);
  const recentPrices = prices.slice(-180);
  const performance =
    recentPerformance(transactions, 20);
  const sample = Math.min(
    digits.length,
    recentPrices.length || digits.length
  );
  const distribution = buildDigitDistribution(digits);
  const entropy = shannonEntropy(decisionDigits);
  const transition = transitionScore(decisionDigits);
  const cycle = longestRun(decisionDigits);

  const priceWindow = recentPrices.slice(-12);
  const firstPrice = Number(priceWindow[0]);
  const lastPrice = Number(priceWindow.at(-1));
  const priceDelta =
    Number.isFinite(firstPrice) &&
    Number.isFinite(lastPrice)
      ? lastPrice - firstPrice
      : 0;

  const absoluteMoves = recentPrices
    .slice(1)
    .map((price, index) =>
      Math.abs(
        Number(price) -
          Number(recentPrices[index])
      )
    )
    .filter(Number.isFinite);

  const averageMove = absoluteMoves.length
    ? absoluteMoves.reduce((sum, value) => sum + value, 0) /
      absoluteMoves.length
    : 0;

  const latestMove =
    recentPrices.length >= 2
      ? Math.abs(
          Number(recentPrices.at(-1)) -
            Number(recentPrices.at(-2))
        )
      : 0;

  const momentumStrength = clamp(
    averageMove > 0
      ? (Math.abs(priceDelta) /
          Math.max(averageMove, Number.EPSILON)) *
          12
      : 0
  );

  const direction =
    priceDelta > 0
      ? "UP"
      : priceDelta < 0
      ? "DOWN"
      : "NEUTRAL";

  const volatilityRatio =
    averageMove > 0
      ? latestMove / averageMove
      : 1;

  const volatility =
    volatilityRatio > 1.8
      ? "HIGH"
      : volatilityRatio < 0.55
      ? "LOW"
      : "NORMAL";

  const regime =
    momentumStrength >= 70
      ? "BREAKOUT"
      : momentumStrength >= 42
      ? "TREND"
      : "RANGE";

  const candidates = safeContractCandidates(
    decisionDigits,
    transactions
  );
  const best = candidates[0] || {
    label: "WAIT",
    probability: 50,
    risk: 100,
  };

  const stability = clamp(
    100 -
      Math.abs(entropy - 82) * 1.25 -
      Math.max(0, transition - 92) * 0.7
  );

  const sampleScore = clamp((sample / 60) * 100);
  const probability = clamp(
    best.probability * 0.60 +
      stability * 0.14 +
      sampleScore * 0.12 +
      performance.winRate * 0.14 -
      performance.lossStreak * 7
  );

  const confidence = clamp(
    probability * 0.45 +
      stability * 0.16 +
      sampleScore * 0.14 +
      Math.min(
        100,
        momentumStrength
      ) *
        0.10 +
      performance.winRate * 0.15 -
      best.risk * 0.18 -
      performance.lossStreak * 8
  );

  const risk =
    best.risk < 25 && confidence >= 72
      ? "LOW"
      : best.risk < 48 && confidence >= 58
      ? "MEDIUM"
      : "HIGH";

  const gates = [
    {
      name: "Sample",
      status: `${sample}/60 ticks`,
      passed: sample >= 24,
    },
    {
      name: "Probability",
      status: percent(probability),
      passed: probability >= 68,
    },
    {
      name: "Confidence",
      status: percent(confidence),
      passed: confidence >= minConfidence,
    },
    {
      name: "Risk",
      status: `${risk} ${percent(best.risk)}`,
      passed: risk !== "HIGH",
    },
    {
      name: "Entropy",
      status: percent(entropy),
      passed: entropy >= 65,
    },
    {
      name: "Transition",
      status: percent(transition),
      passed: transition >= 58,
    },
  ];

  const passed = gates.filter((gate) => gate.passed).length;
  const ready =
    sample >= 36 &&
    passed >= 5 &&
    confidence >= minConfidence &&
    probability >= 72 &&
    risk !== "HIGH" &&
    best.riskClass !== "HIGH" &&
    performance.lossStreak === 0;

  return {
    distribution,
    candidates,
    best,
    sample,
    entropy,
    transition,
    cycle,
    momentumStrength,
    direction,
    volatility,
    regime,
    probability,
    confidence,
    risk,
    gates,
    passed,
    performance,
    decision: ready ? best.label : "WAIT",
    ready,
    reason: ready
      ? `${best.label} imepita ${passed}/6 gates kwenye ${
          sample
        } live digits.`
      : `WAIT: ${passed}/6 gates zimepita. Inakusanya na kuthibitisha live data.`,
  };
}

function GeminiXContent({
  data,
  compact = false,
  showControls = true,
}) {
  const navigate = useNavigate();
  const {
    markets = [],
    market,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    prices = [],
    currentPrice,
    lastDigit,
    digitHistory = [],
    selectedAccountId,
    selectedAccountType,
    transactions = [],
    openContracts = [],
    tradeBusy,
    tradeError,
    connect,
    changeSymbol,
    placeTrade,
  } = data;

  const [stake, setStake] = useState(0.35);
  const [currentStake, setCurrentStake] = useState(0.35);
  const [targetProfit, setTargetProfit] = useState(5);
  const [stopLoss, setStopLoss] = useState(10);
  const [maxLossStreak, setMaxLossStreak] = useState(3);
  const [consecutiveLosses, setConsecutiveLosses] = useState(0);
  const [sessionProfit, setSessionProfit] = useState(0);
  const [botStatusMessage, setBotStatusMessage] = useState("SYSTEM READY");
  const [minConfidence, setMinConfidence] = useState(68);
  const [executionMode, setExecutionMode] =
    useState("PAPER");
  const [running, setRunning] = useState(false);
  const [campaignEnabled, setCampaignEnabled] =
    useState(true);
  const [campaignTarget, setCampaignTarget] =
    useState(5);
  const [campaignRuns, setCampaignRuns] =
    useState(0);
  const [campaignWins, setCampaignWins] =
    useState(0);
  const [campaignLosses, setCampaignLosses] =
    useState(0);
  const [recoveryEnabled, setRecoveryEnabled] =
    useState(true);
  const [recoveryPending, setRecoveryPending] =
    useState(false);
  const [recoveryMultiplier, setRecoveryMultiplier] =
    useState(4);
  const [recoveryConfidence, setRecoveryConfidence] =
    useState(85);
  const [maxRecoveryStake, setMaxRecoveryStake] =
    useState(5);
  const [decisionHistory, setDecisionHistory] =
    useState([]);
  const [cooldownUntil, setCooldownUntil] =
    useState(0);
  const [lastSettlementKey, setLastSettlementKey] =
    useState("");
  const [marketMemory, setMarketMemory] =
    useState({});
  const [lastMarketSwitchAt, setLastMarketSwitchAt] =
    useState(0);
  const [watchdogClock, setWatchdogClock] =
    useState(() => Date.now());
  const contractFirstSeenRef = useRef(
    new Map()
  );
  const [engineMessage, setEngineMessage] =
    useState(
      "GeminiX V5 iko ready. Paper mode ndiyo default."
    );
  const lastAutoTradeKeyRef = useRef("");

  useEffect(() => {
    if (consecutiveLosses === 0 && !recoveryPending) {
      setCurrentStake(Math.max(0.35, Number(stake || 0.35)));
    }
  }, [stake, consecutiveLosses, recoveryPending]);

  const analysis = useMemo(
    () =>
      analyseGemini({
        prices,
        digitHistory,
        minConfidence,
        transactions,
      }),
    [
      prices,
      digitHistory,
      minConfidence,
      transactions,
    ]
  );


  useEffect(() => {
    const timer = window.setInterval(
      () => setWatchdogClock(Date.now()),
      1000
    );

    return () =>
      window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const now = Date.now();
    const activeIds = new Set();

    for (const contract of Array.isArray(
      openContracts
    )
      ? openContracts
      : []) {
      const id = contractIdOf(contract);
      if (!id) continue;

      activeIds.add(id);

      if (
        !contractFirstSeenRef.current.has(id)
      ) {
        contractFirstSeenRef.current.set(
          id,
          now
        );
      }
    }

    for (const id of Array.from(
      contractFirstSeenRef.current.keys()
    )) {
      if (!activeIds.has(id)) {
        contractFirstSeenRef.current.delete(
          id
        );
      }
    }
  }, [openContracts]);

  const normalizedContracts = useMemo(
    () =>
      contractRows(
        openContracts,
        contractFirstSeenRef.current,
        watchdogClock
      ),
    [openContracts, watchdogClock]
  );

  const activeContracts = useMemo(
    () =>
      normalizedContracts.filter(
        (contract) =>
          !contract.settled &&
          !contract.staleOpen
      ),
    [normalizedContracts]
  );

  const staleContracts = useMemo(
    () =>
      normalizedContracts.filter(
        (contract) =>
          contract.staleOpen
      ),
    [normalizedContracts]
  );

  const settledContracts = useMemo(
    () =>
      normalizedContracts.filter(
        (contract) => contract.settled
      ),
    [normalizedContracts]
  );


  const transactionSummary = useMemo(() => {
    const settled = normalizedContracts.filter(
      (trade) => trade.settled
    );

    const wins = settled.filter(
      (trade) => trade.result === "WON"
    ).length;

    const losses = settled.filter(
      (trade) => trade.result === "LOST"
    ).length;

    const profit = settled.reduce(
      (sum, trade) =>
        sum + Number(trade.profit || 0),
      0
    );

    return {
      wins,
      losses,
      profit,
      count: settled.length,
      winRate: settled.length
        ? (wins / settled.length) * 100
        : 0,
    };
  }, [normalizedContracts]);


  const marketRanking = useMemo(
    () =>
      Object.values(marketMemory)
        .map((row) => {
          const confidence = Number(
            row?.confidence || 0
          );
          const probability = Number(
            row?.probability || 0
          );
          const riskPenalty =
            row?.risk === "HIGH"
              ? 35
              : row?.risk === "MEDIUM"
              ? 15
              : 0;
          const classPenalty =
            row?.riskClass === "HIGH"
              ? 30
              : row?.riskClass === "MEDIUM"
              ? 10
              : 0;
          const ageSeconds = Math.max(
            0,
            (
              watchdogClock -
              Number(row?.updatedAt || 0)
            ) /
              1000
          );
          const freshnessPenalty =
            Math.min(30, ageSeconds * 0.35);

          return {
            ...row,
            ageSeconds,
            score: clamp(
              confidence * 0.34 +
                probability * 0.24 +
                Number(
                  row?.candidate?.score || 0
                ) *
                  0.42 -
                riskPenalty -
                classPenalty -
                freshnessPenalty
            ),
          };
        })
        .sort(
          (first, second) =>
            second.score - first.score
        ),
    [marketMemory, watchdogClock]
  );

  const minimumPortfolioMarkets = Math.min(
    5,
    Math.max(1, markets.length)
  );

  const portfolioReady =
    marketRanking.length >= minimumPortfolioMarkets;

  const portfolioBest =
    marketRanking[0] || null;

  const recoveryGatePassed =
    recoveryEnabled &&
    recoveryPending &&
    analysis.ready &&
    analysis.risk === "LOW" &&
    analysis.best.riskClass === "LOW" &&
    analysis.confidence >=
      recoveryConfidence &&
    analysis.probability >= 82;

  const smartEffectiveStake = useMemo(() => {
    const baseStake = Math.max(0.35, Number(stake || 0.35));

    if (!recoveryGatePassed) {
      return Math.max(baseStake, Number(currentStake || baseStake));
    }

    return Math.min(
      Number(maxRecoveryStake || 5),
      Math.max(baseStake, Number(currentStake || baseStake))
    );
  }, [stake, currentStake, recoveryGatePassed, maxRecoveryStake]);

  useEffect(() => {
    if (!symbol || !analysis.best?.label) {
      return;
    }

    const record = {
      id: [
        symbol,
        analysis.best.label,
        Math.round(analysis.confidence),
        Math.round(analysis.probability),
      ].join(":"),
      time: Date.now(),
      symbol,
      decision: analysis.decision,
      candidate: analysis.best.label,
      confidence: analysis.confidence,
      probability: analysis.probability,
      risk: analysis.risk,
      recovery:
        recoveryPending &&
        recoveryGatePassed,
    };

    setDecisionHistory((current) => {
      if (current[0]?.id === record.id) {
        return current;
      }

      return [
        record,
        ...current,
      ].slice(0, 30);
    });
  }, [
    symbol,
    analysis.decision,
    analysis.best.label,
    analysis.confidence,
    analysis.probability,
    analysis.risk,
    recoveryPending,
    recoveryGatePassed,
  ]);

  const handleTradeResult = ({ status, profit }) => {
    const normalizedStatus = String(status || "").toUpperCase();
    const tradeProfit = Number(profit || 0);
    const isWin = normalizedStatus === "WON" || tradeProfit > 0;

    setSessionProfit((previousProfit) => {
      const nextProfit = previousProfit + tradeProfit;

      if (nextProfit >= targetProfit) {
        setRunning(false);
        setCurrentStake(stake);
        setConsecutiveLosses(0);
        setRecoveryPending(false);
        setBotStatusMessage(`TARGET PROFIT REACHED: +$${nextProfit.toFixed(2)}`);
        setEngineMessage(`Take Profit imefika: +$${nextProfit.toFixed(2)}. Bot imesimama.`);
        return nextProfit;
      }

      if (nextProfit <= -Math.abs(stopLoss)) {
        setRunning(false);
        setCurrentStake(stake);
        setConsecutiveLosses(0);
        setRecoveryPending(false);
        setBotStatusMessage(`STOP LOSS HIT: -$${Math.abs(nextProfit).toFixed(2)}`);
        setEngineMessage(`Stop Loss imefika: -$${Math.abs(nextProfit).toFixed(2)}. Bot imesimama.`);
        return nextProfit;
      }

      if (isWin) {
        setCurrentStake(stake);
        setConsecutiveLosses(0);
        setRecoveryPending(false);
        setBotStatusMessage(`TRADE WON: +$${tradeProfit.toFixed(2)} · stake reset`);
        return nextProfit;
      }

      setConsecutiveLosses((previousLosses) => {
        const nextLosses = previousLosses + 1;

        if (nextLosses >= maxLossStreak) {
          setRunning(false);
          setCurrentStake(stake);
          setRecoveryPending(false);
          setBotStatusMessage(`MAX LOSS STREAK ${nextLosses}/${maxLossStreak} · bot paused`);
          setEngineMessage(`Max loss streak ${nextLosses} imefika. Bot imesimama kwa safety.`);
          return nextLosses;
        }

        const nextStake = Math.min(
          Number(maxRecoveryStake || 5),
          Number(
            (
              Math.max(stake, currentStake) *
              Number(recoveryMultiplier || 2.1)
            ).toFixed(2)
          )
        );

        setCurrentStake(nextStake);
        setRecoveryPending(Boolean(recoveryEnabled));
        setBotStatusMessage(
          `TRADE LOST: -$${Math.abs(tradeProfit).toFixed(2)} · recovery ${nextLosses}/${maxLossStreak} · next $${nextStake.toFixed(2)}`
        );

        return nextLosses;
      });

      return nextProfit;
    });
  };

  useEffect(() => {
    const settled = settledContracts[0];

    if (!settled) return;

    const key = settled.contractId;

    if (!key || key === lastSettlementKey) {
      return;
    }

    setLastSettlementKey(key);
    setCampaignRuns((value) => value + 1);

    handleTradeResult({
      status: settled.result,
      profit: settled.profit,
    });

    if (settled.result === "WON") {
      setCampaignWins((value) => value + 1);
      setCooldownUntil(Date.now() + 1000);
      setLastMarketSwitchAt(0);
      setEngineMessage(
        "WIN settled · recovery imereset na scanner inaendelea."
      );
      return;
    }

    if (settled.result === "LOST") {
      setCampaignLosses((value) => value + 1);
      setCooldownUntil(Date.now() + 10000);
      setLastMarketSwitchAt(0);
      setEngineMessage(
        recoveryEnabled
          ? `LOSS settled · recovery x${recoveryMultiplier} imearm, lakini itatumika tu Confidence ≥ ${recoveryConfidence}% na LOW risk.`
          : "LOSS settled · scanner inaendelea bila recovery."
      );
    }
  }, [
    settledContracts,
    lastSettlementKey,
  ]);

  useEffect(() => {
    if (
      campaignEnabled &&
      campaignRuns > 0 &&
      campaignRuns % campaignTarget === 0
    ) {
      setEngineMessage(
        `Batch ya ${campaignTarget} runs imekamilika. Scanner inaendelea bila kusimama.`
      );
    }
  }, [
    campaignEnabled,
    campaignRuns,
    campaignTarget,
  ]);

  const resetCampaign = () => {
    setCampaignRuns(0);
    setCampaignWins(0);
    setCampaignLosses(0);
    setConsecutiveLosses(0);
    setSessionProfit(0);
    setCurrentStake(stake);
    setBotStatusMessage("SYSTEM READY");
    setRecoveryPending(false);
    setCooldownUntil(0);
    setLastSettlementKey("");
    setMarketMemory({});
    setLastMarketSwitchAt(0);
    contractFirstSeenRef.current.clear();
    lastAutoTradeKeyRef.current = "";
    setEngineMessage(
      "Campaign reset. GeminiX iko ready."
    );
  };

  useEffect(() => {
    if (
      !running ||
      !staleContracts.length
    ) {
      return;
    }

    lastAutoTradeKeyRef.current = "";
    setCooldownUntil(0);
    setLastMarketSwitchAt(0);
    setEngineMessage(
      `Force re-arm: ${staleContracts.length} OPEN record imezidi 12s na imeondolewa kwa blocker.`
    );
  }, [
    running,
    staleContracts.length,
  ]);

  useEffect(() => {
    if (
      !symbol ||
      digitHistory.length < 24
    ) {
      return;
    }

    setMarketMemory((current) => ({
      ...current,
      [symbol]: {
        symbol,
        updatedAt: Date.now(),
        sample: analysis.sample,
        decision: analysis.best.label,
        candidate: {
          label: analysis.best.label,
          contractType: analysis.best.contractType,
          barrier: analysis.best.barrier,
          probability: analysis.best.probability,
          theoreticalProbability:
            analysis.best.theoreticalProbability,
          statisticalEdge:
            analysis.best.statisticalEdge,
          expectedValue:
            analysis.best.expectedValue,
          repetitionPenalty:
            analysis.best.repetitionPenalty,
          score: analysis.best.score,
          risk: analysis.best.risk,
          riskClass:
            analysis.best.riskClass || "HIGH",
        },
        confidence: analysis.confidence,
        probability: analysis.probability,
        risk: analysis.risk,
        riskClass:
          analysis.best.riskClass || "HIGH",
        ready: analysis.ready,
      },
    }));
  }, [
    symbol,
    digitHistory.length,
    analysis.sample,
    analysis.best.label,
    analysis.best.riskClass,
    analysis.confidence,
    analysis.probability,
    analysis.risk,
    analysis.ready,
  ]);

  const switchToNextMarket = async (
    reason = "Continuous scan"
  ) => {
    if (
      loadingMarket ||
      tradeBusy ||
      activeContracts.length > 0 ||
      !markets.length
    ) {
      return;
    }

    const currentIndex = Math.max(
      0,
      markets.findIndex(
        (row) => row.id === symbol
      )
    );

    const next =
      markets[
        (currentIndex + 1) % markets.length
      ];

    if (!next || next.id === symbol) return;

    setLastMarketSwitchAt(Date.now());
    setEngineMessage(
      `${reason}: ${symbol} → ${next.id}`
    );

    await changeSymbol(next.id);
  };

  useEffect(() => {
    if (
      !running ||
      tradeBusy ||
      loadingMarket
    ) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      const current = marketMemory[symbol];

      const currentStrong =
        Boolean(current) &&
        current.ready &&
        Number(current.confidence || 0) >=
          minConfidence &&
        Number(current.probability || 0) >=
          72 &&
        current.risk !== "HIGH" &&
        current.riskClass !== "HIGH";

      if (
        now - Number(lastMarketSwitchAt || 0) >= 10000
      ) {
        lastAutoTradeKeyRef.current = "";

        void switchToNextMarket(
          !portfolioReady
            ? `Portfolio warm-up ${marketRanking.length}/${minimumPortfolioMarkets}`
            : currentStrong
            ? "10s scan complete · ranking all markets"
            : "10s scan complete · no quality entry"
        );
      }
    }, 1000);

    return () =>
      window.clearInterval(timer);
  }, [
    running,
    activeContracts.length,
    tradeBusy,
    loadingMarket,
    marketMemory,
    symbol,
    minConfidence,
    lastMarketSwitchAt,
    markets,
    portfolioReady,
    marketRanking.length,
    minimumPortfolioMarkets,
  ]);

  const executeCandidate = async (
    candidate = analysis.best,
    source = "MANUAL"
  ) => {
    if (!candidate || candidate.label === "WAIT") {
      setEngineMessage("Hakuna candidate ya kununua.");
      return;
    }

    if (Date.now() < cooldownUntil) {
      setEngineMessage(
        `Cooldown active: ${Math.ceil(
          (cooldownUntil - Date.now()) / 1000
        )}s`
      );
      return;
    }

    if (
      activeContracts.length > 0
    ) {
      setEngineMessage(
        "Open trade bado iko active. Entry mpya imezuiwa."
      );
      return;
    }

    if (executionMode === "PAPER") {
      setEngineMessage(
        `PAPER ${candidate.label} · ${market?.label || symbol} · $${Number(
          smartEffectiveStake
        ).toFixed(2)}`
      );
      return;
    }

    if (!analysis.ready) {
      setEngineMessage(
        "Live buy imezuiwa: GeminiX gates hazijapita."
      );
      return;
    }

    try {
      setEngineMessage(
        `${source}: inanunua ${candidate.label}...`
      );

      await placeTrade({
        contractType: candidate.contractType,
        amount: Number(smartEffectiveStake),
        duration: 1,
        durationUnit: "t",
        barrier: candidate.barrier,
        symbol,
      });

      setEngineMessage(
        `${candidate.label} imenunuliwa kwa ${symbol} · stake $${Number(
          smartEffectiveStake
        ).toFixed(2)}${
          recoveryPending
            ? ` · recovery x${recoveryMultiplier}`
            : ""
        }.`
      );
    } catch (error) {
      setEngineMessage(
        error instanceof Error
          ? error.message
          : "GeminiX trade failed."
      );
    }
  };

  useEffect(() => {
    if (
      !running ||
      executionMode !== "LIVE" ||
      tradeBusy ||
      activeContracts.length > 0 ||
      Date.now() < cooldownUntil ||
      !portfolioReady ||
      !portfolioBest
    ) return;

    if (portfolioBest.symbol !== symbol) {
      if (!loadingMarket) {
        setEngineMessage(
          `Portfolio best: ${portfolioBest.symbol} ${portfolioBest.decision} · switching from ${symbol}.`
        );
        void changeSymbol(portfolioBest.symbol);
      }
      return;
    }

    if (
      !analysis.ready ||
      analysis.best.label !==
        portfolioBest.decision ||
      Number(
        portfolioBest.candidate
          ?.expectedValue || -1
      ) <= 0 ||
      Number(
        portfolioBest.candidate
          ?.statisticalEdge || -100
      ) <= 0
    ) {
      return;
    }

    const candidate =
      portfolioBest.candidate || analysis.best;

    const key = [
      portfolioBest.symbol,
      candidate.label,
      Math.round(portfolioBest.confidence || 0),
      Math.round(portfolioBest.probability || 0),
      lastSettlementKey,
    ].join(":");

    if (key === lastAutoTradeKeyRef.current) return;

    lastAutoTradeKeyRef.current = key;
    void executeCandidate(candidate, "PORTFOLIO AUTO");
  }, [
    running,
    executionMode,
    tradeBusy,
    activeContracts.length,
    cooldownUntil,
    portfolioReady,
    portfolioBest,
    loadingMarket,
    symbol,
    analysis.ready,
    analysis.best,
    lastSettlementKey,
  ]);

  const recentDigits = digitHistory.slice(-12);
  const feedLabel =
    connected && status === "CONNECTED"
      ? "LIVE"
      : loadingMarket
      ? "LOADING"
      : status || "DISCONNECTED";

  return (
    <section
      className={`${styles.geminiBotShell} ${
        compact ? styles.compact : ""
      }`}
    >
      <div className={styles.geminiTopbar}>
        <div className={styles.statusItems}>
          <div className={styles.statusField}>
            <label>Feed</label>
            <span
              className={`${styles.statusVal} ${
                connected
                  ? styles.textGreen
                  : styles.textRed
              }`}
            >
              {feedLabel}
            </span>
          </div>

          <div className={styles.statusField}>
            <label>Decision</label>
            <span className={styles.statusVal}>
              {analysis.decision}
            </span>
          </div>

          <div className={styles.statusField}>
            <label>Account</label>
            <span className={styles.statusVal}>
              {selectedAccountType || "demo"}{" "}
              {selectedAccountId
                ? `(${selectedAccountId})`
                : ""}
            </span>
          </div>
        </div>

        <div className={styles.statusNote}>
          Shared Deriv feed · edge ranking · TP/SL risk manager · recovery ladder
        </div>
      </div>

      {showControls ? (
        <div className={styles.geminiControlGrid}>
          <div className={styles.inputGroup}>
            <label>Market</label>
            <select
              value={symbol || ""}
              disabled={loadingMarket}
              onChange={(event) =>
                void changeSymbol(event.target.value)
              }
            >
              {markets.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.inputGroup}>
            <label>Stake ($)</label>
            <input
              type="number"
              min="0.35"
              step="0.01"
              value={stake}
              onChange={(event) =>
                setStake(
                  Math.max(
                    0.35,
                    Number(event.target.value || 0.35)
                  )
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Current Stake</label>
            <input value={Number(currentStake).toFixed(2)} disabled />
          </div>

          <div className={styles.inputGroup}>
            <label>Take Profit ($)</label>
            <input
              type="number"
              min="0.10"
              step="0.10"
              value={targetProfit}
              onChange={(event) =>
                setTargetProfit(
                  Math.max(0.10, Number(event.target.value || 5))
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Stop Loss ($)</label>
            <input
              type="number"
              min="0.35"
              step="0.10"
              value={stopLoss}
              onChange={(event) =>
                setStopLoss(
                  Math.max(0.35, Number(event.target.value || 10))
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Max Loss Streak</label>
            <select
              value={maxLossStreak}
              onChange={(event) =>
                setMaxLossStreak(Number(event.target.value))
              }
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
          </div>

          <div className={styles.inputGroup}>
            <label>Min Confidence (%)</label>
            <input
              type="number"
              min="55"
              max="95"
              value={minConfidence}
              onChange={(event) =>
                setMinConfidence(
                  clamp(event.target.value, 55, 95)
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Execution</label>
            <select
              value={executionMode}
              onChange={(event) =>
                setExecutionMode(event.target.value)
              }
            >
              <option value="PAPER">Paper Trading</option>
              <option value="LIVE">Demo/Live Transactions</option>
            </select>
          </div>

          <div className={styles.inputGroup}>
            <label>Recovery</label>
            <select
              value={
                recoveryEnabled ? "ON" : "OFF"
              }
              onChange={(event) => {
                const enabled =
                  event.target.value === "ON";
                setRecoveryEnabled(enabled);

                if (!enabled) {
                  setRecoveryPending(false);
                }
              }}
            >
              <option value="ON">
                ON · Single Step
              </option>
              <option value="OFF">OFF</option>
            </select>
          </div>

          <div className={styles.inputGroup}>
            <label>Recovery Multiplier</label>
            <select
              value={recoveryMultiplier}
              onChange={(event) =>
                setRecoveryMultiplier(
                  Number(event.target.value)
                )
              }
            >
              <option value={2}>x2</option>
              <option value={3}>x3</option>
              <option value={4}>x4</option>
            </select>
          </div>

          <div className={styles.inputGroup}>
            <label>Recovery Min Confidence</label>
            <input
              type="number"
              min="75"
              max="95"
              value={recoveryConfidence}
              onChange={(event) =>
                setRecoveryConfidence(
                  clamp(
                    event.target.value,
                    75,
                    95
                  )
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Recovery Stake Cap ($)</label>
            <input
              type="number"
              min="0.35"
              step="0.05"
              value={maxRecoveryStake}
              onChange={(event) =>
                setMaxRecoveryStake(
                  Math.max(
                    0.35,
                    Number(
                      event.target.value || 5
                    )
                  )
                )
              }
            />
          </div>

          <div className={styles.inputGroup}>
            <label>Batch Counter</label>
            <select
              value={campaignTarget}
              onChange={(event) =>
                setCampaignTarget(
                  Math.max(
                    1,
                    Math.min(
                      5,
                      Number(event.target.value)
                    )
                  )
                )
              }
            >
              {[1, 2, 3, 4, 5].map(
                (value) => (
                  <option
                    key={value}
                    value={value}
                  >
                    {value} runs per batch
                  </option>
                )
              )}
            </select>
          </div>

          <button
            type="button"
            className={`${styles.btnAction} ${
              running
                ? styles.stopBtn
                : styles.startBtn
            }`}
            onClick={() => {
              if (!connected) {
                void connect().catch(() => {});
              }

              if (!running) {
                if (
                  String(
                    selectedAccountType || ""
                  ).toLowerCase() === "demo"
                ) {
                  setExecutionMode("LIVE");
                  setEngineMessage(
                    "GeminiX imeanza Demo Transactions. Inasubiri quality entry."
                  );
                } else {
                  setEngineMessage(
                    "Real account haijawashwa automatically. Chagua Live Trading manually baada ya testing."
                  );
                }
              }

              setRunning((value) => !value);
            }}
          >
            {running
              ? "STOP GEMINIX"
              : "START GEMINIX"}
          </button>
        </div>
      ) : null}

      {statusDetail || tradeError ? (
        <div className={styles.errorBox}>
          {tradeError || statusDetail}
        </div>
      ) : null}

      <div className={styles.campaignGrid}>
        {[
          ["Campaign", campaignEnabled ? "ON" : "OFF"],
          ["Runs", `${campaignRuns}/${campaignTarget}`],
          ["Wins", campaignWins],
          ["Losses", campaignLosses],
          [
            "Open Trade",
            activeContracts.length ? "YES" : "NO",
          ],
          [
            "Cooldown",
            Date.now() < cooldownUntil
              ? `${Math.ceil(
                  (cooldownUntil - Date.now()) /
                    1000
                )}s`
              : "CLEAR",
          ],
          [
            "Recent Win Rate",
            percent(
              analysis.performance.winRate
            ),
          ],
          [
            "Recent P/L",
            Number(
              transactionSummary.profit || 0
            ).toFixed(2),
          ],
          [
            "Recovery",
            recoveryPending
              ? recoveryGatePassed
                ? `READY x${recoveryMultiplier}`
                : `ARMED · WAIT ${recoveryConfidence}%`
              : recoveryEnabled
              ? `STANDBY x${recoveryMultiplier}`
              : "OFF",
          ],
          [
            "Next Stake",
            `$${Number(
              smartEffectiveStake
            ).toFixed(2)}`,
          ],
          [
            "Recovery Gate",
            recoveryGatePassed
              ? "PASS"
              : recoveryPending
              ? "WAIT"
              : "IDLE",
          ],
          [
            "Session P/L",
            `${sessionProfit >= 0 ? "+" : ""}$${Number(sessionProfit).toFixed(2)}`,
          ],
          [
            "Loss Streak",
            `${consecutiveLosses}/${maxLossStreak}`,
          ],
          [
            "Risk Status",
            running ? "RUNNING" : "STOPPED",
          ],
          [
            "Risk Message",
            botStatusMessage,
          ],
          ["Portfolio", portfolioReady ? "READY" : `${marketRanking.length}/${minimumPortfolioMarkets}`],
          ["Best Market", portfolioBest?.symbol || "SCANNING"],
          ["Best Entry", portfolioBest?.decision || "WAIT"],
          [
            "Entry Edge",
            portfolioBest?.candidate
              ? `${Number(
                  portfolioBest.candidate
                    .statisticalEdge || 0
                ).toFixed(1)}%`
              : "—",
          ],
          [
            "Entry EV",
            portfolioBest?.candidate
              ? Number(
                  portfolioBest.candidate
                    .expectedValue || 0
                ).toFixed(3)
              : "—",
          ],
          [
            "Markets Scanned",
            Object.keys(marketMemory).length,
          ],
          [
            "Scan Cycle",
            "10s",
          ],
          [
            "Stale OPEN",
            staleContracts.length,
          ],
          [
            "Next Scan",
            `${Math.max(
              0,
              Math.ceil(
                (
                  10000 -
                  (
                    watchdogClock -
                    Number(
                      lastMarketSwitchAt || 0
                    )
                  )
                ) /
                  1000
              )
            )}s`,
          ],
        ].map(([label, value]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}

        <button
          type="button"
          onClick={() =>
            setCampaignEnabled((value) => !value)
          }
        >
          {campaignEnabled
            ? "DISABLE CAMPAIGN"
            : "ENABLE CAMPAIGN"}
        </button>

        <button
          type="button"
          onClick={resetCampaign}
        >
          RESET CAMPAIGN
        </button>
      </div>

      <div className={styles.geminiMainGrid}>
        <article className={styles.geminiPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>
              GEMINIX V6.3 FULL RISK MANAGER
            </span>
            <div className={styles.tags}>
              <span className={styles.recBadge}>
                REC: {analysis.best.label}
              </span>
              <span
                className={`${styles.decisionBadge} ${
                  analysis.ready
                    ? styles.execute
                    : styles.wait
                }`}
              >
                {analysis.decision}
              </span>
            </div>
          </div>

          <div className={styles.largeDecisionText}>
            {analysis.decision}
          </div>
          <p className={styles.reasonText}>
            {analysis.reason}
          </p>

          <div className={styles.gatesGrid}>
            {analysis.gates.map((gate) => (
              <div
                key={gate.name}
                className={`${styles.gateCard} ${
                  gate.passed
                    ? styles.gatePass
                    : styles.gateFail
                }`}
              >
                <span>
                  {gate.passed ? "✓" : "✕"}
                </span>
                <div>
                  <strong>{gate.name}: </strong>
                  <span>{gate.status}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.geminiPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>
              LIVE METRICS
            </span>
          </div>

          <div className={styles.metricsList}>
            <div className={styles.metricRow}>
              <span>Market</span>
              <strong>
                {market?.short || symbol || "—"}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Quote</span>
              <strong>
                {Number.isFinite(currentPrice)
                  ? Number(currentPrice).toFixed(
                      market?.decimals || 3
                    )
                  : "—"}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Last digit</span>
              <strong>{lastDigit ?? "—"}</strong>
            </div>
            <div className={styles.metricRow}>
              <span>Confidence</span>
              <strong>
                {percent(analysis.confidence)}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Probability</span>
              <strong>
                {percent(analysis.probability)}
              </strong>
            </div>
            <div className={styles.metricRow}>
              <span>Risk</span>
              <strong>{analysis.risk}</strong>
            </div>
            <div className={styles.metricRow}>
              <span>Contract Class</span>
              <strong>
                {analysis.best.riskClass || "HIGH"}
              </strong>
            </div>
          </div>
        </article>
      </div>

      <article className={styles.geminiPanel}>
        <div className={styles.panelHeader}>
          <span className={styles.title}>
            LIVE DIGITS & QUICK TRADING
          </span>
          <span className={styles.statusNote}>
            {analysis.sample}/60 samples
          </span>
        </div>

        <div className={styles.recentRow}>
          <div className={styles.recentDigits}>
            {recentDigits.length ? (
              recentDigits.map((digit, index) => (
                <span
                  key={`${index}-${digit}`}
                  className={
                    index === recentDigits.length - 1
                      ? styles.latestDigit
                      : ""
                  }
                >
                  {digit}
                </span>
              ))
            ) : (
              <small>Waiting for shared live ticks...</small>
            )}
          </div>

          {!compact ? (
            <div className={styles.quickButtons}>
              {analysis.candidates
                .slice(0, 10)
                .map((candidate) => (
                  <button
                    type="button"
                    key={candidate.label}
                    disabled={tradeBusy}
                    onClick={() =>
                      void executeCandidate(candidate)
                    }
                  >
                    BUY {candidate.label}
                  </button>
                ))}
            </div>
          ) : null}
        </div>

        <div className={styles.digitGrid}>
          {analysis.distribution.map((row) => (
            <div key={row.digit}>
              <small>D{row.digit}</small>
              <strong>
                {row.percent.toFixed(0)}%
              </strong>
            </div>
          ))}
        </div>
      </article>

      <div className={styles.analyticsRow}>
        {[
          ["momentum", percent(analysis.momentumStrength)],
          ["trend", analysis.direction],
          ["volatility", analysis.volatility],
          ["entropy", percent(analysis.entropy)],
          ["transition", percent(analysis.transition)],
          ["cycle", analysis.cycle],
          ["regime", analysis.regime],
          ["engine", running ? "RUNNING" : "READY"],
        ].map(([label, value]) => (
          <div className={styles.geminiMetric} key={label}>
            <label>{label}</label>
            <span>{value}</span>
          </div>
        ))}
      </div>

      <div className={styles.intelligenceGrid}>
        <article className={styles.geminiPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>
              LIVE MARKET MEMORY RANKING
            </span>
            <span className={styles.statusNote}>
              {marketRanking.length} markets
            </span>
          </div>

          <div className={styles.marketRankingGrid}>
            {marketRanking
              .slice(0, 10)
              .map((row, index) => (
                <div
                  className={`${styles.marketRankCard} ${
                    index === 0
                      ? styles.marketRankBest
                      : ""
                  }`}
                  key={row.symbol}
                >
                  <div>
                    <small>#{index + 1}</small>
                    <strong>{row.symbol}</strong>
                  </div>
                  <span>
                    {row.decision || "WAIT"}
                  </span>
                  <span>
                    Score {Number(
                      row.score || 0
                    ).toFixed(1)}
                  </span>
                  <span>
                    C {Number(
                      row.confidence || 0
                    ).toFixed(1)}%
                  </span>
                  <span>
                    P {Number(
                      row.probability || 0
                    ).toFixed(1)}%
                  </span>
                  <span>
                    Edge {Number(
                      row.candidate
                        ?.statisticalEdge || 0
                    ).toFixed(1)}%
                  </span>
                  <span>
                    EV {Number(
                      row.candidate
                        ?.expectedValue || 0
                    ).toFixed(3)}
                  </span>
                  <span>
                    {row.risk || "HIGH"} ·{" "}
                    {Math.round(
                      row.ageSeconds || 0
                    )}s
                  </span>
                </div>
              ))}

            {!marketRanking.length ? (
              <div className={styles.emptyTransactions}>
                Scanner inaanza kujenga memory ya kila market.
              </div>
            ) : null}
          </div>
        </article>

        <article className={styles.geminiPanel}>
          <div className={styles.panelHeader}>
            <span className={styles.title}>
              LAST AI DECISIONS
            </span>
            <span className={styles.statusNote}>
              latest 30
            </span>
          </div>

          <div className={styles.decisionHistory}>
            {decisionHistory
              .slice(0, 12)
              .map((row) => (
                <div key={`${row.time}-${row.id}`}>
                  <span>
                    {new Date(
                      row.time
                    ).toLocaleTimeString()}
                  </span>
                  <strong>{row.symbol}</strong>
                  <strong>{row.candidate}</strong>
                  <span>
                    C {Number(
                      row.confidence
                    ).toFixed(1)}%
                  </span>
                  <span>
                    P {Number(
                      row.probability
                    ).toFixed(1)}%
                  </span>
                  <span>{row.risk}</span>
                  <span>
                    {row.recovery
                      ? "RECOVERY"
                      : row.decision}
                  </span>
                </div>
              ))}

            {!decisionHistory.length ? (
              <div className={styles.emptyTransactions}>
                Decision history itajaa baada ya live ticks.
              </div>
            ) : null}
          </div>
        </article>
      </div>

      <article className={styles.geminiPanel}>
        <div className={styles.panelHeader}>
          <span className={styles.title}>
            GEMINIX TRANSACTIONS
          </span>
          <span className={styles.statusNote}>
            {normalizedContracts.length} contracts
          </span>
        </div>

        <div className={styles.transactionTable}>
          <div className={styles.transactionSummary}>
            <div>
              <span>Settled</span>
              <strong>
                {transactionSummary.count}
              </strong>
            </div>
            <div>
              <span>Wins</span>
              <strong>
                {transactionSummary.wins}
              </strong>
            </div>
            <div>
              <span>Losses</span>
              <strong>
                {transactionSummary.losses}
              </strong>
            </div>
            <div>
              <span>Win Rate</span>
              <strong>
                {percent(
                  transactionSummary.winRate
                )}
              </strong>
            </div>
            <div>
              <span>Net Profit</span>
              <strong>
                {transactionSummary.profit >= 0
                  ? "+"
                  : ""}
                {Number(
                  transactionSummary.profit
                ).toFixed(2)}
              </strong>
            </div>
          </div>

          <div className={styles.transactionHead}>
            <span>Market</span>
            <span>Contract</span>
            <span>Status</span>
            <span>Buy</span>
            <span>Payout</span>
            <span>Profit</span>
            <span>Entry</span>
          </div>

          {normalizedContracts
            .slice(0, 12)
            .map((trade) => (
              <div
                className={styles.transactionRow}
                key={trade.contractId}
              >
                <span>
                  {trade.symbol ||
                    trade.underlying ||
                    symbol}
                </span>
                <span>
                  {trade.contract_type ||
                    trade.contractType ||
                    "—"}
                </span>
                <span>
                  {trade.result}
                  {trade.staleOpen
                    ? " · force-rearmed"
                    : ""}
                </span>
                <span>
                  {Number(
                    trade.buy_price ??
                      trade.purchase_price ??
                      stake
                  ).toFixed(2)}
                </span>
                <span>
                  {Number(
                    trade.sell_price ??
                      trade.payout ??
                      (
                        Number(
                          trade.buy_price ??
                            trade.purchase_price ??
                            stake
                        ) +
                        Number(
                          trade.profit || 0
                        )
                      )
                  ).toFixed(2)}
                </span>
                <span
                  className={
                    Number(trade.profit || 0) > 0
                      ? styles.profitPositive
                      : Number(trade.profit || 0) < 0
                      ? styles.profitNegative
                      : ""
                  }
                >
                  {Number(trade.profit || 0) > 0
                    ? "+"
                    : ""}
                  {Number(
                    trade.profit || 0
                  ).toFixed(2)}
                </span>
                <span>
                  {Number(
                    trade.buy_price ??
                      trade.purchase_price ??
                      stake
                  ) > Number(stake) + 0.001
                    ? `REC x${(
                        Number(
                          trade.buy_price ??
                            trade.purchase_price ??
                            0
                        ) /
                        Math.max(
                          0.35,
                          Number(stake || 0.35)
                        )
                      ).toFixed(1)}`
                    : "BASE"}
                </span>
              </div>
            ))}

          {!normalizedContracts.length ? (
            <div className={styles.emptyTransactions}>
              Bonyeza START GEMINIX. Demo transaction ya kwanza itaingia quality gate ikipita.
            </div>
          ) : null}
        </div>
      </article>

      <div className={styles.engineMessage}>
        <span>{engineMessage}</span>

        {compact ? (
          <button
            type="button"
            onClick={() =>
              navigate("/gemini-x-engine")
            }
          >
            OPEN FULL GEMINIX
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function GeminiXDashboardPanel({ data }) {
  return (
    <GeminiXContent
      data={data}
      compact
      showControls={false}
    />
  );
}

export default function GeminiXEngine() {
  const data = useDerivTicks();

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="GeminiX Engine"
          subtitle="Shared Deriv analysis, controlled campaign and live demo execution"
          connected={data.connected}
          connecting={
            data.loadingMarket ||
            data.status === "CONNECTING"
          }
          onConnect={data.connect}
          onDisconnect={data.disconnect}
        />

        <div className={styles.pageFrame}>
          <GeminiXContent
            data={data}
            compact={false}
            showControls
          />
        </div>
      </main>
    </div>
  );
}
