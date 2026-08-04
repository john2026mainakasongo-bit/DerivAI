import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import { accountId, accountType } from "../components/DerivAccountSelector";
import DerivVolatilitySelector, { DERIV_VOLATILITY_MARKETS } from "../components/DerivVolatilitySelector";
import "../components/DerivSelectors.css";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import { analyzeOverUnder } from "../analysis/overUnderAnalysisEngine";
import "../styles/OverUnderAnalysis.css";

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function legacyAccountId(account = {}) {
  return String(
    account.id ||
    account.account_id ||
    account.loginid ||
    account.login_id ||
    ""
  );
}

function accountBalance(account = {}) {
  const value = Number(
    account.balance ??
    account.amount ??
    account.account_balance ??
    account.display_balance ??
    0
  );
  return Number.isFinite(value) ? value : 0;
}

function legacyAccountType(account = {}) {
  const id = accountId(account).toUpperCase();
  const type = String(account.type || account.account_type || "").toLowerCase();
  return type.includes("demo") || id.startsWith("VRTC") ? "demo" : "real";
}

function contractIdOf(item = {}) {
  return String(item.contract_id || item.id || item.contractId || "");
}

function contractStatus(item = {}) {
  const status = String(item.status || "").toUpperCase();
  if (
    item.is_sold ||
    item.is_expired ||
    ["WON", "LOST", "SOLD", "EXPIRED"].includes(status)
  ) {
    return status || "CLOSED";
  }
  return status || "OPEN";
}

function profitOf(item = {}) {
  const value = Number(
    item.profit ??
    item.profit_loss ??
    item.pnl ??
    (Number(item.sell_price || 0) - Number(item.buy_price || 0))
  );
  return Number.isFinite(value) ? value : 0;
}

