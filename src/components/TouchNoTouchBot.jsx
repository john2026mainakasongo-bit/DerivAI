import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import analyzeTouchNoTouch from "../analysis/touchNoTouchEngine";
import DerivTradingChart from "./DerivTradingChart";
import "../styles/TouchNoTouchBot.css";

const money = (v, currency = "USD") => `$${Number(v || 0).toFixed(2)} ${String(currency).toUpperCase()}`;
const idOf = (v) => String(v?.contract_id || v?.contractId || v?.id || v?.buy?.contract_id || "");
const settled = (v) => Boolean(v?.is_sold || v?.is_expired || v?.is_settled || ["won","lost","sold","expired","settled"].includes(String(v?.status || v?.contract_status || "").toLowerCase()));
const pnlOf = (v) => Number(v?.profit ?? v?.profit_loss ?? v?.pnl ?? 0);
const timeOf = (v) => { const t = Number(v?.date_start || v?.transaction_time || v?.date || v?.purchase_time || v?.epoch); return Number.isFinite(t) ? new Date(t * 1000).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"}) : "—"; };
const typeOf = (v) => { const t = String(v?.contract_type || v?.contractType || v?.type || "").toUpperCase(); return t === "ONETOUCH" ? "TOUCH" : t === "NOTOUCH" ? "NO TOUCH" : t || "—"; };

export function TouchNoTouchBotView({ feed }) {
  const auth = useDerivAuth();
  const { markets = [], market, symbol, connected, authenticatedFeed, status, ticks = [], prices = [], currentPrice, openContracts = [], transactions = [], changeSymbol, placeTrade, sellContract, selectedAccount, selectedAccountType, selectedAccountId, loadingMarket = false, tradeBusy } = feed;
  const touchContracts = openContracts.filter((contract) => {
    const type = String(contract?.contract_type || contract?.contractType || contract?.type || "").toUpperCase();
    return type === "ONETOUCH" || type === "NOTOUCH" || type === "TOUCH" || type === "NO TOUCH";
  });

  const currency = String(selectedAccount?.currency || "USD").toUpperCase();
  const [running, setRunning] = useState(false);
  const [stakeMode, setStakeMode] = useState("ADAPTIVE");
  const [fixedStake, setFixedStake] = useState(0.35);
  const [duration, setDuration] = useState(5);
  const [barrierMultiplier, setBarrierMultiplier] = useState(1.8);
  const [minScore, setMinScore] = useState(92);
  const [sessionTPPct, setSessionTPPct] = useState(2);
  const [sessionSLPct, setSessionSLPct] = useState(1.5);
  const [recoveryEnabled, setRecoveryEnabled] = useState(true);
  const [recoveryUsed, setRecoveryUsed] = useState(false);
  const [allowReal, setAllowReal] = useState(false);
  const [sessionPnl, setSessionPnl] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [trades, setTrades] = useState(0);
  const [message, setMessage] = useState("A+ Touch / No Touch scanner ready.");
  const [flash, setFlash] = useState(null);
  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const lastSignalRef = useRef("");
  const lastEntryRef = useRef(0);
  const sessionStartBalanceRef = useRef(Number(selectedAccount?.balance) || 0);
  const recoveryPendingRef = useRef(false);
  const audioRef = useRef(null);
  const exitRequestedRef = useRef(new Set());

  const analysisPrices = useMemo(() => {
    if (prices.length) return prices;
    return ticks.map((tick) => Number(tick?.quote)).filter(Number.isFinite);
  }, [prices, ticks]);
  const displayMarket = market?.id
    ? market
    : markets.find((item) => item.id === symbol) || { id: symbol, label: symbol || "Loading market", decimals: 3 };
  const analysis = useMemo(() => analyzeTouchNoTouch(analysisPrices, { minimumSamples: 120, maxSamples: 700 }), [analysisPrices]);
  const balance = Number(selectedAccount?.balance) || 0;
  const sessionTarget = sessionStartBalanceRef.current > 0 ? sessionStartBalanceRef.current * (sessionTPPct / 100) : 0;
  const sessionStop = sessionStartBalanceRef.current > 0 ? sessionStartBalanceRef.current * (sessionSLPct / 100) : 0;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : 0;
  const chartPrices = analysisPrices.slice(-180);

  useEffect(() => {
    if (selectedAccount?.balance != null && sessionStartBalanceRef.current <= 0) sessionStartBalanceRef.current = Number(selectedAccount.balance) || 0;
  }, [selectedAccount?.balance]);

  useEffect(() => {
    if (!connected || loadingMarket || symbol || !markets.length) return;
    const fallback = markets.find((item) => /Volatility 75/i.test(item.label || "") && !/1s|1 sec|one second/i.test(item.label || "")) || markets[0];
    if (fallback?.id) void changeSymbol(fallback.id).catch(() => {});
  }, [changeSymbol, connected, loadingMarket, markets, symbol]);

  const sound = useCallback((won) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioRef.current || new Ctx();
      audioRef.current = ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      [won ? 700 : 320, won ? 980 : 220].forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = won ? "sine" : "square";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, now + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.09, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.11);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + i * 0.12); osc.stop(now + i * 0.12 + 0.13);
      });
    } catch {}
  }, []);

  const resetSession = useCallback(() => {
    setSessionPnl(0); setWins(0); setLosses(0); setTrades(0); setRecoveryUsed(false); recoveryPendingRef.current = false; lastSignalRef.current = ""; processedRef.current.clear(); exitRequestedRef.current.clear(); setFlash(null); sessionStartBalanceRef.current = balance; setMessage("Session reset. Waiting for A+ setup.");
  }, [balance]);

  const execute = useCallback(async (mode = "AUTO", forcedAnalysis = analysis, forcedStake = null) => {
    if (busyRef.current || !selectedAccountId || !forcedAnalysis?.ready) return;
    if (String(selectedAccountType).toLowerCase() === "real" && !allowReal) { setMessage("REAL ACCOUNT LOCKED — enable Allow Real first."); return; }
    if (forcedAnalysis.signal === "WAIT" || forcedAnalysis.entryScore < minScore) return;
    if (Date.now() - lastEntryRef.current < 9000) return;
    if (trades >= 10) { setRunning(false); setMessage("MAX 10 TRADES — session protected."); return; }
    if (sessionStop > 0 && sessionPnl <= -sessionStop) { setRunning(false); setMessage(`SESSION STOP • ${money(sessionPnl, currency)}`); return; }
    if (sessionTarget > 0 && sessionPnl >= sessionTarget) { setRunning(false); setMessage(`SESSION TARGET • ${money(sessionPnl, currency)}`); return; }

    const base = stakeMode === "FIXED" ? Math.max(0.35, Number(fixedStake) || 0.35) : Math.max(0.35, Math.min(2.5, balance * 0.0025));
    const isRecovery = mode === "RECOVERY";
    const tradeStake = isRecovery ? base * 2 : base;
    const setup = forcedAnalysis.signal;
    const contractType = setup === "TOUCH" ? "ONETOUCH" : "NOTOUCH";
    const rawBarrier = setup === "TOUCH" ? forcedAnalysis.touchBarrier : forcedAnalysis.noTouchBarrier;
    const spot = Number(forcedAnalysis.current || currentPrice);
    const direction = rawBarrier >= spot ? 1 : -1;
    const offset = Math.max(Math.abs(rawBarrier - spot) * Math.max(0.5, Number(barrierMultiplier) || 1), Math.abs(spot) * 0.0001);
    const barrier = `${direction >= 0 ? "+" : "-"}${offset.toFixed(Math.max(2, displayMarket?.decimals ?? 3))}`;

    busyRef.current = true;
    setMessage(`${isRecovery ? "RECOVERY X2" : mode} • BUYING ${setup} • ${forcedAnalysis.entryScore}/99`);
    try {
      const result = await placeTrade({ symbol, contractType, amount: tradeStake, basis: "stake", duration: Number(duration), durationUnit: "t", barrier });
      const id = idOf(result);
      setTrades((v) => v + 1);
      lastEntryRef.current = Date.now();
      if (isRecovery) { setRecoveryUsed(true); recoveryPendingRef.current = false; }
      lastSignalRef.current = `${symbol}:${setup}:${forcedAnalysis.entryScore}`;
      setMessage(`${setup} OPEN • ${id ? `#${id}` : "contract active"} • ${money(tradeStake, currency)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade failed.");
    } finally { busyRef.current = false; }
  }, [allowReal, analysis, balance, barrierMultiplier, currency, currentPrice, duration, fixedStake, minScore, placeTrade, selectedAccountId, selectedAccountType, sessionPnl, sessionStop, sessionTarget, stakeMode, symbol, trades]);

  useEffect(() => {
    if (!running || !analysis.ready || analysis.signal === "WAIT" || analysis.entryScore < minScore) return;
    const key = `${symbol}:${analysis.signal}:${analysis.entryScore}`;
    if (key === lastSignalRef.current) return;
    void execute("AUTO", analysis);
  }, [analysis, execute, minScore, running, symbol]);

  useEffect(() => {
    for (const c of touchContracts) {
      if (settled(c)) continue;
      const id = idOf(c);
      if (!id || exitRequestedRef.current.has(id)) continue;
      const pnl = pnlOf(c);
      const stakeValue = Math.max(0.35, Number(c?.buy_price ?? c?.stake ?? c?.amount ?? 0.35));
      const take = stakeValue * 0.75;
      const stop = stakeValue * 0.75;
      if (!Number.isFinite(pnl) || (pnl < take && pnl > -stop)) continue;
      exitRequestedRef.current.add(id);
      setMessage(`${pnl >= 0 ? "TRADE TP" : "TRADE SL"} • #${id}`);
      setMessage(`${pnl >= 0 ? "TRADE TP" : "TRADE SL"} • #${id} • monitoring to settlement`);
      // Do not force early resale: fixed-duration contracts can reject it.
      // Session protection still prevents new entries once limits are hit.
    }
  }, [touchContracts]);

  useEffect(() => {
    for (const c of touchContracts) {
      if (!settled(c)) continue;
      const id = idOf(c);
      if (!id || processedRef.current.has(id)) continue;
      processedRef.current.add(id);
      const pnl = pnlOf(c);
      const won = pnl >= 0;
      setSessionPnl((v) => v + pnl);
      if (won) { setWins((v) => v + 1); setRecoveryUsed(false); recoveryPendingRef.current = false; }
      else { setLosses((v) => v + 1); if (running && recoveryEnabled && !recoveryUsed && !recoveryPendingRef.current) recoveryPendingRef.current = true; }
      setFlash({ won, pnl, type: typeOf(c) }); sound(won);
      setMessage(`${won ? "✓ WIN" : "✕ LOSS"} • ${typeOf(c)} • ${pnl >= 0 ? "+" : ""}${money(pnl, currency)}`);
    }
  }, [currency, touchContracts, recoveryEnabled, recoveryUsed, running, sound]);

  useEffect(() => {
    if (!running || !recoveryPendingRef.current || recoveryUsed || !analysis.ready || analysis.signal === "WAIT") return;
    if (analysis.entryScore < Math.max(minScore, 95)) return;
    recoveryPendingRef.current = false;
    void execute("RECOVERY", analysis);
  }, [analysis, execute, minScore, recoveryUsed, running]);

  useEffect(() => {
    if (!running) return;
    if (sessionTarget > 0 && sessionPnl >= sessionTarget) { setRunning(false); setMessage(`TAKE PROFIT • ${money(sessionPnl, currency)}`); }
    if (sessionStop > 0 && sessionPnl <= -sessionStop) { setRunning(false); setMessage(`STOP LOSS • ${money(sessionPnl, currency)}`); }
  }, [currency, running, sessionPnl, sessionStop, sessionTarget]);

  const recent = useMemo(() => touchContracts.filter(settled).sort((a,b) => Number(b?.date_start || b?.transaction_time || 0) - Number(a?.date_start || a?.transaction_time || 0)).slice(0, 8), [openContracts]);
  const open = touchContracts.filter((c) => !settled(c)).slice(0, 8);

  const toggle = () => {
    if (running) { setRunning(false); setMessage("Bot stopped — protection remains active."); return; }
    resetSession(); setRunning(true); setMessage("SCANNING • waiting for 92+/99 A+ Touch / No Touch setup.");
  };

  return (
    <section className="tntShell">
      <header className="tntHero">
        <div><small>ZENTORA • PROTECTED OPTIONS ENGINE</small><h1>Touch / No Touch Growth Desk</h1><p>Structure-first entries • adaptive stake • one-time recovery • hard session protection</p></div>
        <div className="tntLive"><span className={connected ? "liveDot on" : "liveDot"} />{connected ? (authenticatedFeed ? "TRADING READY" : "LIVE FEED") : status}</div>
      </header>

      {flash && <div className={`tntFlash ${flash.won ? "win" : "loss"}`}><strong>{flash.won ? "✓ TRADE WON" : "✕ TRADE LOST"}</strong><span>{flash.type}</span><b>{flash.pnl >= 0 ? "+" : ""}{money(flash.pnl, currency)}</b></div>}

      <div className="tntTopGrid">
        <div className="tntBalance"><span>ACCOUNT</span><strong>{selectedAccountType === "real" ? "REAL" : "DEMO"}</strong><small>{selectedAccount?.displayLabel || selectedAccountId || "Not connected"}</small><em>{money(balance, currency)}</em></div>
        <div className="tntMetric"><span>ENTRY ENGINE</span><strong>{analysis.signal}</strong><small>{analysis.state}</small><b>{analysis.entryScore}/99</b></div>
        <div className="tntMetric"><span>SESSION P/L</span><strong className={sessionPnl >= 0 ? "positive" : "negative"}>{sessionPnl >= 0 ? "+" : ""}{money(sessionPnl, currency)}</strong><small>Target +{sessionTPPct}% / Stop -{sessionSLPct}%</small><b>{wins}W • {losses}L • {winRate.toFixed(0)}%</b></div>
        <div className="tntMetric"><span>PROTECTION</span><strong>{recoveryPendingRef.current ? "RECOVERY READY" : "ARMED"}</strong><small>Max 10 trades • one recovery</small><b>{recoveryUsed ? "Recovery used" : "Recovery available"}</b></div>
      </div>

      <div className="tntControls">
        <label>MARKET<select value={symbol} disabled={!connected} onChange={(e) => void changeSymbol(e.target.value)}>{markets.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <label>STAKE MODE<select value={stakeMode} onChange={(e) => setStakeMode(e.target.value)}><option value="ADAPTIVE">ADAPTIVE</option><option value="FIXED">FIXED</option></select></label>
        <label>STAKE<input type="number" min="0.35" step="0.05" value={fixedStake} onChange={(e) => setFixedStake(Math.max(0.35, Number(e.target.value) || 0.35))}/></label>
        <label>DURATION<select value={duration} onChange={(e) => setDuration(Number(e.target.value))}><option value="3">3 TICKS</option><option value="5">5 TICKS</option><option value="10">10 TICKS</option><option value="15">15 TICKS</option></select></label>
        <label>MIN ENTRY<select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}><option value="92">92 / 99</option><option value="95">95 / 99</option><option value="97">97 / 99</option></select></label>
        <button className={`tntMainBtn ${running ? "stop" : "start"}`} onClick={toggle}>{running ? "STOP BOT" : "START A+ BOT"}</button>
      </div>

      <div className="tntMainGrid">
        <div className="tntChartCard"><div className="tntCardHead"><div><b>{displayMarket?.label || "Market"}</b><span>● LIVE</span></div><strong>{Number.isFinite(Number(currentPrice)) ? Number(currentPrice).toFixed(displayMarket?.decimals ?? 3) : "—"}</strong></div><div className="tntTabs"><span className="active">TICKS</span><span>1M</span><span>5M</span><span>15M</span></div><DerivTradingChart values={chartPrices} candleHistory={feed.candleHistory} signal={analysis.signal} confidence={analysis.entryScore} /></div>
        <div className="tntAnalysis">
          <div className="tntDecision"><span>MASTER DECISION</span><strong>{analysis.signal}</strong><b>{analysis.entryScore}/99</b><p>{analysis.reason}</p></div>
          <div className="tntCards"><div className={`tntSide ${analysis.candidate === "TOUCH" ? "best" : ""}`}><span>TOUCH</span><strong>{analysis.touchScore}</strong><small>Barrier {analysis.touchBarrier ? analysis.touchBarrier.toFixed(displayMarket?.decimals ?? 3) : "—"}</small><em>{analysis.touchScore >= minScore ? "QUALIFIED" : "WAIT"}</em></div><div className={`tntSide ${analysis.candidate === "NO TOUCH" ? "best" : ""}`}><span>NO TOUCH</span><strong>{analysis.noTouchScore}</strong><small>Barrier {analysis.noTouchBarrier ? analysis.noTouchBarrier.toFixed(displayMarket?.decimals ?? 3) : "—"}</small><em>{analysis.noTouchScore >= minScore ? "QUALIFIED" : "WAIT"}</em></div></div>
          <div className="tntChecks"><div><span>Trend</span><b>{analysis.trend}</b></div><div><span>Momentum</span><b>{analysis.momentum}</b></div><div><span>Volatility</span><b>{analysis.volatility}</b></div><div><span>Confirmations</span><b>{analysis.confirmations}/6</b></div><div><span>Market quality</span><b>{analysis.marketQuality}/100</b></div><div><span>Timing</span><b>{analysis.noChase ? "NO CHASE OK" : "LATE — WAIT"}</b></div></div>
        </div>
      </div>

      <div className="tntProtection"><div><span>SESSION TAKE PROFIT</span><strong>+{sessionTPPct}%</strong><input type="range" min="1" max="5" step="0.5" value={sessionTPPct} onChange={(e) => setSessionTPPct(Number(e.target.value))}/></div><div><span>SESSION STOP LOSS</span><strong>-{sessionSLPct}%</strong><input type="range" min="0.5" max="3" step="0.5" value={sessionSLPct} onChange={(e) => setSessionSLPct(Number(e.target.value))}/></div><div><span>RECOVERY</span><strong>{recoveryEnabled ? "X2 • ONE TIME" : "OFF"}</strong><input type="checkbox" checked={recoveryEnabled} onChange={(e) => setRecoveryEnabled(e.target.checked)}/></div><div><span>REAL TRADING</span><strong>{allowReal ? "UNLOCKED" : "LOCKED"}</strong><input type="checkbox" checked={allowReal} onChange={(e) => setAllowReal(e.target.checked)}/></div><button onClick={resetSession}>RESET SESSION</button></div>

      <div className="tntTables"><div className="tntTableCard"><div className="tntTableTitle">OPEN TRADES <small>{open.length}</small></div>{open.length ? open.map((c) => <div className="tntRow" key={idOf(c)}><b>{typeOf(c)}</b><span>{money(c?.buy_price ?? c?.stake ?? 0, currency)}</span><strong className={pnlOf(c) >= 0 ? "positive" : "negative"}>{money(pnlOf(c), currency)}</strong></div>) : <div className="empty">No open trades</div>}</div><div className="tntTableCard"><div className="tntTableTitle">RECENT TRADES</div>{recent.map((c) => <div className="tntRow" key={idOf(c)}><span>{timeOf(c)}</span><b>{typeOf(c)}</b><span>{idOf(c) ? `#${idOf(c)}` : "—"}</span><strong className={pnlOf(c) >= 0 ? "positive" : "negative"}>{pnlOf(c) >= 0 ? "+" : ""}{money(pnlOf(c), currency)}</strong></div>)}{!recent.length && <div className="empty">No settled trades yet</div>}</div></div>

      <footer className="tntFooter"><span className={connected ? "ok" : ""}>● Deriv API {connected ? "Connected" : "Offline"}</span><span>● Live market feed</span><span>● {authenticatedFeed ? "Trading Ready" : "Trading Auth Pending"}</span><span>● {selectedAccountType === "real" ? "Real Account" : "Demo Account"}</span><span className="tntMessage">{tradeBusy ? "EXECUTING…" : message}</span></footer>
    </section>
  );
}


export default function TouchNoTouchBot() {
  const feed = useDerivTicks();
  return <TouchNoTouchBotView feed={feed} />;
}
