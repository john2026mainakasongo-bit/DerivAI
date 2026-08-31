import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import DerivBotEngine from "../bot/DerivBotEngine";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import { buildEntryTiming } from "../analysis/entryTimingEngine";
import { buildProfessionalDecision } from "../analysis/professionalDecisionEngine";
import "../styles/TradingCommandCenter.css";

const DEFAULT_SETTINGS = { stake: 1, duration: 1, takeProfit: 4, stopLoss: 2, minConfidence: 75 };
const DEFAULT_STATE = { status: "IDLE", message: "Ready to analyze live Deriv data.", runs: 0, wins: 0, losses: 0, profit: 0, consecutiveLosses: 0, activeSetup: "—", activeContractId: "", history: [] };

const idOf = (a) => String(a?.id || a?.account_id || a?.loginid || a?.login_id || "");

function linePath(values, width, height) {
  const nums = (values || []).map(Number).filter(Number.isFinite).slice(-100);
  if (nums.length < 2) return "";
  const min = Math.min(...nums), max = Math.max(...nums), range = max - min || 1;
  return nums.map((v, i) => {
    const x = (i / (nums.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 18) - 9;
    return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function MiniChart({ prices = [], signal = "WAIT" }) {
  const values = prices.map((x) => Number(x?.quote ?? x?.price ?? x)).filter(Number.isFinite);
  const path = linePath(values, 920, 300);
  const last = values.at(-1);
  return <div className="dccChart">
    <div className="dccChartGrid" />
    {path ? <svg viewBox="0 0 920 300" preserveAspectRatio="none"><path className="dccPriceLine" d={path} /></svg> : <div className="dccChartEmpty">Waiting for live Deriv ticks…</div>}
    <div className="dccSignalBadge"><b>{/CALL|RISE|OVER|EVEN|MATCH/i.test(signal) ? "↑" : "↓"}</b><span>{signal}</span></div>
    <div className="dccAxisValue">{Number.isFinite(last) ? last.toFixed(2) : "—"}</div>
  </div>;
}

function Stepper({ value, min, max, step = 1, onChange, disabled }) {
  const safe = Number.isFinite(Number(value)) ? Number(value) : min;
  const set = (n) => onChange(Math.min(max, Math.max(min, Number(n.toFixed(2)))));
  return <div className="dccStepper"><button disabled={disabled || safe <= min} onClick={() => set(safe - step)}>−</button><input type="number" value={safe} min={min} max={max} step={step} disabled={disabled} onChange={(e) => set(Number(e.target.value) || min)} /><button disabled={disabled || safe >= max} onClick={() => set(safe + step)}>+</button></div>;
}

export default function TradingCommandCenter() {
  const auth = useDerivAuth();
  const engineRef = useRef(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [botState, setBotState] = useState(DEFAULT_STATE);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);

  const { market, symbol, connected, loadingMarket, prices, currentPrice, lastDigit, digitHistory, connect, disconnect, changeSymbol } = useDerivTicks();
  const selectedAccount = auth.selectedAccount || {};
  const selectedId = idOf(selectedAccount);
  const loginId = idOf(selectedAccount);
  const kind = String(auth.selectedAccountType || selectedAccount.type || selectedAccount.account_type || "").toLowerCase();
  const isDemo = kind === "demo" || kind === "virtual" || kind === "vrt" || loginId.toUpperCase().startsWith("VRTC");
  const running = ["RUNNING", "WAITING", "BUYING", "MONITORING", "COOLDOWN", "WON", "LOST", "PAUSED"].includes(botState.status);
  const symbolName = symbol || "1HZ100V";
  const historySize = Array.isArray(digitHistory) ? digitHistory.length : 0;
  const snapshot = useMemo(() => ({ prices, currentPrice, lastDigit, digitHistory }), [prices, currentPrice, lastDigit, digitHistory]);
  const validated = useMemo(() => buildValidatedSignals(snapshot), [snapshot]);
  useMemo(() => buildEntryTiming(validated, snapshot, { tradeTicks: settings.duration, validitySeconds: 15 }), [validated, snapshot, settings.duration]);
  const professional = useMemo(() => buildProfessionalDecision(snapshot, validated), [snapshot, validated]);
  const unified = useMemo(() => analyzeUnifiedSignals({ ...snapshot, minimumConfidence: settings.minConfidence }), [snapshot, settings.minConfidence]);
  const best = unified?.digit?.best;
  const signal = best?.setup || professional?.setup || "WAIT";
  const confidence = Number(best?.qualityScore ?? best?.probability ?? professional?.confidence ?? 0);
  const winRate = botState.runs ? (botState.wins / botState.runs) * 100 : 0;
  const balance = Number(selectedAccount.balance ?? selectedAccount.available_balance ?? 0);
  const transactions = (botState.history || []).slice().reverse();
  const equity = transactions.reduce((a, x) => { a.push((a.at(-1) || 0) + Number(x.profit || 0)); return a; }, []);
  const equityPath = linePath(equity, 500, 100);
  const liveOpen = Array.isArray(auth.openContracts) ? auth.openContracts[0] : null;

  useEffect(() => {
    if (!symbol && changeSymbol) changeSymbol("1HZ100V");
  }, [symbol, changeSymbol]);
  useEffect(() => {
    if (connected || loadingMarket || !connect) return;
    Promise.resolve(connect()).catch((e) => setError(e?.message || "Unable to connect to Deriv market feed."));
  }, [connected, loadingMarket, connect]);
  useEffect(() => {
    let cancelled = false;
    const changed = derivPublicClient.configureAccount({ accessToken: auth.session?.accessToken || "", appId: auth.config?.clientId || "", accountId: selectedId });
    setReady(false);
    async function prepare() {
      if (!auth.authenticated || !selectedId || !isDemo) return;
      try { if (changed && connected) await derivPublicClient.reconnect(); await derivPublicClient.ensureTradingConnection(); if (!cancelled) setReady(true); } catch { if (!cancelled) setReady(false); }
    }
    void prepare();
    return () => { cancelled = true; };
  }, [auth.authenticated, auth.session?.accessToken, auth.config?.clientId, selectedId, isDemo, connected]);
  useEffect(() => { const e = new DerivBotEngine({ client: derivPublicClient, onState: setBotState }); engineRef.current = e; return () => e.destroy(); }, []);
  useEffect(() => { engineRef.current?.configure({ ...settings, maxRuns: 56, minVotes: 3, maxConsecutiveLosses: 3, delaySeconds: 3, martingaleEnabled: false, martingaleMultiplier: 2, maxMartingaleSteps: 0 }); }, [settings]);
  useEffect(() => { engineRef.current?.setMarket({ symbol: symbolName, currency: selectedAccount.currency || "USD" }); }, [symbolName, selectedAccount.currency]);

  async function startBot() {
    setError("");
    if (!auth.authenticated) { auth.login(); return; }
    if (!selectedId || !isDemo) { setError("Select a DEMO/VRTC Deriv account. Real-money execution is locked in this section."); return; }
    if (historySize < 8) { setError(`Waiting for live calibration: ${historySize}/8 ticks.`); return; }
    try { await derivPublicClient.ensureTradingConnection(); setReady(true); await engineRef.current?.start(); } catch (e) { setError(e?.message || "Bot could not start."); }
  }
  function stopBot() { engineRef.current?.stop(); setReady(false); setError(""); }
  async function refreshAccounts() {
    const fn = auth.refreshAccounts || auth.loadAccounts || auth.fetchAccounts || auth.refreshAccountList;
    if (!fn) return;
    setAccountBusy(true); try { await fn(); } catch (e) { setError(e?.message || "Unable to refresh accounts."); } finally { setAccountBusy(false); }
  }

  return <div className="dccShell">
    <aside className="dccSidebar">
      <div className="dccBrand"><div className="dccLogo">D</div><div><strong>Deriv<span>AI</span></strong><small>TRADING ENGINE</small></div></div>
      <div className="dccLive"><i /> DERIV LIVE · {symbolName}</div>
      <nav><Link to="/dashboard">⌂ <span>Dashboard</span></Link><a className="active" href="#command-center">⌁ <span>Command Center</span><b>LIVE</b></a><a href="#chart">◫ <span>Live Market</span></a><a href="#bot">◈ <span>Bot Control</span></a><a href="#trades">▣ <span>Open Trades</span></a><a href="#transactions">☷ <span>Transactions</span></a><a href="#performance">◔ <span>Performance</span></a><a href="#settings">⚙ <span>Settings</span></a></nav>
      <div className="dccBotCard"><div><span>ACTIVE BOT</span><b className={running ? "on" : ""}><i />{running ? "RUNNING" : "READY"}</b></div><div className="dccBotOrb">✦</div><strong>DerivAI Bot</strong><small>{running ? "Analyzing live market" : "Ready to analyze"}</small><div className="dccMini"><span>Signals<strong>{botState.runs}</strong></span><span>Win rate<strong>{winRate.toFixed(0)}%</strong></span></div></div>
      <div className="dccFooter">DERIVAI · COMMAND CENTER<br />Trading section · © 2026</div>
    </aside>

    <main className="dccMain" id="command-center">
      <header className="dccTopbar"><div><button className="dccBack" onClick={() => window.history.back()}>←</button><div><small>DERIVAI · TRADING SECTION</small><h1>Command Center</h1></div></div><div className="dccTopRight"><span>Server Time<strong>{new Date().toLocaleTimeString()}</strong></span><div className="dccAccount"><span>◉</span><strong>{auth.authenticated ? (isDemo ? "DEMO" : "REAL") : "NOT CONNECTED"}</strong><small>{loginId || "Connect Deriv account"}</small></div><button onClick={() => !auth.authenticated ? auth.login() : void refreshAccounts()} disabled={accountBusy}>↻</button><button onClick={() => auth.authenticated ? disconnect() : auth.login()}>{auth.authenticated ? "↪" : "Connect"}</button></div></header>

      <section className="dccHero"><div><span className="dccEyebrow">LIVE TRADING WORKSPACE</span><h2>DerivAI Command Center</h2><p>Separate trading workspace · live market · signal analysis · demo bot execution</p></div><div className={`dccFeed ${connected ? "on" : ""}`}><i />{connected ? "Deriv market feed is live" : "Deriv feed offline"}<button onClick={() => connected ? disconnect() : connect()}>{connected ? "Disconnect" : "Connect"}</button></div></section>

      {error && <div className="dccNotice">⚠ {error}</div>}

      <section className="dccStats"><article><span>TOTAL PROFIT</span><strong className={botState.profit >= 0 ? "positive" : "negative"}>{botState.profit >= 0 ? "+" : ""}{Number(botState.profit || 0).toFixed(2)} USD</strong><small>Current session</small></article><article><span>WIN RATE</span><strong>{winRate.toFixed(2)}%</strong><small>{botState.wins}W / {botState.losses}L</small></article><article><span>TOTAL TRADES</span><strong>{botState.runs}</strong><small>Today</small></article><article><span>ACCOUNT BALANCE</span><strong>{balance.toFixed(2)} {selectedAccount.currency || "USD"}</strong><small>{isDemo ? "DEMO / VRTC" : "REAL / LOCKED"}</small></article><article><span>LIVE PRICE</span><strong>{Number.isFinite(currentPrice) ? currentPrice.toFixed(market?.decimals ?? 2) : "—"}</strong><small>{symbolName}</small></article></section>

      <section className="dccWorkspace">
        <div className="dccCenter">
          <article className="dccPanel dccChartPanel" id="chart"><div className="dccPanelHead"><div><span>LIVE CHART</span><strong>{symbolName} · {Number.isFinite(currentPrice) ? currentPrice.toFixed(2) : "—"}</strong></div><div className="dccTools"><button className="selected">1m</button><button>5m</button><button>15m</button><button>1h</button><button>⌗</button><button>⚙</button></div></div><MiniChart prices={prices} signal={signal} /></article>
          <div className="dccLowerGrid"><article className="dccPanel" id="bot"><div className="dccPanelHead"><div><span>LIVE SIGNAL</span><strong>{signal}</strong></div><em className="dccGood">{confidence >= settings.minConfidence ? "STRONG SETUP" : "WAITING"}</em></div><div className="dccSignalBody"><div className="dccArrow">{/CALL|RISE|OVER|EVEN|MATCH/i.test(signal) ? "↑" : "↓"}</div><div><b>CONFIDENCE SCORE</b><strong>{confidence.toFixed(0)}<small>/100</small></strong><div className="dccProgress"><i style={{ width: `${Math.min(100, confidence)}%` }} /></div><p>Market: <b>{symbolName}</b><br />Timeframe: <b>1 Minute</b><br />Reason: <b>{professional?.reason || "Live Deriv market conditions"}</b></p></div></div></article>
          <article className="dccPanel" id="performance"><div className="dccPanelHead"><div><span>BOT STATUS</span><strong>DerivAI · {running ? "Running" : "Ready"}</strong></div><em className={ready ? "dccGood" : "dccMuted"}>{ready ? "EXECUTION READY" : "WAITING"}</em></div><div className="dccStatusGrid"><span>Signals<strong>{botState.runs}</strong></span><span>Wins<strong>{botState.wins}</strong></span><span>Losses<strong>{botState.losses}</strong></span><span>Last digit<strong>{lastDigit ?? "—"}</strong></span><span>Loss streak<strong>{botState.consecutiveLosses}</strong></span><span>History<strong>{historySize}/500</strong></span></div>{equityPath ? <svg className="dccEquity" viewBox="0 0 500 100" preserveAspectRatio="none"><path d={equityPath} /></svg> : <div className="dccEmpty">Trades will build the live equity curve.</div>}</article></div>
        </div>

        <aside className="dccRight"><article className="dccPanel dccControl" id="settings"><div className="dccPurpleHead"><span>BOT SETTINGS</span><small>{isDemo ? "DEMO SAFE" : "LOCKED"}</small></div><label>Market<select value={symbolName} onChange={(e) => changeSymbol(e.target.value)}><option value="1HZ100V">Volatility 100 (1s)</option><option value="R_100">Volatility 100</option><option value="R_75">Volatility 75</option><option value="R_50">Volatility 50</option><option value="R_25">Volatility 25</option><option value="R_10">Volatility 10</option></select></label><label>Stake (USD)<Stepper value={settings.stake} min={0.35} max={100} step={0.5} disabled={running} onChange={(v) => setSettings((s) => ({ ...s, stake: v }))} /></label><label>Stop Loss (R)<Stepper value={settings.stopLoss} min={0} max={100} disabled={running} onChange={(v) => setSettings((s) => ({ ...s, stopLoss: v }))} /></label><label>Take Profit (R)<Stepper value={settings.takeProfit} min={0} max={100} disabled={running} onChange={(v) => setSettings((s) => ({ ...s, takeProfit: v }))} /></label><label>Duration<select value={settings.duration} disabled={running} onChange={(e) => setSettings((s) => ({ ...s, duration: Number(e.target.value) }))}><option value="1">1 Tick</option><option value="2">2 Ticks</option><option value="3">3 Ticks</option><option value="5">5 Ticks</option></select></label><button className="dccStart" disabled={running || !connected || !isDemo || !auth.authenticated || historySize < 8} onClick={startBot}>▶ {running ? "BOT RUNNING" : "START DEMO BOT"}</button><button className="dccStop" disabled={!running} onClick={stopBot}>■ STOP BOT</button><small className="dccReady">{!auth.authenticated ? "Connect your Deriv account." : !isDemo ? "REAL account selected. Execution locked." : !connected ? "Connect the market feed." : historySize < 8 ? `Calibrating… ${historySize}/8 ticks.` : ready ? botState.message : "Preparing demo execution…"}</small></article>
          <article className="dccPanel dccOpen" id="trades"><div className="dccPurpleHead"><span>OPEN TRADE · LIVE</span><small>{liveOpen ? "ACTIVE" : "NONE"}</small></div>{liveOpen || botState.activeContractId ? <div className="dccTradeDetails"><span>Contract<strong>#{botState.activeContractId || liveOpen?.contract_id || "—"}</strong></span><span>Type<strong>{botState.activeSetup || liveOpen?.contract_type || "—"}</strong></span><span>Entry<strong>{liveOpen?.entry_spot ?? "—"}</strong></span><span>Current P/L<strong>{Number(liveOpen?.profit || 0).toFixed(2)} USD</strong></span></div> : <p>No open trade. A live contract will appear here after execution.</p>}</article>
        </aside>
      </section>

      <section className="dccPanel dccTransactions" id="transactions"><div className="dccPanelHead"><div><span>TRANSACTIONS</span><strong>Live bot ledger</strong></div><span>{transactions.length} records</span></div><div className="dccTableWrap"><table><thead><tr><th>TIME</th><th>TYPE</th><th>MARKET</th><th>STAKE</th><th>ENTRY</th><th>EXIT</th><th>RESULT</th><th>P/L</th></tr></thead><tbody>{transactions.length ? transactions.slice(0, 8).map((x, i) => { const p = Number(x.profit || 0); return <tr key={`${x.id || i}-${x.time || i}`}><td>{x.time ? new Date(Number(x.time) > 1e12 ? Number(x.time) : Number(x.time) * 1000).toLocaleTimeString() : "—"}</td><td>{x.setup || x.action || x.contract_type || "TRADE"}</td><td>{x.symbol || symbolName}</td><td>{Number(x.stake ?? settings.stake).toFixed(2)}</td><td>{x.entrySpot ?? x.entry_spot ?? "—"}</td><td>{x.exitSpot ?? x.exit_spot ?? "—"}</td><td className={p >= 0 ? "positive" : "negative"}>{x.result || x.status || "—"}</td><td className={p >= 0 ? "positive" : "negative"}>{p >= 0 ? "+" : ""}{p.toFixed(2)}</td></tr>; }) : <tr><td colSpan="8" className="dccEmpty">No transactions yet — start the Demo Bot after live calibration.</td></tr>}</tbody></table></div></section>
    </main>
  </div>;
}
