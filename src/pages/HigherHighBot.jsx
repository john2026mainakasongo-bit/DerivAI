import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeHigherHigh } from "../analysis/higherHighEngine";
import "../styles/HigherHighBot.css";

const INITIAL_STATS = { runs: 0, wins: 0, losses: 0, profit: 0, history: [] };

function contractIdOf(value) {
  return String(value?.contractId || value?.contract_id || value?.buy?.contract_id || value?.raw?.buy?.contract_id || value?.raw?.data?.buy?.contract_id || value?.id || "");
}

function settled(contract) {
  const status = String(contract?.status || contract?.contract_status || contract?.action || "").toLowerCase();
  return Boolean(contract?.is_sold || contract?.is_expired || ["won", "lost", "sold", "expired", "settled"].includes(status));
}

function profitOf(contract) {
  const direct = Number(contract?.profit ?? contract?.profit_loss ?? contract?.pnl);
  if (Number.isFinite(direct)) return direct;
  return Number(contract?.sell_price ?? contract?.payout ?? 0) - Number(contract?.buy_price ?? contract?.purchase_price ?? 0);
}

function number(value, digits = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}

export default function HigherHighBot() {
  const {
    markets, market, symbol, status, statusDetail, connected, authenticatedFeed,
    loadingMarket, prices, currentPrice, openContracts, transactions, tradeBusy,
    tradeError, selectedAccountType, connect, disconnect, changeSymbol, placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("Higher High AI PRO V2 is ready.");
  const [settings, setSettings] = useState({
    stake: 0.35,
    minimumConfidence: 80,
    minimumEfficiency: 0.18,
    maximumEntropy: 0.99,
    minimumTicks: 140,
    duration: 5,
    durationUnit: "t",
    cooldownSeconds: 15,
    marketSwitchSeconds: 45,
    takeProfit: 3,
    stopLoss: 1.5,
    maxConsecutiveLosses: 2,
  });
  const [activeTrades, setActiveTrades] = useState([]);
  const [stats, setStats] = useState(INITIAL_STATS);

  const buyingRef = useRef(false);
  const lastTradeAtRef = useRef(0);
  const scanStartedAtRef = useRef(Date.now());
  const processedRef = useRef(new Set());

  const connecting = status === "CONNECTING" || loadingMarket;

  const analysis = useMemo(() => analyzeHigherHigh(prices, settings), [prices, settings]);
  const consecutiveLosses = useMemo(() => {
    let losses = 0;
    for (const item of stats.history) {
      if (item.result !== "LOST") break;
      losses += 1;
    }
    return losses;
  }, [stats.history]);

  useEffect(() => {
    const all = [...(openContracts || []), ...(transactions || [])];
    const updates = [];
    for (const contract of all) {
      const id = contractIdOf(contract);
      if (!id || !settled(contract) || processedRef.current.has(id)) continue;
      const original = activeTrades.find((trade) => String(trade.contractId) === id);
      if (!original) continue;
      processedRef.current.add(id);
      const profit = profitOf(contract);
      updates.push({ ...original, profit, result: profit > 0 ? "WON" : "LOST", settledAt: Date.now() });
    }
    if (!updates.length) return;
    setActiveTrades((current) => current.filter((trade) => !updates.some((done) => String(done.contractId) === String(trade.contractId))));
    setStats((current) => ({
      runs: current.runs,
      wins: current.wins + updates.filter((item) => item.result === "WON").length,
      losses: current.losses + updates.filter((item) => item.result === "LOST").length,
      profit: current.profit + updates.reduce((sum, item) => sum + Number(item.profit || 0), 0),
      history: [...updates.reverse(), ...current.history].slice(0, 50),
    }));
  }, [openContracts, transactions, activeTrades]);

  useEffect(() => {
    if (!activeTrades.length) return;
    const refresh = () => activeTrades.forEach((trade) => Promise.resolve(refreshContract(trade.contractId)).catch(() => {}));
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [activeTrades, refreshContract]);

  useEffect(() => {
    if (!running) return;
    if (stats.profit >= Number(settings.takeProfit)) {
      setRunning(false);
      setMessage("Take Profit reached. Higher High AI stopped safely.");
    } else if (stats.profit <= -Math.abs(Number(settings.stopLoss))) {
      setRunning(false);
      setMessage("Stop Loss reached. Higher High AI stopped safely.");
    } else if (consecutiveLosses >= Number(settings.maxConsecutiveLosses)) {
      setRunning(false);
      setMessage("Maximum consecutive losses reached. Session stopped.");
    }
  }, [running, stats.profit, consecutiveLosses, settings]);

  useEffect(() => {
    if (!running || analysis.ready || activeTrades.length || markets.length < 2) {
      if (analysis.ready) scanStartedAtRef.current = Date.now();
      return;
    }
    const timer = window.setInterval(() => {
      if (Number(analysis.metrics?.ticksCollected || 0) < Number(settings.minimumTicks || 140)) return;
      if ((Date.now() - scanStartedAtRef.current) / 1000 < Number(settings.marketSwitchSeconds)) return;
      const currentIndex = Math.max(0, markets.findIndex((item) => item.id === symbol));
      const next = markets[(currentIndex + 1) % markets.length];
      if (next?.id && next.id !== symbol) {
        scanStartedAtRef.current = Date.now();
        setMessage(`Adaptive scan found no qualified setup. Switching to ${next.label}...`);
        void changeSymbol(next.id);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, analysis.ready, activeTrades.length, markets, symbol, settings.marketSwitchSeconds, changeSymbol]);

  useEffect(() => {
    if (!running || !analysis.ready || activeTrades.length || buyingRef.current || tradeBusy) return;
    if (!authenticatedFeed) {
      setMessage("Log in, select Demo/Real, then reconnect the authenticated Deriv feed.");
      return;
    }
    const cooldown = Number(settings.cooldownSeconds) * 1000;
    if (Date.now() - lastTradeAtRef.current < cooldown) return;

    buyingRef.current = true;
    void (async () => {
      try {
        setMessage(`Adaptive entry ${analysis.confidence}% / gate ${analysis.adaptiveThreshold}%. Buying HIGHER...`);
        const response = await placeTrade({
          contractType: "CALL",
          amount: Math.max(0.35, Number(settings.stake)),
          basis: "stake",
          duration: Number(settings.duration),
          durationUnit: settings.durationUnit,
          symbol,
        });
        const contractId = contractIdOf(response);
        if (!contractId) throw new Error("Deriv did not return a contract ID.");
        const trade = {
          contractId,
          symbol,
          market: market?.label || symbol,
          direction: "HIGHER",
          confidence: analysis.confidence,
          stake: Number(settings.stake),
          entryPrice: currentPrice,
          duration: Number(settings.duration),
          durationUnit: settings.durationUnit,
          openedAt: Date.now(),
        };
        lastTradeAtRef.current = Date.now();
        setActiveTrades([trade]);
        setStats((current) => ({ ...current, runs: current.runs + 1 }));
        setMessage(`Trade ${contractId} opened. Waiting for settlement.`);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to place Higher trade.");
      } finally {
        buyingRef.current = false;
      }
    })();
  }, [running, analysis, activeTrades.length, tradeBusy, authenticatedFeed, settings, placeTrade, symbol, market?.label, currentPrice]);

  async function startBot() {
    if (!connected) {
      try {
        setMessage("Connecting Higher High AI to Deriv...");
        await connect();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Connection failed.");
        return;
      }
    }
    scanStartedAtRef.current = Date.now();
    setRunning(true);
    setMessage("Adaptive V2 scanning micro, short and medium trend. No martingale.");
  }

  const winRate = stats.wins + stats.losses ? (stats.wins / (stats.wins + stats.losses)) * 100 : 0;
  const metrics = analysis.metrics || {};

  return (
    <div className="appShell hhShell">
      <Sidebar />
      <main className="mainContent hhPage">
        <Topbar
          title="Higher High AI PRO V2"
          subtitle="Adaptive HH/HL · multi-window trend · probability-gated CALL execution"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className={`hhHero ${running ? "running" : ""}`}>
          <div><small>ADAPTIVE STRUCTURE BOT</small><h1>Higher High AI PRO V2</h1><p>Faster qualified entries using HH/HL, breakout, 3-window trend, acceleration and transition probability.</p></div>
          <div className="hhHeroStatus"><span>{running ? "RUNNING" : "STOPPED"}</span><strong>{analysis.decision}</strong></div>
        </section>

        <section className="hhToolbar">
          <MarketSelector markets={markets} value={symbol} onChange={changeSymbol} disabled={loadingMarket || running || activeTrades.length > 0} />
          <div className="hhAccount"><span>ACCOUNT</span><strong>{selectedAccountType || "Not selected"}</strong></div>
          <button className="hhStart" onClick={startBot} disabled={running || connecting}>Start</button>
          <button className="hhStop" onClick={() => { setRunning(false); setMessage("Bot stopped. Open contract will settle normally."); }} disabled={!running}>Stop</button>
          <button className="hhReset" onClick={() => { if (!running && !activeTrades.length) { setStats(INITIAL_STATS); processedRef.current.clear(); setMessage("Session reset."); } }} disabled={running || activeTrades.length > 0}>Reset</button>
        </section>

        <section className={`hhDecision ${analysis.ready ? "ready" : analysis.decision === "WATCH" ? "watch" : ""}`}>
          <div><small>AI DECISION</small><h2>{analysis.decision}</h2><p>{analysis.reason}</p></div>
          <div className="hhDecisionGrid">
            <article><span>Confidence</span><strong>{analysis.confidence}%</strong></article>
            <article><span>Adaptive gate</span><strong>{analysis.adaptiveThreshold}%</strong></article>
            <article><span>Probability</span><strong>{analysis.probability}%</strong></article>
            <article><span>Regime</span><strong>{analysis.regime}</strong></article>
            <article><span>Structure</span><strong>{analysis.structure}</strong></article>
            <article><span>Price</span><strong>{number(currentPrice, market?.decimals ?? 3)}</strong></article>
          </div>
        </section>

        <section className="hhSettings">
          {[
            ["Stake", "stake", 0.01], ["Base confidence", "minimumConfidence", 1], ["Min efficiency", "minimumEfficiency", 0.01],
            ["Max entropy", "maximumEntropy", 0.01], ["Min ticks", "minimumTicks", 1], ["Duration", "duration", 1],
            ["Cooldown sec", "cooldownSeconds", 1], ["Switch sec", "marketSwitchSeconds", 1],
          ].map(([label, key, step]) => <label key={key}><span>{label}</span><input type="number" step={step} value={settings[key]} disabled={running} onChange={(event) => setSettings((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}
        </section>

        <section className="hhMetrics">
          <article><span>EMA 9</span><strong>{number(metrics.fastEma)}</strong></article>
          <article><span>EMA 21</span><strong>{number(metrics.mediumEma)}</strong></article>
          <article><span>EMA 50</span><strong>{number(metrics.slowEma)}</strong></article>
          <article><span>Momentum 5</span><strong>{number(metrics.momentum5, 5)}</strong></article>
          <article><span>Momentum 12</span><strong>{number(metrics.momentum12, 5)}</strong></article>
          <article><span>Acceleration</span><strong>{number(metrics.acceleration, 5)}</strong></article>
          <article><span>Efficiency 12</span><strong>{number(metrics.efficiency12, 2)}</strong></article>
          <article><span>Spike ratio</span><strong>{number(metrics.spikeRatio, 2)}</strong></article>
        </section>

        <section className="hhAdaptiveStrip">
          <article><span>Micro up</span><strong>{number(Number(metrics.microUpRatio || 0) * 100, 0)}%</strong></article>
          <article><span>Short up</span><strong>{number(Number(metrics.shortUpRatio || 0) * 100, 0)}%</strong></article>
          <article><span>Medium up</span><strong>{number(Number(metrics.mediumUpRatio || 0) * 100, 0)}%</strong></article>
          <article><span>TF agreement</span><strong>{metrics.timeframeAgreement || 0}/3</strong></article>
          <article><span>Transition up</span><strong>{number(Number(metrics.transitionProbability || 0) * 100, 0)}%</strong></article>
          <article><span>Entropy 18</span><strong>{number(metrics.entropy18, 2)}</strong></article>
          <article><span>Efficiency 28</span><strong>{number(metrics.efficiency28, 2)}</strong></article>
          <article><span>Ticks</span><strong>{metrics.ticksCollected || 0}</strong></article>
        </section>

        <section className="hhChecks">
          {(analysis.checks || []).map((check) => <article key={check.label} className={check.passed ? "passed" : "failed"}><span>{check.label}</span><strong>{check.passed ? "PASS" : "WAIT"}</strong><b>{check.weight} pts</b></article>)}
        </section>

        <section className="hhMessage"><strong>{message}</strong>{statusDetail || tradeError ? <span>{statusDetail || tradeError}</span> : null}</section>

        <section className="hhBottom">
          <div className="hhPanel"><header><div><small>PERFORMANCE</small><h3>Session statistics</h3></div></header><div className="hhPerformance">
            <article><span>Runs</span><strong>{stats.runs}</strong></article><article><span>Wins</span><strong className="positive">{stats.wins}</strong></article>
            <article><span>Losses</span><strong className="negative">{stats.losses}</strong></article><article><span>Win rate</span><strong>{winRate.toFixed(1)}%</strong></article>
            <article><span>P/L</span><strong className={stats.profit >= 0 ? "positive" : "negative"}>{stats.profit.toFixed(2)}</strong></article><article><span>Open</span><strong>{activeTrades.length}</strong></article>
          </div></div>
          <div className="hhPanel"><header><div><small>RECENT RESULTS</small><h3>Trade journal</h3></div></header><div className="hhHistory">
            {stats.history.length ? stats.history.slice(0, 8).map((item) => <article key={`${item.contractId}-${item.settledAt}`}><strong>{item.market}</strong><span>{item.result}</span><b className={item.profit >= 0 ? "positive" : "negative"}>{Number(item.profit).toFixed(2)}</b></article>) : <p>No settled Higher trades yet.</p>}
          </div></div>
        </section>
        <p className="hhRisk">Demo test first. V2 seeks faster qualified entries, but no model can guarantee a fixed win rate.</p>
      </main>
    </div>
  );
}
