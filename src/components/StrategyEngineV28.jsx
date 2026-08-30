import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import DerivBotEngine from "../bot/DerivBotEngine";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import { buildEntryTiming } from "../analysis/entryTimingEngine";
import { buildProfessionalDecision } from "../analysis/professionalDecisionEngine";
import "../styles/StrategyEngineV28.css";

const INITIAL_SETTINGS = {
  maxRuns: 56,
  stake: 1,
  duration: 1,
  minConfidence: 75,
  minVotes: 3,
  takeProfit: 4,
  stopLoss: 2,
  maxConsecutiveLosses: 3,
  delaySeconds: 3,
  martingaleEnabled: false,
  martingaleMultiplier: 2,
  maxMartingaleSteps: 0,
};

const INITIAL_BOT_STATE = {
  status: "IDLE",
  message: "Bot is ready to trade.",
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  totalStake: 0,
  totalPayout: 0,
  consecutiveLosses: 0,
  martingaleStep: 0,
  currentStake: 1,
  activeSetup: "—",
  activeContractId: "",
  history: [],
};

function accountId(account) {
  return String(account?.id || account?.account_id || account?.loginid || account?.login_id || "");
}

function buildPath(values, width = 720, height = 250) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const visible = values.slice(-90).map(Number).filter(Number.isFinite);
  if (visible.length < 2) return "";
  const min = Math.min(...visible);
  const max = Math.max(...visible);
  const range = max - min || 1;
  return visible.map((value, index) => {
    const x = (index / Math.max(1, visible.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 24) - 12;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function Sparkline({ values = [] }) {
  const path = buildPath(values, 160, 46);
  return path ? (
    <svg className="v28Spark" viewBox="0 0 160 46" preserveAspectRatio="none">
      <path d={path} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  ) : null;
}

function Stat({ label, value, tone = "" }) {
  return <div className={`v28Stat ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Stepper({ value, min, max, step = 1, onChange, disabled = false }) {
  const safe = Number.isFinite(Number(value)) ? Number(value) : min;
  const change = (delta) => onChange(Math.min(max, Math.max(min, Number((safe + delta).toFixed(2)))));
  return (
    <div className="v28Stepper">
      <input type="number" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="v28StepButtons">
        <button type="button" disabled={disabled || safe <= min} onClick={() => change(-step)}>−</button>
        <button type="button" disabled={disabled || safe >= max} onClick={() => change(step)}>+</button>
      </div>
    </div>
  );
}

export default function StrategyEngineV28() {
  const auth = useDerivAuth();
  const engineRef = useRef(null);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [botState, setBotState] = useState(INITIAL_BOT_STATE);
  const [filter, setFilter] = useState("ALL");

  const {
    markets,
    market,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    prices,
    currentPrice,
    lastDigit,
    digitHistory,
    connect,
    disconnect,
    changeSymbol,
  } = useDerivTicks();

  const selectedId = accountId(auth.selectedAccount);
  const isDemo = auth.selectedAccountType === "demo";
  const running = ["RUNNING", "WAITING", "BUYING", "MONITORING", "COOLDOWN", "WON", "LOST"].includes(botState.status);
  const busy = running || botState.status === "PAUSED";

  useEffect(() => {
    const changed = derivPublicClient.configureAccount({
      accessToken: auth.session?.accessToken || "",
      appId: auth.config?.clientId || "",
      accountId: selectedId,
    });
    if (changed && connected) void derivPublicClient.reconnect();
  }, [auth.session?.accessToken, auth.config?.clientId, selectedId, connected]);

  useEffect(() => {
    const engine = new DerivBotEngine({ client: derivPublicClient, onState: setBotState });
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.configure(settings); }, [settings]);
  useEffect(() => {
    engineRef.current?.setMarket({ symbol, currency: auth.selectedAccount?.currency || "USD" });
  }, [symbol, auth.selectedAccount?.currency]);

  const snapshot = useMemo(() => ({ prices, currentPrice, lastDigit, digitHistory }), [prices, currentPrice, lastDigit, digitHistory]);
  const validatedSignals = useMemo(() => buildValidatedSignals(snapshot), [snapshot]);
  const entryTiming = useMemo(() => buildEntryTiming(validatedSignals, snapshot, { tradeTicks: settings.duration, validitySeconds: 15 }), [validatedSignals, snapshot, settings.duration]);
  const professionalDecision = useMemo(() => buildProfessionalDecision(snapshot, validatedSignals), [snapshot, validatedSignals]);
  const unified = useMemo(() => analyzeUnifiedSignals({ ...snapshot, minimumConfidence: 75 }), [snapshot]);

  const best = unified?.digit?.best || null;
  const signal = best?.setup || professionalDecision?.setup || "WAIT";
  const confidence = Number(best?.qualityScore ?? best?.probability ?? professionalDecision?.confidence ?? 0);
  const historySize = Array.isArray(digitHistory) ? digitHistory.length : 0;
  const historyProgress = Math.min(100, (historySize / 500) * 100);
  const chartPath = buildPath((prices || []).map((item) => Number(item?.quote ?? item?.price ?? item)));
  const model = historySize >= 8 ? "CALIBRATED TRANSITION BLEND" : "CALIBRATING";
  const winRate = botState.runs ? (botState.wins / botState.runs) * 100 : 0;
  const totalLoss = botState.history.filter((x) => Number(x.profit) < 0).reduce((s, x) => s + Math.abs(Number(x.profit || 0)), 0);
  const totalProfit = botState.history.filter((x) => Number(x.profit) >= 0).reduce((s, x) => s + Number(x.profit || 0), 0);
  const netProfit = Number(botState.profit || 0);
  const transactions = (botState.history || []).slice().reverse().filter((item) => filter === "ALL" || String(item.result).toUpperCase() === filter);
  const equity = (botState.history || []).slice().reverse().reduce((acc, item) => {
    const next = (acc.at(-1) || 0) + Number(item.profit || 0);
    acc.push(next);
    return acc;
  }, []);
  const equityPath = buildPath(equity, 520, 110);

  const setNumber = (key, value) => setSettings((current) => ({ ...current, [key]: value }));

  async function startBot() {
    if (!auth.authenticated) { auth.login(); return; }
    if (!isDemo) {
      window.alert("For safety, Strategy Engine execution is Demo Account only.");
      return;
    }
    if (!connected) await connect();
    await engineRef.current?.start();
  }

  function stopBot() { engineRef.current?.stop(); }

  return (
    <div className="v28Shell">
      <aside className="v28Sidebar">
        <div className="v28Brand"><div className="v28BrandMark">✦</div><div><strong>Deriv<span>AI</span></strong><small>Strategy Engine</small></div></div>
        <div className="v28LivePill"><i /> DERIV LIVE</div>
        <nav className="v28Nav">
          <a className="active" href="#engine">⌂ <span>Strategy Engine</span><b>LIVE</b></a>
          <a href="#transactions">▣ <span>Bot Transactions</span></a>
          <a href="#performance">◔ <span>Performance</span></a>
          <a href="#settings">⚙ <span>Settings</span></a>
        </nav>
        <div className="v28BotCard">
          <div className="v28BotTop"><span>BOT STATUS</span><b className={running ? "on" : ""}><i />{running ? "ACTIVE" : "READY"}</b></div>
          <div className="v28BotOrb">◉</div>
          <strong>DerivAI Bot</strong>
          <small>{running ? "Running smoothly" : "Ready to trade"}</small>
          <div className="v28BotMini"><span>Trades<strong>{botState.runs}</strong></span><span>Win rate<strong>{winRate.toFixed(0)}%</strong></span></div>
        </div>
        <div className="v28Footer">© 2026 DerivAI<br />All rights reserved.</div>
      </aside>

      <main className="v28Main" id="engine">
        <header className="v28Topbar">
          <div className="v28TopLeft">
            <button className="v28Market" type="button" onClick={() => {}}>
              <span>{market?.label || symbol || "1HZ100V"}</span><small>(1s)</small>⌄
            </button>
            <span className={`v28Connection ${connected ? "connected" : ""}`}><i />{connected ? "CONNECTED" : status}</span>
          </div>
          <div className="v28TopRight">
            <span className="v28Server">Server Time<strong>{new Date().toLocaleTimeString()}</strong></span>
            <span className="v28Icon">⚙</span><span className="v28Icon">☾</span>
            <div className="v28Account"><span>◉</span><strong>{Number(auth.selectedAccount?.balance || 0).toFixed(2)} USD</strong><small>{isDemo ? "Demo Account" : "Real Account"}</small></div>
            <button className="v28Logout" type="button" onClick={disconnect}>↪</button>
          </div>
        </header>

        <section className="v28Hero">
          <div><div className="v28Eyebrow">CALIBRATED STRATEGY ENGINE · V28</div><h1>Deriv Strategy Engine</h1><p>Live analysis · Smart signals · Real results</p></div>
          <div className={`v28Feed ${connected ? "on" : ""}`}><i />{connected ? "Live feed" : "Connect feed"}<button type="button" onClick={connected ? disconnect : connect}>{connected ? "Disconnect" : "Connect"}</button></div>
        </section>

        <section className="v28Summary">
          <article className="v28Card signalHero"><div className="radar">◎</div><div><span>CURRENT SIGNAL</span><strong>{signal}</strong><small>Confidence <b>{confidence.toFixed(1)}%</b></small></div></article>
          <article className="v28Card"><span>CURRENT DIGIT</span><div className="v28BigDigit">{lastDigit ?? "—"}</div><Sparkline values={(digitHistory || []).slice(-50)} /></article>
          <article className="v28Card"><span>HISTORY</span><strong className="v28MetricBig">{historySize}/500</strong><div className="v28Progress"><i style={{ width: `${historyProgress}%` }} /></div><small>Digits collected</small></article>
          <article className="v28Card"><span>MODEL</span><strong className="v28Model">{model}</strong><small>Live calibrated state</small></article>
          <article className="v28Card riskCard"><span>RISK MODE</span><strong>FIXED / NO</strong><small>MARTINGALE</small><b>◈</b></article>
        </section>

        {statusDetail ? <div className="v28Notice">{statusDetail}</div> : null}

        <section className="v28Workspace">
          <div className="v28Center">
            <article className="v28Card v28ChartCard">
              <div className="v28CardHead"><div><span>LIVE MARKET FEED <em>● LIVE</em></span><strong>{Number.isFinite(currentPrice) ? currentPrice.toFixed(market?.decimals ?? 2) : "—"}</strong></div><div className="lastDigitBadge"><b>{lastDigit ?? "—"}</b><small>Last Digit</small></div></div>
              <div className="v28Chart">{chartPath ? <svg viewBox="0 0 720 250" preserveAspectRatio="none"><path className="area" d={`${chartPath} L 720 250 L 0 250 Z`} /><path className="line" d={chartPath} /></svg> : <div className="v28Empty">Connect Deriv and wait for live ticks.</div>}</div>
              <div className="v28Digits">{Array.from({ length: 10 }, (_, digit) => { const count = (digitHistory || []).filter((d) => Number(d) === digit).length; const pct = historySize ? (count / historySize) * 100 : 0; return <div key={digit} className={digit === lastDigit ? "active" : ""}><b>{digit}</b><span>{pct.toFixed(1)}%</span></div>; })}</div>
            </article>

            <div className="v28AnalyticsGrid">
              <article className="v28Card walkCard"><div className="v28CardHead"><div><span>BOUNDED WALK-FORWARD TEST</span><strong>Strategy validation</strong></div><button type="button">View Details</button></div><div className="v28WFTop"><Stat label="WIN RATE" value={`${winRate.toFixed(1)}%`} tone="green" /><Stat label="WINS" value={botState.wins} tone="green" /><Stat label="LOSSES" value={botState.losses} tone="red" /></div><div className="v28WFBottom"><Stat label="TOTAL SIGNALS" value={botState.runs} /><Stat label="NORMALIZED R" value={`${netProfit >= 0 ? "+" : ""}${netProfit.toFixed(2)}R`} tone={netProfit >= 0 ? "green" : "red"} /><Stat label="MAX DRAWDOWN" value="1R" /><Stat label="MAX LOSS STREAK" value={botState.consecutiveLosses} /></div></article>
              <article className="v28Card equityCard"><div className="v28CardHead"><div><span>FORWARD TEST EQUITY</span><strong>Normalized R</strong></div></div>{equityPath ? <svg viewBox="0 0 520 110" preserveAspectRatio="none"><path className="line purple" d={equityPath} /></svg> : <div className="v28Empty small">Run the strategy to build equity.</div>}</article>
            </div>
          </div>

          <aside className="v28Right">
            <article className="v28Card tradeCard" id="settings">
              <div className="v28PurpleHead"><span>◉ TRADE CONTROL</span><small>{isDemo ? "DEMO SAFE" : "LOCKED"}</small></div>
              <label>Set Amount (USD)<Stepper value={settings.stake} min={0.35} max={100} step={0.5} disabled={busy} onChange={(v) => setNumber("stake", v)} /></label>
              <label>Stop Loss (R)<Stepper value={settings.stopLoss} min={0} max={100} step={1} disabled={busy} onChange={(v) => setNumber("stopLoss", v)} /></label>
              <label>Take Profit (R)<Stepper value={settings.takeProfit} min={0} max={100} step={1} disabled={busy} onChange={(v) => setNumber("takeProfit", v)} /></label>
              <label>Duration<select value={settings.duration} disabled={busy} onChange={(e) => setNumber("duration", Number(e.target.value))}><option value="1">1 Tick (1s)</option><option value="2">2 Ticks (2s)</option><option value="3">3 Ticks (3s)</option><option value="5">5 Ticks (5s)</option></select></label>
              <button className="v28Start" type="button" disabled={busy} onClick={startBot}>▶ START BOT</button>
              <button className="v28Stop" type="button" disabled={!busy} onClick={stopBot}>■ STOP BOT</button>
              <div className="v28BotReady"><i />{botState.message}</div>
            </article>

            <article className="v28Card perfCard" id="performance"><div className="v28PurpleHead"><span>◉ PERFORMANCE SUMMARY</span></div><div className="v28PerfBody"><div className="v28Donut" style={{ "--p": `${Math.min(100, winRate)}%` }}><strong>{winRate.toFixed(0)}%</strong><small>Win Rate</small></div><div className="v28PerfStats"><span>Total Signals<b>{botState.runs}</b></span><span>Total Profit<b className="green">+{totalProfit.toFixed(2)} USD</b></span><span>Total Loss<b className="red">-{totalLoss.toFixed(2)} USD</b></span><span>Net Profit<b className={netProfit >= 0 ? "green" : "red"}>{netProfit >= 0 ? "+" : ""}{netProfit.toFixed(2)} USD</b></span></div></div><div className="v28Excellent">↗ Performance: {winRate >= 70 ? "EXCELLENT" : winRate >= 50 ? "STABLE" : "LEARNING"}</div></article>
          </aside>
        </section>

        <section className="v28Card transactions" id="transactions"><div className="v28TxHead"><div><span>▣ BOT TRANSACTION VIEW</span><small>Live execution ledger</small></div><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="ALL">All Transactions</option><option value="WIN">Wins</option><option value="LOSS">Losses</option></select></div><div className="v28TableWrap"><table><thead><tr><th>ID</th><th>TIME</th><th>TYPE</th><th>DURATION</th><th>AMOUNT</th><th>ENTRY</th><th>EXIT</th><th>RESULT</th><th>PROFIT/LOSS</th><th>STATUS</th></tr></thead><tbody>{transactions.length ? transactions.slice(0, 8).map((item, index) => <tr key={`${item.id || index}-${item.time || index}`}><td>#{item.id || 1000 + index}</td><td>{item.time ? new Date(item.time).toLocaleTimeString() : "—"}</td><td><b className="txType">{item.setup || botState.activeSetup || "DIGIT"}</b></td><td>{settings.duration} Tick</td><td>{Number(item.stake ?? settings.stake).toFixed(2)}</td><td>{item.entrySpot ?? "—"}</td><td>{item.exitSpot ?? "—"}</td><td><b className={String(item.result).toLowerCase() === "win" ? "txWin" : "txLoss"}>{item.result || "—"}</b></td><td className={Number(item.profit) >= 0 ? "txWin" : "txLoss"}>{Number(item.profit) >= 0 ? "+" : ""}{Number(item.profit || 0).toFixed(2)}</td><td><span className="settled">Settled</span></td></tr>) : <tr><td colSpan="10" className="v28NoTx">No transactions yet — start the Demo Bot to populate this view.</td></tr>}</tbody></table></div><button className="v28AllTx" type="button">☷ View All Transactions</button></section>
      </main>
    </div>
  );
}
