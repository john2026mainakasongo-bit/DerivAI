import { useEffect, useMemo, useRef, useState } from "react";

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
    };
  });
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
  const [paperTrade, setPaperTrade] = useState(null);
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
  const protectionRunRef = useRef(-1);
  const lastJournalAtRef = useRef(0);

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

  const protectionPaused = now < protectionUntil;

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
      bestPattern: topPatterns[0] || null,
      worstPattern: weakPatterns[0] || null,
    };
  }, [adaptiveMemory]);

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
    if (!Number.isFinite(Number(liveQuote))) return;

    if (
      previousQuoteRef.current !== null &&
      Number(previousQuoteRef.current) !== Number(liveQuote)
    ) {
      setTickSerial((value) => value + 1);
    }

    previousQuoteRef.current = Number(liveQuote);
  }, [liveQuote]);

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
      paperTrade ||
      buyLockRef.current ||
      !stableEntryReady ||
      analysis.confidence < minimumConfidence ||
      Date.now() < cooldownUntil ||
      protectionPaused ||
      !liveQuote
    ) {
      return;
    }

    buyLockRef.current = true;

    setPaperTrade({
      id: crypto.randomUUID(),
      market: symbol,
      contract: analysis.contract,
      entry: liveQuote,
      stake: Number(stake),
      confidence: analysis.confidence,
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
    });

    setMessage(
      `PAPER ENTRY · ${analysis.contract} · ${analysis.confidence}%`
    );

    window.setTimeout(() => {
      buyLockRef.current = false;
    }, 1400);
  }, [
    analysis,
    stableEntryReady,
    liveQuote,
    minimumConfidence,
    mode,
    numericTicks.length,
    paperTrade,
    running,
    stake,
    symbol,
    tickSerial,
    cooldownUntil,
  ]);

  useEffect(() => {
    if (
      !paperTrade ||
      tickSerial <= Number(paperTrade.entrySerial || 0) + 4
    ) {
      return;
    }

    const exit = liveQuote;
    const won =
      paperTrade.contract === "RISE"
        ? exit > paperTrade.entry
        : exit < paperTrade.entry;

    const profit = won
      ? Number(paperTrade.stake) * 0.92
      : -Number(paperTrade.stake);

    setTransactions((current) =>
      [
        {
          ...paperTrade,
          exit,
          result: won ? "WON" : "LOST",
          profit,
          source: "PAPER",
          closedAt: new Date().toLocaleTimeString(),
        },
        ...current,
      ].slice(0, 120)
    );

    if (paperTrade.memorySignature) {
      setAdaptiveMemory((current) => {
        const previous =
          current[paperTrade.memorySignature] || {
            wins: 0,
            losses: 0,
            profit: 0,
          };

        return {
          ...current,
          [paperTrade.memorySignature]: {
            wins:
              Number(previous.wins || 0) +
              (won ? 1 : 0),
            losses:
              Number(previous.losses || 0) +
              (won ? 0 : 1),
            profit:
              Number(previous.profit || 0) +
              Number(profit || 0),
            updatedAt: Date.now(),
          },
        };
      });
    }

    if (paperTrade.clusterSignature) {
      setClusterMemory((current) => {
        const previous =
          current[paperTrade.clusterSignature] || {
            wins: 0,
            losses: 0,
            profit: 0,
          };

        return {
          ...current,
          [paperTrade.clusterSignature]: {
            wins:
              Number(previous.wins || 0) +
              (won ? 1 : 0),
            losses:
              Number(previous.losses || 0) +
              (won ? 0 : 1),
            profit:
              Number(previous.profit || 0) +
              Number(profit || 0),
            updatedAt: Date.now(),
          },
        };
      });
    }

    setMessage(
      `PAPER ${won ? "WON" : "LOST"} · ${
        profit >= 0 ? "+" : ""
      }$${money(profit)}`
    );
    setPaperTrade(null);
    setCooldownUntil(Date.now() + 5000);
  }, [liveQuote, paperTrade, tickSerial]);

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
      !stableEntryReady ||
      analysis.confidence < minimumConfidence ||
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

      <main className="mainContent final-integrated-page final-v7-page final-v14-page final-v15-page final-v16-page">
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
                setPaperTrade(null);
                void changeSymbol(next);
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
                  : paperTrade
                    ? `${paperTrade.contract} PAPER TRADE`
                    : `${learningPhase} · ${mode.toUpperCase()}`}
            </strong>
            <p>
              {paperTrade
                ? `Entry ${paperTrade.entry} · Stake $${money(
                    paperTrade.stake
                  )}`
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
              Phase: {learningPhase} · Armed: {armedTicks}/3 · Loss streak:{" "}
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