export default function OverUnderAnalysis() {
  const auth = useDerivAuth();
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

  const [autoRunning, setAutoRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [durationTicks, setDurationTicks] = useState(1);
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [switchAfterSeconds, setSwitchAfterSeconds] = useState(8);
  const [runs, setRuns] = useState(0);
  const [switches, setSwitches] = useState(0);
  const [losses, setLosses] = useState(0);
  const [trades, setTrades] = useState([]);
  const [message, setMessage] = useState("Scanner stopped.");
  const [allowReal, setAllowReal] = useState(false);
  const [manualSide, setManualSide] = useState("OVER");
  const [manualBarrier, setManualBarrier] = useState(1);
  const [v89StrategyMemory, setV89StrategyMemory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("edgepilot-v89-ou-memory") || "{}");
    } catch {
      return {};
    }
  });
  const [v89ProcessedSettlements, setV89ProcessedSettlements] = useState(() => new Set());
  const [v89FreshTicks, setV89FreshTicks] = useState(99);
  const [strategyStats, setStrategyStats] = useState({});
  const [settledRuns, setSettledRuns] = useState([]);
  const [freshTicksAfterSettlement, setFreshTicksAfterSettlement] = useState(99);

  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const lossRef = useRef(0);
  const waitRef = useRef(Date.now());
  const switchRef = useRef(false);
  const lastSwitchRef = useRef(0);
  const processedRef = useRef(new Set());
  const nextEntryAtRef = useRef(0);
  const v89LastContractRef = useRef("");
  const v89LastPriceCountRef = useRef(0);
  const lastContractRef = useRef("");
  const lastPriceCountRef = useRef(0);

  const accounts = useMemo(() => {
    const values =
      auth.accounts ||
      auth.session?.accounts ||
      auth.accountList ||
      [];
    return Array.isArray(values) ? values : [];
  }, [auth.accounts, auth.session?.accounts, auth.accountList]);

  const selectedAccount =
    auth.selectedAccount ||
    accounts.find((account) => accountId(account) === selectedAccountId) ||
    null;

  const selectedId = accountId(selectedAccount) || selectedAccountId;
  const currentType =
    auth.selectedAccountType ||
    selectedAccountType ||
    accountType(selectedAccount);
  const currency = selectedAccount?.currency || "USD";
  const balance = accountBalance(selectedAccount);

  useEffect(() => {
    runningRef.current = autoRunning;
  }, [autoRunning]);

  useEffect(() => {
    lossRef.current = losses;
  }, [losses]);

  useEffect(() => {
    if (!connected && typeof connect === "function") {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  useEffect(() => {
    if (!selectedId) return;

    const changed = derivPublicClient.configureAccount({
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedId,
    });

    if (changed && connected) {
      void derivPublicClient.reconnect();
    }
  }, [
    selectedId,
    connected,
    auth.session?.accessToken,
    auth.config?.clientId,
  ]);

  const analysis = useMemo(() => analyzeOverUnder(prices), [prices]);

  useEffect(() => {
    const count = Array.isArray(prices) ? prices.length : 0;
    if (count > v89LastPriceCountRef.current) {
      setV89FreshTicks((value) => Math.min(99, value + 1));
    }
    v89LastPriceCountRef.current = count;
  }, [prices]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "edgepilot-v89-ou-memory",
        JSON.stringify(v89StrategyMemory)
      );
    } catch {
      // Storage is optional; live analysis continues without it.
    }
  }, [v89StrategyMemory]);

  useEffect(() => {
    const settled = (Array.isArray(trades) ? trades : []).filter((trade) => {
      const status = String(trade?.status || "").toUpperCase();
      return ["WON", "LOST", "SOLD", "EXPIRED"].includes(status);
    });

    const freshSettlements = settled.filter((trade) => {
      const id = String(
        trade?.contractId ||
        trade?.contract_id ||
        trade?.id ||
        `${trade?.time}-${trade?.contract}`
      );
      return id && !v89ProcessedSettlements.has(id);
    });

    if (!freshSettlements.length) return;

    setV89StrategyMemory((current) => {
      const next = { ...current };

      for (const trade of freshSettlements) {
        const contract = String(trade?.contract || "").toUpperCase().trim();
        if (!/^(OVER|UNDER)\s+[1-7]$/.test(contract)) continue;

        const status = String(trade?.status || "").toUpperCase();
        const old = next[contract] || { wins: 0, losses: 0, profit: 0 };
        const profit = Number(trade?.profit || trade?.pnl || 0);

        next[contract] = {
          wins: old.wins + (status === "WON" || profit > 0 ? 1 : 0),
          losses: old.losses + (status === "LOST" || profit < 0 ? 1 : 0),
          profit: Number(old.profit || 0) + profit,
        };
      }

      return next;
    });

    setV89ProcessedSettlements((current) => {
      const next = new Set(current);
      for (const trade of freshSettlements) {
        next.add(
          String(
            trade?.contractId ||
            trade?.contract_id ||
            trade?.id ||
            `${trade?.time}-${trade?.contract}`
          )
        );
      }
      return next;
    });

    setV89FreshTicks(0);
    waitRef.current = Date.now();
    nextEntryAtRef.current = Date.now() + 5000;
    setMessage("Settlement received. Full OVER/UNDER re-scan started.");
  }, [trades]);

  const v89AdaptiveAnalysis = useMemo(() => {
    const rawCandidates = Array.isArray(analysis.candidates)
      ? analysis.candidates
      : [analysis.best].filter(Boolean);

    const ranked = rawCandidates
      .filter((candidate) =>
        candidate &&
        candidate.autoEligible !== false &&
        ["OVER", "UNDER"].includes(String(candidate.side || "").toUpperCase()) &&
        Number(candidate.barrier) >= 2 &&
        Number(candidate.barrier) <= 6
      )
      .map((candidate) => {
        const key = `${String(candidate.side).toUpperCase()} ${Number(candidate.barrier)}`;
        const memory = v89StrategyMemory[key] || {
          wins: 0,
          losses: 0,
          profit: 0,
        };

        const learnedRuns = Number(memory.wins || 0) + Number(memory.losses || 0);
        const learnedWinRate = learnedRuns
          ? (Number(memory.wins || 0) / learnedRuns) * 100
          : 50;

        const transition = Number(
          candidate.transitionScore ??
          candidate.transition ??
          0
        );
        const probability = Number(candidate.probability || 0);
        const exactRisk = Number(candidate.exactRisk || 100);
        const baseScore = Number(candidate.score || 0);

        const historicalWeight =
          learnedRuns >= 5
            ? Math.max(-8, Math.min(8, (learnedWinRate - 50) * 0.16))
            : 0;

        const repeatPenalty = v89LastContractRef.current === key ? 24 : 0;

        const edge = Number(candidate.probabilityEdge || 0);
        const transitionEdge = Number(candidate.transitionEdge || 0);

        const finalScore =
          baseScore * 0.45 +
          Math.max(0, edge) * 3.2 +
          Math.max(0, transitionEdge) * 1.1 +
          Math.min(6, historicalWeight) -
          repeatPenalty;

        return {
          ...candidate,
          key,
          transitionScore: transition,
          finalScore,
          learnedRuns,
          learnedWinRate,
          learnedProfit: Number(memory.profit || 0),
        };
      })
      .sort((left, right) => right.finalScore - left.finalScore);

    const best = ranked[0] || analysis.best || {
      side: "WAIT",
      barrier: 1,
      probability: 0,
      transitionScore: 0,
      exactRisk: 100,
      score: 0,
      finalScore: 0,
    };

    const qualified =
      Number(analysis.total || 0) >= 120 &&
      Number(best.finalScore || 0) >= 67 &&
      Number(best.probabilityEdge || 0) >= 2.5 &&
      Number(best.transitionEdge || 0) >= 1.5 &&
      Number(best.exactRisk || 100) <= 14 &&
      best.key !== v89LastContractRef.current &&
      v89FreshTicks >= 5;

    return {
      ...analysis,
      candidates: ranked,
      best,
      tradeNow: qualified,
      decision: qualified
        ? `BUY ${best.side} ${best.barrier}`
        : v89FreshTicks < 2
          ? "FRESH RESCAN"
          : "SCANNING OVER + UNDER",
      reason: qualified
        ? `${best.key} leads all current contracts with score ${best.finalScore.toFixed(1)}.`
        : v89FreshTicks < 2
          ? "Waiting for five fresh ticks after settlement."
          : "Ranking every OVER and UNDER barrier before the next entry.",
    };
  }, [analysis, v89StrategyMemory, v89FreshTicks]);

  useEffect(() => {
    const count = Array.isArray(prices) ? prices.length : 0;
    if (count > lastPriceCountRef.current) {
      setFreshTicksAfterSettlement((value) => Math.min(99, value + 1));
    }
    lastPriceCountRef.current = count;
  }, [prices]);

  const adaptiveAnalysis = useMemo(() => {
    const ranked = Array.isArray(analysis.candidates)
      ? analysis.candidates
      : [analysis.best].filter(Boolean);

    const scored = ranked.map((candidate) => {
      const key = `${candidate.side}-${candidate.barrier}`;
      const stat = strategyStats[key] || { wins: 0, losses: 0 };
      const samples = stat.wins + stat.losses;
      const winRate = samples ? (stat.wins / samples) * 100 : 50;
      const learningBonus =
        samples >= 2 ? Math.max(-7, Math.min(7, (winRate - 50) * 0.14)) : 0;
      const repeatPenalty = lastContractRef.current === key ? 8 : 0;

      return {
        ...candidate,
        adaptiveScore: candidate.score + learningBonus - repeatPenalty,
        learnedSamples: samples,
        learnedWinRate: winRate,
      };
    }).sort((a, b) => b.adaptiveScore - a.adaptiveScore);

    const best = scored[0] || analysis.best;
    const qualified =
      analysis.total >= 60 &&
      best.adaptiveScore >= 72 &&
      best.probability >= 72 &&
      best.transitionScore >= 52 &&
      best.exactRisk <= 16 &&
      freshTicksAfterSettlement >= 2;

    return {
      ...analysis,
      best,
      candidates: scored,
      tradeNow: qualified,
      decision: qualified
        ? `BUY ${best.side} ${best.barrier}`
        : freshTicksAfterSettlement < 2
          ? "FRESH RESCAN"
          : "SCANNING ALL BARRIERS",
      reason: qualified
        ? `${best.side} ${best.barrier} is currently the highest adaptive setup.`
        : freshTicksAfterSettlement < 2
          ? "Waiting for two fresh ticks after the previous settlement."
          : "Comparing OVER and UNDER barriers across the current market.",
    };
  }, [analysis, strategyStats, freshTicksAfterSettlement]);

  useEffect(() => {
    if (v89AdaptiveAnalysis.best.side !== "WAIT") {
      setManualSide(v89AdaptiveAnalysis.best.side);
      setManualBarrier(v89AdaptiveAnalysis.best.barrier);
    }
  }, [v89AdaptiveAnalysis.best.side, v89AdaptiveAnalysis.best.barrier]);

  const marketSymbols = DERIV_VOLATILITY_MARKETS.map((item) => item.id);

  const hasOpenTrade = trades.some((trade) => trade.status === "OPEN");

  function stopAuto(text) {
    runningRef.current = false;
    setAutoRunning(false);
    setMessage(text);
  }

  async function switchAccount(nextId) {
    const account = accounts.find((item) => accountId(item) === nextId);
    if (!account) return;

    const method =
      auth.selectAccount ||
      auth.setSelectedAccount ||
      auth.chooseAccount ||
      auth.switchAccount;

    if (typeof method === "function") {
      await Promise.resolve(method(account));
      setMessage(`Switched to ${accountType(account).toUpperCase()} account.`);
    } else {
      setMessage("Account switch method is unavailable. Use the Deriv account menu.");
    }
  }

  function resetTransactions() {
    setTrades([]);
    setRuns(0);
    setLosses(0);
    lossRef.current = 0;
    processedRef.current = new Set();
    setMessage(runningRef.current ? "Stats reset; scanner continues." : "Stats reset.");
  }

  function nextMarket() {
    if (!marketSymbols.length) return "";
    const current = marketSymbols.indexOf(symbol);
    return marketSymbols[current >= 0 ? (current + 1) % marketSymbols.length : 0];
  }

  async function switchMarket(reason) {
    if (
      switchRef.current ||
      hasOpenTrade ||
      tradeBusy ||
      typeof changeSymbol !== "function"
    ) return;

    const next = nextMarket();
    if (!next || next === symbol) return;

    switchRef.current = true;
    lastSwitchRef.current = Date.now();
    waitRef.current = Date.now();
    setMessage(`Switching ${symbol} → ${next}: ${reason}`);

    try {
      await Promise.resolve(changeSymbol(next));
      setSwitches((value) => value + 1);
    } finally {
      window.setTimeout(() => {
        switchRef.current = false;
      }, 800);
    }
  }

  async function sendTrade(side, barrier, source = "MANUAL") {
    if (busyRef.current || hasOpenTrade || Date.now() < nextEntryAtRef.current) return;

    if (!connected) {
      setMessage("Waiting for Deriv connection.");
      return;
    }

    if (!selectedId) {
      setMessage("Choose a Demo or Real account.");
      return;
    }

    if (currentType !== "demo" && !allowReal) {
      setMessage("Real execution is locked. Enable it first.");
      return;
    }

    if (lossRef.current >= 2) {
      stopAuto("Hard stop: 2 consecutive losses.");
      return;
    }

    busyRef.current = true;

    try {
      const result = await placeTrade({
        symbol,
        contractType: side === "OVER" ? "DIGITOVER" : "DIGITUNDER",
        amount: Math.max(0.35, Number(stake) || 0.35),
        basis: "stake",
        duration: Math.max(1, Number(durationTicks) || 1),
        durationUnit: "t",
        barrier: String(barrier),
      });

      const contractId = String(result?.contractId || "");
      setRuns((value) => value + 1);
      setTrades((current) => [
        {
          id: contractId || String(Date.now()),
          contractId,
          time: Date.now(),
          symbol,
          contract: `${side} ${barrier}`,
          source,
          duration: `${durationTicks} TICK`,
          stake: Math.max(0.35, Number(stake) || 0.35),
          confidence: analysis.confidence,
          score: v89AdaptiveAnalysis.best.finalScore ?? v89AdaptiveAnalysis.best.score,
          status: "OPEN",
          profit: 0,
        },
        ...current,
      ].slice(0, 40));

      lastContractRef.current = `${side}-${barrier}`;
      v89LastContractRef.current = `${String(side).toUpperCase()} ${Number(barrier)}`;
      setMessage(`${source}: ${side} ${barrier} opened. Next trade requires a fresh full scan.`);
      nextEntryAtRef.current = Date.now() + 5000;
      waitRef.current = Date.now();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally {
      busyRef.current = false;
    }
  }

  async function executeAutoTrade() {
    if (
      !runningRef.current ||
      !v89AdaptiveAnalysis.tradeNow ||
      v89AdaptiveAnalysis.best.side === "WAIT"
    ) return;
    await sendTrade(v89AdaptiveAnalysis.best.side, v89AdaptiveAnalysis.best.barrier, "AUTO");
  }

  function toggleAuto() {
    if (autoRunning) {
      stopAuto("Stopped manually.");
      return;
    }

    if (currentType !== "demo" && !allowReal) {
      setMessage("Enable Real execution or switch to Demo.");
      return;
    }

    waitRef.current = Date.now();
    runningRef.current = true;
    setAutoRunning(true);
    setMessage("Scanning every fresh tick; qualified entries execute immediately.");
  }

  useEffect(() => {
    if (autoRunning && v89AdaptiveAnalysis.tradeNow && !hasOpenTrade && losses < 3) {
      void executeAutoTrade();
    }
  }, [
    autoRunning,
    v89AdaptiveAnalysis.tradeNow,
    v89AdaptiveAnalysis.best.side,
    v89AdaptiveAnalysis.best.barrier,
    v89AdaptiveAnalysis.best.finalScore ?? v89AdaptiveAnalysis.best.score,
    hasOpenTrade,
    losses,
    symbol,
  ]);

  useEffect(() => {
    if (
      !autoRunning ||
      !autoSwitch ||
      hasOpenTrade ||
      tradeBusy ||
      marketSymbols.length < 2 ||
      losses >= 3
    ) return;

    if (v89AdaptiveAnalysis.tradeNow) {
      waitRef.current = Date.now();
      return;
    }

    const timer = window.setInterval(() => {
      const delay = Math.max(5, Number(switchAfterSeconds) || 8) * 1000;
      const now = Date.now();

      if (
        now - waitRef.current >= delay &&
        now - lastSwitchRef.current >= delay
      ) {
        void switchMarket(v89AdaptiveAnalysis.reason);
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, [
    autoRunning,
    autoSwitch,
    hasOpenTrade,
    tradeBusy,
    marketSymbols,
    symbol,
    v89AdaptiveAnalysis.tradeNow,
    v89AdaptiveAnalysis.reason,
    switchAfterSeconds,
    losses,
  ]);

  useEffect(() => {
    const contracts = Array.isArray(openContracts) ? openContracts : [];
    if (!contracts.length) return;

    let result = null;

    setTrades((current) =>
      current.map((trade) => {
        const match = contracts.find(
          (item) => contractIdOf(item) === trade.contractId
        );
        if (!match) return trade;

        const status = contractStatus(match);
        const closed = ["WON", "LOST", "SOLD", "EXPIRED"].includes(status);

        if (
          closed &&
          trade.contractId &&
          !processedRef.current.has(trade.contractId)
        ) {
          processedRef.current.add(trade.contractId);
          result = status;
        }

        return { ...trade, status, profit: profitOf(match) };
      })
    );

    if (result === "WON") {
      const settled = trades.find(
        (trade) =>
          trade.contractId &&
          processedRef.current.has(trade.contractId) &&
          trade.status === "OPEN"
      );
      const contract = settled?.contract || "";
      const key = contract.replace(" ", "-");

      if (key) {
        setStrategyStats((current) => {
          const old = current[key] || { wins: 0, losses: 0 };
          return { ...current, [key]: { ...old, wins: old.wins + 1 } };
        });
      }

      setSettledRuns((current) =>
        [{ result: "WON", contract, market: symbol }, ...current].slice(0, 5)
      );
      setFreshTicksAfterSettlement(0);
      lossRef.current = 0;
      setLosses(0);
      nextEntryAtRef.current = Date.now() + 5000;
      waitRef.current = Date.now();
      setMessage("WIN settled. Re-scanning every OVER and UNDER setup.");
    } else if (result === "LOST") {
      const settled = trades.find(
        (trade) =>
          trade.contractId &&
          processedRef.current.has(trade.contractId) &&
          trade.status === "OPEN"
      );
      const contract = settled?.contract || "";
      const key = contract.replace(" ", "-");

      if (key) {
        setStrategyStats((current) => {
          const old = current[key] || { wins: 0, losses: 0 };
          return { ...current, [key]: { ...old, losses: old.losses + 1 } };
        });
      }

      setSettledRuns((current) =>
        [{ result: "LOST", contract, market: symbol }, ...current].slice(0, 5)
      );
      setFreshTicksAfterSettlement(0);

      const next = lossRef.current + 1;
      lossRef.current = next;
      setLosses(next);
      nextEntryAtRef.current = Date.now() + 2500;
      waitRef.current = Date.now();

      if (next >= 2 && runningRef.current) {
        stopAuto("Hard stop: 2 consecutive losses.");
      } else if (runningRef.current && autoSwitch) {
        void switchMarket("Loss settled; testing a different volatility market.");
      } else if (runningRef.current && autoSwitch) {
        void switchMarket("Loss settled; testing a different volatility market.");
      }
    }
  }, [openContracts]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent ouPage">
        <Topbar
          title="EdgePilot V91 · EV-Balanced Scanner"
          subtitle="Baseline-corrected OVER/UNDER ranking · five fresh ticks after settlement · loss market rotation"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="ouTopStrip">
          <DerivVolatilitySelector
            value={symbol}
            disabled={loadingMarket || autoRunning}
            onChange={changeSymbol}
          />
<div className="ouTopActions">
            <button type="button" className="ouReset" onClick={resetTransactions}>
              RESET
            </button>
            <button
              type="button"
              className={autoRunning ? "ouStop" : "ouStart"}
              disabled={tradeBusy}
              onClick={toggleAuto}
            >
              {tradeBusy ? "SENDING…" : autoRunning ? "■ STOP" : "▶ START"}
            </button>
          </div>
        </section>

        <section className={`ouExecution ${autoRunning ? "running" : ""}`}>
          <div className="ouExecutionStatus">
            <small>OVER/UNDER EXECUTION</small>
            <h2>{autoRunning ? "RUNNING" : "STOPPED"}</h2>
            <p>{message || tradeError}</p>
          </div>

          <div className="ouControlGrid">
            <label><span>Stake</span><input type="number" inputMode="decimal" min="0.35" step="0.01" value={stake} onChange={(event) => setStake(event.target.value)} /></label>
            <label><span>Duration</span><select value={durationTicks} onChange={(event) => setDurationTicks(event.target.value)}><option value="1">1 TICK</option><option value="2">2 TICKS</option><option value="3">3 TICKS</option><option value="5">5 TICKS</option></select></label>
            <label><span>Manual side</span><select value={manualSide} onChange={(event) => setManualSide(event.target.value)}><option value="OVER">OVER</option><option value="UNDER">UNDER</option></select></label>
            <label><span>Barrier</span><select value={manualBarrier} onChange={(event) => setManualBarrier(Number(event.target.value))}>{[1,2,3,4,5,6,7].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <div className="ouQuickTradeButtons">
              <button
                type="button"
                className="ouQuickOver"
                disabled={tradeBusy || hasOpenTrade}
                onClick={() => {
                  setManualSide("OVER");
                  void sendTrade("OVER", manualBarrier, "MANUAL OVER");
                }}
              >
                <span>BUY</span>
                <strong>OVER {manualBarrier} · {durationTicks}T</strong>
              </button>

              <button
                type="button"
                className="ouQuickUnder"
                disabled={tradeBusy || hasOpenTrade}
                onClick={() => {
                  setManualSide("UNDER");
                  void sendTrade("UNDER", manualBarrier, "MANUAL UNDER");
                }}
              >
                <span>BUY</span>
                <strong>UNDER {manualBarrier} · {durationTicks}T</strong>
              </button>
            </div>
            <label><span>Auto switch</span><select value={autoSwitch ? "ON" : "OFF"} onChange={(event) => setAutoSwitch(event.target.value === "ON")}><option>ON</option><option>OFF</option></select></label>
            <label><span>Switch after</span><input type="number" inputMode="numeric" min="5" max="60" value={switchAfterSeconds} onChange={(event) => setSwitchAfterSeconds(event.target.value)} /></label>
            <div><span>Runs</span><strong>{runs}</strong></div>
            <div><span>Loss streak</span><strong>{losses}/2</strong></div>
            <div><span>Markets</span><strong>{switches + 1}</strong></div>
            <label className="ouRealToggle"><span>Real execution</span><input type="checkbox" checked={allowReal} disabled={currentType === "demo"} onChange={(event) => setAllowReal(event.target.checked)} /></label>
          </div>
        </section>

        <div className="ouManualHint">
          Manual OVER/UNDER executes immediately using the selected barrier,
          stake and duration ({durationTicks} tick{Number(durationTicks) === 1 ? "" : "s"}).
        </div>

        <section className={`ouHero ${v89AdaptiveAnalysis.tradeNow ? "ready" : analysis.prepare ? "prepare" : ""}`}>
          <div className="ouHeroDecision">
            <small>NEXT ENTRY</small>
            <h1>{v89AdaptiveAnalysis.decision}</h1>
            <p>{v89AdaptiveAnalysis.reason}</p>
          </div>
          <div className="ouHeroStats">
            <span><small>Grade</small><strong>{analysis.grade}</strong></span>
            <span><small>Confidence</small><strong>{pct(analysis.confidence)}</strong></span>
            <span><small>Quality</small><strong>{pct(analysis.quality)}</strong></span>
            <span><small>Risk</small><strong>{analysis.risk}</strong></span>
          </div>
        </section>

        <section className="ouSignalGrid">
          <article><small>ROW PRESSURE</small><strong>{analysis.rowPressure}</strong><span>Recent movement between 0–4 and 5–9.</span></article>
          <article><small>CURRENT DIGIT</small><strong>{analysis.latestDigit}</strong><span>Latest live digit.</span></article>
          <article><small>WAIT / TRIGGER</small><strong>{analysis.triggerDigits.join(" · ") || "—"}</strong><span>Digits supporting the selected entry.</span></article>
          <article><small>WINNING DIGITS</small><strong>{analysis.winningDigits.join(" · ") || "—"}</strong><span>Digits that win the selected contract.</span></article>
          <article><small>AVOID DIGITS</small><strong>{analysis.avoidDigits.join(" · ") || "—"}</strong><span>Barrier and losing side.</span></article>
          <article><small>BEST DIFFERS</small><strong>DIFFERS {analysis.bestDiffers.digit}</strong><span>{pct(analysis.bestDiffers.differsProbability)} observed differs probability.</span></article>
        </section>

        <section className="ouCandidateGrid">
          <article><small>CONTRACT</small><strong>{v89AdaptiveAnalysis.best.side} {v89AdaptiveAnalysis.best.barrier}</strong><span>Best ranked setup.</span></article>
          <article><small>PROBABILITY</small><strong>{pct(v89AdaptiveAnalysis.best.probability)}</strong><span>Observed distribution.</span></article>
          <article><small>EXACT RISK</small><strong>{pct(v89AdaptiveAnalysis.best.exactRisk)}</strong><span>Barrier landing risk.</span></article>
          <article><small>TRANSITION</small><strong>{pct(v89AdaptiveAnalysis.best.transitionScore)}</strong><span>Recent continuation support.</span></article>
          <article><small>ENTRY SCORE</small><strong>{pct(v89AdaptiveAnalysis.best.finalScore ?? v89AdaptiveAnalysis.best.score)}</strong><span>Weighted opportunity.</span></article>
          <article><small>ENTROPY</small><strong>{pct(analysis.entropy)}</strong><span>Higher means more random.</span></article>
        </section>

        <section className="ouMainGrid">
          <article className="ouPanel">
            <div className="ouPanelHead"><div><small>DIGIT HEATMAP</small><h2>Live distribution 0–9</h2></div><strong>{analysis.total} ticks</strong></div>
            <div className="ouDigitBars">
              {analysis.counts.map((count, digit) => {
                const value = analysis.total ? count / analysis.total * 100 : 0;
                return <div key={digit}><span>{digit}</span><i><b style={{ width: `${value}%` }} /></i><strong>{pct(value)}</strong></div>;
              })}
            </div>
          </article>

          <article className="ouPanel">
            <div className="ouPanelHead"><div><small>LIVE DIGIT FLOW</small><h2>Most recent digits</h2></div><strong>{market?.label || symbol}</strong></div>
            <div className="ouRecentDigits">
              {analysis.recentDigits.map((digit, index) => <span key={`${digit}-${index}`} className={index === analysis.recentDigits.length - 1 ? "latest" : digit <= 4 ? "lower" : "upper"}>{digit}</span>)}
            </div>
            <div className="ouDiffersList">
              {analysis.differs.map((item) => <div key={item.digit}><strong>DIFFERS {item.digit}</strong><span>risk {pct(item.exactRisk)}</span><b>{pct(item.differsProbability)}</b></div>)}
            </div>
          </article>
        </section>

        <section className="ouPanel ouBarrierPanel">
          <div className="ouPanelHead"><div><small>BARRIER COMPARISON</small><h2>Over and Under probability</h2></div></div>
          <div className="ouBarrierTable">
            <div className="head"><span>Barrier</span><span>Over</span><span>Under</span><span>Exact risk</span></div>
            {analysis.rows.map((row) => <button type="button" key={row.barrier} className={row.barrier === v89AdaptiveAnalysis.best.barrier ? "selected" : ""} onClick={() => setManualBarrier(row.barrier)}><strong>{row.barrier}</strong><span>{pct(row.over)}</span><span>{pct(row.under)}</span><span>{pct(row.exact)}</span></button>)}
          </div>
        </section>

        <section className="ouPanel">
          <div className="ouPanelHead"><div><small>TRADE VIEWER</small><h2>Open and recent trades</h2></div><strong>{trades.length} trades</strong></div>
          <div className="ouTradeTable">
            <div className="head"><span>Time</span><span>Market</span><span>Contract</span><span>Mode</span><span>Stake</span><span>Status</span><span>P/L</span></div>
            {trades.map((trade) => <div key={trade.id}><span>{new Date(trade.time).toLocaleTimeString()}</span><span>{trade.symbol}</span><strong>{trade.contract}</strong><span>{trade.source}</span><span>{Number(trade.stake).toFixed(2)}</span><b className={String(trade.status).toLowerCase()}>{trade.status}</b><b className={trade.profit >= 0 ? "won" : "lost"}>{Number(trade.profit).toFixed(2)}</b></div>)}
            {!trades.length ? <p>No trades in this session.</p> : null}
          </div>
        </section>

        <section className="ouPanel ouAdaptivePanel">
          <div className="ouPanelHead">
            <div>
              <small>ALL CONTRACT RANKING</small>
              <h2>OVER and UNDER candidates</h2>
            </div>
            <strong>{v89AdaptiveAnalysis.candidates.length} scanned</strong>
          </div>

          <div className="ouV89Ranking">
            {v89AdaptiveAnalysis.candidates.slice(0, 8).map((candidate) => (
              <div key={candidate.key} className={candidate.key === v89AdaptiveAnalysis.best.key ? "best" : ""}>
                <strong>{candidate.key}</strong>
                <span>{Number(candidate.finalScore || 0).toFixed(1)}</span>
                <small>
                  P ${Number(candidate.probability || 0).toFixed(0)} ·
                  EDGE ${Number(candidate.probabilityEdge || 0).toFixed(1)} ·
                  T-EDGE ${Number(candidate.transitionEdge || 0).toFixed(1)} ·
                  R ${Number(candidate.exactRisk || 0).toFixed(0)}
                </small>
              </div>
            ))}
          </div>
          <div className="ouPanelHead">
            <div>
              <small>ADAPTIVE MEMORY</small>
              <h2>Last 5 settled runs</h2>
            </div>
            <strong>{Object.values(v89StrategyMemory).reduce((sum, item) => sum + Number(item.wins || 0) + Number(item.losses || 0), 0)} learned</strong>
          </div>
          <div className="ouAdaptiveRuns">
            {settledRuns.map((run, index) => (
              <div key={`${run.contract}-${index}`}>
                <b className={run.result.toLowerCase()}>
                  {run.result}
                </b>

                <strong>{run.contract || "—"}</strong>
                <span>{run.market}</span>
              </div>
            ))}

            {!settledRuns.length ? (
              <p>
                Warm-up uses the live Deriv tick history already loaded
                before START.
              </p>
            ) : null}
          </div>
        </section>

        <div className="ouDisclaimer">
          Analysis is probabilistic. Test on Demo before enabling Real
          execution.
        </div>
      </main>
    </div>
  );
}