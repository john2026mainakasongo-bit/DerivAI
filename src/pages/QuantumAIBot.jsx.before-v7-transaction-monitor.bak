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
  return String(value?.contract_id || value?.id || "");
}

function settled(contract) {
  return Boolean(
    contract?.is_sold ||
      contract?.is_expired ||
      ["won", "lost", "sold"].includes(String(contract?.status || "").toLowerCase())
  );
}

function contractProfit(contract) {
  const direct = Number(contract?.profit);
  if (Number.isFinite(direct)) return direct;
  const payout = Number(contract?.payout || contract?.sell_price || 0);
  const buy = Number(contract?.buy_price || contract?.purchase_price || 0);
  return payout - buy;
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
    tradeBusy,
    tradeError,
    selectedAccountType,
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("Quantum AI is ready.");
  const [settings, setSettings] = useState({
    stake: 0.35,
    minConfidence: 72,
    maxNoise: 66,
    maxReversalRisk: 60,
    maxOpenTrades: 2,
    marketSwitchSeconds: 12,
    minimumTradeGapSeconds: 3,
    takeProfit: 5,
    stopLoss: 3,
  });
  const [activeTrades, setActiveTrades] = useState([]);
  const [stats, setStats] = useState(INITIAL_STATS);
  const [marketScores, setMarketScores] = useState({});

  const lastTradeAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const processedContractsRef = useRef(new Set());
  const buyingRef = useRef(false);
  const autoConnectStartedRef = useRef(false);

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

  useEffect(() => {
    if (!symbol) return;
    setMarketScores((current) => ({
      ...current,
      [symbol]: {
        symbol,
        label: market?.label || symbol,
        confidence: analysis.confidence,
        decision: analysis.decision,
        score: analysis.confidence - analysis.reversalRisk * 0.15,
        updatedAt: Date.now(),
      },
    }));
  }, [symbol, market?.label, analysis.confidence, analysis.decision, analysis.reversalRisk]);

  useEffect(() => {
    const updates = [];

    for (const contract of openContracts) {
      const id = contractIdOf(contract);
      if (!id || !settled(contract) || processedContractsRef.current.has(id)) continue;
      if (!activeTrades.some((item) => item.contractId === id)) continue;

      processedContractsRef.current.add(id);
      const profit = contractProfit(contract);
      const result = profit >= 0 ? "WON" : "LOST";
      const original = activeTrades.find((item) => item.contractId === id);
      updates.push({ ...original, result, profit, settledAt: Date.now() });
    }

    if (!updates.length) return;

    setActiveTrades((current) =>
      current.filter((item) => !updates.some((done) => done.contractId === item.contractId))
    );

    setStats((current) => {
      const wins = updates.filter((item) => item.result === "WON").length;
      const losses = updates.length - wins;
      const profit = updates.reduce((sum, item) => sum + Number(item.profit || 0), 0);
      return {
        runs: current.runs,
        wins: current.wins + wins,
        losses: current.losses + losses,
        profit: current.profit + profit,
        history: [...updates.reverse(), ...current.history].slice(0, 40),
      };
    });
  }, [openContracts, activeTrades]);

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
    if (analysis.ready) {
      scanStartedAtRef.current = Date.now();
      return;
    }

    const timer = window.setInterval(() => {
      const elapsed = (Date.now() - scanStartedAtRef.current) / 1000;
      if (elapsed < Number(settings.marketSwitchSeconds || 12)) return;

      const index = Math.max(0, markets.findIndex((item) => item.id === symbol));
      const next = markets[(index + 1) % markets.length];
      if (next?.id && next.id !== symbol) {
        setMessage(`Market unclear. Switching to ${next.label}...`);
        scanStartedAtRef.current = Date.now();
        void changeSymbol(next.id);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [running, loadingMarket, activeTrades.length, markets, symbol, analysis.ready, settings.marketSwitchSeconds, changeSymbol]);

  useEffect(() => {
    if (!running || !analysis.ready || buyingRef.current || tradeBusy) return;
    if (!authenticatedFeed) {
      setMessage("Choose a Deriv Demo or Real account and reconnect first.");
      return;
    }
    if (activeTrades.length >= Number(settings.maxOpenTrades || 2)) return;

    const gapMs = Number(settings.minimumTradeGapSeconds || 3) * 1000;
    if (Date.now() - lastTradeAtRef.current < gapMs) return;

    let cancelled = false;
    buyingRef.current = true;

    void (async () => {
      try {
        const direction = analysis.decision;
        setMessage(
          `${direction} sharp entry found at ${analysis.confidence.toFixed(1)}%. Buying ${analysis.duration}s...`
        );

        const response = await placeTrade({
          contractType: direction === "RISE" ? "CALL" : "PUT",
          amount: Math.max(0.35, Number(settings.stake || 0.35)),
          basis: "stake",
          duration: analysis.duration,
          durationUnit: "s",
          symbol,
        });

        if (cancelled) return;
        const contractId = String(response?.contractId || response?.buy?.contract_id || "");
        if (!contractId) throw new Error("Deriv did not return a contract ID.");

        const trade = {
          contractId,
          market: market?.label || symbol,
          symbol,
          direction,
          confidence: analysis.confidence,
          duration: analysis.duration,
          stake: Number(settings.stake || 0.35),
          entryPrice: currentPrice,
          openedAt: Date.now(),
        };

        lastTradeAtRef.current = Date.now();
        setActiveTrades((current) => [trade, ...current]);
        setStats((current) => ({ ...current, runs: current.runs + 1 }));
        setMessage(`Trade ${contractId} opened. Quantum AI continues scanning for slot 2.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to open trade.");
      } finally {
        buyingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [running, analysis, authenticatedFeed, activeTrades.length, settings, tradeBusy, placeTrade, symbol, market?.label, currentPrice]);

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
    setRunning(true);
    setMessage("Quantum AI is scanning all conditions. It will trade only confirmed entries.");
  }

  function stopBot() {
    setRunning(false);
    setMessage("Bot stopped. Open contracts will continue settling on Deriv.");
  }

  function resetSession() {
    if (running || activeTrades.length) return;
    setStats(INITIAL_STATS);
    processedContractsRef.current.clear();
    setMessage("Session reset. Quantum AI is ready.");
  }

  const rankedMarkets = Object.values(marketScores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return (
    <div className="appShell quantumShell">
      <Sidebar />
      <main className="mainContent quantumPage">
        <Topbar
          title="MetaBinary Quantum AI"
          subtitle="Adaptive Rise/Fall scanner · smart seconds · two-run execution"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className={`quantumHero ${running ? "running" : "idle"}`}>
          <div>
            <small>METABINARY SYNTHETIC INTELLIGENCE</small>
            <h1>MetaBinary Quantum AI</h1>
            <p>Rise/Fall sharp-entry scanner with smart seconds, market switching and two live trade slots.</p>
          </div>
          <div className="quantumHeroStatus">
            <span>{running ? "● LIVE" : "○ IDLE"}</span>
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

        <section className={`quantumDecision ${analysis.ready ? "ready" : "wait"}`}>
          <div>
            <small>AI DECISION</small>
            <h2>{analysis.decision}</h2>
            <p>{analysis.reason}</p>
          </div>
          <div className="quantumDecisionStats">
            <article><span>Confidence</span><strong>{analysis.confidence.toFixed(1)}%</strong></article>
            <article><span>Candidate</span><strong>{analysis.candidate || "—"}</strong></article>
            <article><span>Smart duration</span><strong>{analysis.duration}s</strong></article>
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
          <article><span>Price</span><strong>{currentPrice ?? "—"}</strong></article>
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
              ["RSI 14", analysis.metrics?.rsi?.toFixed?.(1) ?? "—"],
              ["EMA 6", analysis.metrics?.fastEma?.toFixed?.(5) ?? "—"],
              ["EMA 14", analysis.metrics?.mediumEma?.toFixed?.(5) ?? "—"],
              ["EMA 30", analysis.metrics?.slowEma?.toFixed?.(5) ?? "—"],
              ["Fast slope", analysis.metrics?.fastSlope?.toFixed?.(6) ?? "—"],
              ["Medium slope", analysis.metrics?.mediumSlope?.toFixed?.(6) ?? "—"],
              ["Slow slope", analysis.metrics?.slowSlope?.toFixed?.(6) ?? "—"],
              ["Impulse", `${Number(analysis.metrics?.impulse || 0).toFixed(0)}%`],
              ["Trend strength", `${Number(analysis.metrics?.trendStrength || 0).toFixed(0)}%`],
              ["Vote consensus", `${Number(analysis.metrics?.voteConsensus || 0).toFixed(0)}%`],
              ["RISE votes", Number(analysis.votes?.rise || 0).toFixed(2)],
              ["FALL votes", Number(analysis.votes?.fall || 0).toFixed(2)],
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
                  <div><span>Duration</span><strong>{trade.duration}s</strong></div>
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
              <article key={`${trade.contractId}-${trade.settledAt}`}>
                <span>{trade.market}</span><strong>{trade.direction}</strong><span>{trade.duration}s</span>
                <b className={trade.result === "WON" ? "positive" : "negative"}>{trade.result}</b>
                <strong>{money(trade.profit)} USD</strong>
              </article>
            ))}
          </div>
        </section>

        <p className="quantumRiskNote">Trading carries risk. Quantum AI filters entries but cannot guarantee wins. Test on Demo before enabling Real execution.</p>
      </main>
    </div>
  );
}
