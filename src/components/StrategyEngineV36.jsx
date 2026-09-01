import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import DerivBotEngine from "../bot/DerivBotEngine";
import { analyzeUnifiedSignals } from "../analysis/v71UnifiedSignalEngine";
import { buildValidatedSignals } from "../analysis/backtestEngine";
import { buildEntryTiming } from "../analysis/entryTimingEngine";
import { buildProfessionalDecision } from "../analysis/professionalDecisionEngine";
import "../styles/StrategyEngineV36.css";

const INITIAL_SETTINGS = {
  maxRuns: 56,
  stake: 1,
  duration: 5,
  durationUnit: "t",
  minConfidence: 88,
  minVotes: 3,
  takeProfit: 20,
  stopLoss: 6,
  maxScanTicks: 60,
  confirmationCount: 2,
  cooldownSeconds: 10,
  lossSetupBlockSeconds: 30,
  martingaleEnabled: true,
  martingaleMultiplier: 2,
  maxMartingaleSteps: 1,
  deepMinimumScore: 82,
  deepOverrideScore: 94,
};

const EMPTY_BOT = {
  status: "IDLE",
  message: "Bot is ready. Waiting for a validated setup.",
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  totalStake: 0,
  totalPayout: 0,
  consecutiveLosses: 0,
  lossesSinceWin: 0,
  martingaleStep: 0,
  currentStake: 1,
  activeSetup: "—",
  activeContractId: "",
  scanTicks: 0,
  maxScanTicks: 60,
  signalConfirmations: 0,
  requiredConfirmations: 2,
  executionPhase: "SCAN",
  lastBlockReason: "",
  deepScore: 0,
  deepConsensus: 0,
  deepRegime: "UNKNOWN",
  fastLane: false,
  gate: null,
  history: [],
  scanElapsedSeconds: 0,
};

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function setupLabel(candidate) {
  return String(candidate?.setup || candidate?.action || "WAIT").toUpperCase();
}

function buildPath(values, width = 1000, height = 250) {
  const clean = (Array.isArray(values) ? values : [])
    .slice(-100)
    .map(Number)
    .filter(Number.isFinite);
  if (clean.length < 2) return "";
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  return clean.map((value, index) => {
    const x = (index / (clean.length - 1)) * width;
    const y = height - 16 - ((value - min) / range) * (height - 32);
    return `${index ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

function makeDistribution(digits) {
  const counts = Array.from({ length: 10 }, (_, digit) => ({ digit, count: 0 }));
  for (const value of digits) {
    if (Number.isInteger(value) && value >= 0 && value <= 9) counts[value].count += 1;
  }
  const total = digits.length || 1;
  return counts.map((row) => ({
    ...row,
    percent: (row.count / total) * 100,
  }));
}

function makeRecency(digits) {
  return makeDistribution(digits.slice(-30));
}

function normalizeSignal(unified, validated, professional, snapshot, minConfidence) {
  const candidate = unified?.digit?.best || validated?.best || null;
  const probability = num(candidate?.probability, num(validated?.best?.lowerBound, 0));
  const confidence = num(candidate?.confidence, num(professional?.professionalScore, probability));
  const edge = num(candidate?.edge, num(validated?.best?.edge, 0));

  return {
    updatedAt: Date.now(),
    tickKey: `${snapshot.symbol}:${snapshot.currentPrice}:${snapshot.digitHistory.at(-1)}:${snapshot.digitHistory.length}`,
    quoteTime: Date.now(),
    epoch: Date.now(),
    symbol: snapshot.symbol,
    currentPrice: snapshot.currentPrice,
    lastDigit: snapshot.lastDigit,
    digitHistory: snapshot.digitHistory,
    recentDigits: snapshot.digitHistory.slice(-60),
    setup: setupLabel(candidate),
    action: setupLabel(candidate),
    probability,
    confidence,
    edge,
    analysis: {
      ...unified,
      ...unified?.digit,
      sampleSize: snapshot.digitHistory.length,
      distribution: makeDistribution(snapshot.digitHistory),
      recency: makeRecency(snapshot.digitHistory),
      digitHistory: snapshot.digitHistory,
      recentDigits: snapshot.digitHistory.slice(-60),
      bestSetup: candidate,
      bestContract: setupLabel(candidate),
      selectedProbability: probability,
      selectedEdge: edge,
      decisionConfidence: confidence,
      confidence,
      probability,
      edge,
      professionalDecision: professional,
      minimumConfidence: minConfidence,
      signals: { best: candidate, candidates: unified?.digit?.candidates || [] },
    },
  };
}

function Metric({ label, value, tone = "" }) {
  return <div className={`metric ${tone}`}><span>{label}</span><b>{value}</b></div>;
}

function Meter({ value, tone = "" }) {
  return <div className="meter"><i className={tone} style={{ width: `${clamp(value)}%` }} /></div>;
}

function Stepper({ value, min, max, step = 1, onChange, disabled }) {
  const safe = num(value, min);
  return (
    <div className="stepper">
      <button type="button" disabled={disabled} onClick={() => onChange(Math.max(min, Number((safe - step).toFixed(2))))}>−</button>
      <b>{safe}</b>
      <button type="button" disabled={disabled} onClick={() => onChange(Math.min(max, Number((safe + step).toFixed(2))))}>+</button>
    </div>
  );
}

export default function StrategyEngineV36() {
  const auth = useDerivAuth();
  const feed = useDerivTicks();
  const botRef = useRef(null);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [botState, setBotState] = useState(EMPTY_BOT);
  const [expandedTx, setExpandedTx] = useState(null);
  const [filter, setFilter] = useState("ALL");
  const [serverTime, setServerTime] = useState(Date.now());

  const effectiveSymbol = feed.symbol || feed.markets?.[0]?.symbol || "1HZ100V";
  const selectedAccount = auth.selectedAccount;
  const isDemo = auth.selectedAccountType === "demo";
  const currency = selectedAccount?.currency || "USD";
  const prices = feed.prices || [];
  const digitHistory = feed.digitHistory || [];

  const snapshot = useMemo(() => ({
    symbol: effectiveSymbol,
    currentPrice: feed.currentPrice,
    lastDigit: feed.lastDigit,
    prices,
    digitHistory,
  }), [effectiveSymbol, feed.currentPrice, feed.lastDigit, prices, digitHistory]);

  const unified = useMemo(() => analyzeUnifiedSignals({
    ...snapshot,
    minimumConfidence: settings.minConfidence,
  }), [snapshot, settings.minConfidence]);

  const validated = useMemo(() => buildValidatedSignals(snapshot), [snapshot]);
  const timing = useMemo(() => buildEntryTiming(validated, snapshot, {
    tradeTicks: settings.duration,
    validitySeconds: 15,
  }), [validated, snapshot, settings.duration]);
  const professional = useMemo(() => buildProfessionalDecision(snapshot, validated), [snapshot, validated]);
  const signal = useMemo(() => normalizeSignal(unified, validated, professional, snapshot, settings.minConfidence), [unified, validated, professional, snapshot, settings.minConfidence]);

  const best = unified?.digit?.best || validated?.best || null;
  const candidates = unified?.digit?.candidates || [];
  const confidence = clamp(num(best?.confidence, professional?.professionalScore));
  const probability = clamp(num(best?.probability, validated?.best?.lowerBound));
  const edge = num(best?.edge, validated?.best?.edge);
  const quality = clamp(num(professional?.marketQuality, professional?.professionalScore));
  const agreement = clamp(num(professional?.passedCount, 0) / Math.max(1, num(professional?.totalChecks, 7)) * 100);
  const trend = professional?.checks?.trend?.direction || "WAIT";
  const momentum = num(professional?.checks?.momentum?.score, 0);
  const stability = clamp(num(best?.stability, professional?.checks?.volatility?.score));
  const entryScore = clamp(confidence * 0.38 + quality * 0.32 + agreement * 0.18 + stability * 0.12);
  const freshEntry = Boolean(best && confidence >= settings.minConfidence && quality >= 78 && agreement >= 55 && digitHistory.length >= 60);
  const recoveryReady = botState.martingaleStep > 0 && freshEntry && confidence >= 92 && quality >= 85 && agreement >= 65 && setupLabel(best) !== String(botState.lastLossSetup || "").toUpperCase();
  const sureEntry = freshEntry && entryScore >= 84;
  const gateState = recoveryReady ? "RECOVERY READY" : sureEntry ? "QUALIFIED" : "WAIT";
  const chartPath = useMemo(() => buildPath(prices), [prices]);

  useEffect(() => {
    const id = window.setInterval(() => setServerTime(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!botRef.current) {
      botRef.current = new DerivBotEngine({
        client: derivPublicClient,
        onState: setBotState,
      });
    }
    return () => {
      botRef.current?.destroy?.();
      botRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!botRef.current) return;
    botRef.current.configure({
      ...settings,
      martingaleEnabled: true,
      recoveryMultipliers: [2],
      maxMartingaleSteps: 1,
      analysisAssisted: true,
    });
  }, [settings]);

  useEffect(() => {
    if (!botRef.current) return;
    botRef.current.setMarket({ symbol: effectiveSymbol, currency });
    botRef.current.setAccountMode({ isDemo });
  }, [effectiveSymbol, currency, isDemo]);

  useEffect(() => {
    botRef.current?.updateSignal(signal);
  }, [signal]);

  const busy = botState.status === "RUNNING" || botState.status === "WAITING" || botState.status === "CONFIRMING" || botState.status === "RISK_COOLDOWN";
  const winRate = botState.runs ? (botState.wins / botState.runs) * 100 : 0;
  const transactions = (feed.transactions?.length ? feed.transactions : botState.history || []).filter((item) => filter === "ALL" || String(item.result || "").toUpperCase() === filter);
  const balance = num(selectedAccount?.balance, 0);
  const priceDecimals = feed.market?.decimals ?? 2;

  const setNumber = (key, value) => setSettings((current) => ({ ...current, [key]: value }));

  const startBot = async () => {
    if (!botRef.current || !feed.connected || !auth.authenticated || !selectedAccount || !isDemo) return;
    botRef.current.configure({ ...settings, martingaleEnabled: true, recoveryMultipliers: [2], maxMartingaleSteps: 1, analysisAssisted: true });
    botRef.current.setMarket({ symbol: effectiveSymbol, currency });
    botRef.current.setAccountMode({ isDemo: true });
    try {
      await botRef.current.start();
    } catch (error) {
      setBotState((current) => ({ ...current, status: "ERROR", message: error?.message || "Unable to start bot." }));
    }
  };

  const stopBot = () => botRef.current?.stop("Stopped by operator.", "STOPPED");

  const topCandidates = candidates.slice(0, 5);
  const activeRecovery = botState.martingaleStep > 0;

  return (
    <div className="rftAppShell">
      <header className="rftHeader">
        <div className="brand">
          <div className="brandMark">RFT</div>
          <div><h1>Rise/Fall &amp; Touch/No Touch <span>Analysis Console</span></h1><p>Live Deriv analysis · multi-gate confirmation · guarded Recovery ×2</p></div>
        </div>
        <div className="headerActions">
          <div className={`statusPill ${feed.connected ? "ok" : "bad"}`}><i />{feed.connected ? "DERIV LIVE" : "FEED OFFLINE"}</div>
          <div className={`statusPill ${busy ? "live" : ""}`}><i />{busy ? botState.status : "BOT READY"}</div>
          <select className="accountSelect" value={selectedAccount?.id || ""} onChange={(e) => void auth.selectAccount(e.target.value)} disabled={auth.accountsLoading}>
            {auth.accounts?.length ? auth.accounts.map((account) => <option key={account.id} value={account.id}>{account.displayLabel || account.id} · {account.currency || "USD"} {num(account.balance).toFixed(2)}</option>) : <option value="">No account</option>}
          </select>
          <button className="stopBtn" disabled={!busy} onClick={stopBot}>STOP</button>
        </div>
      </header>

      <main className="rftMain">
        <section className="marketStrip">
          <div className="marketPicker"><span>MARKET</span><select value={effectiveSymbol} onChange={(e) => feed.changeSymbol(e.target.value)}>{(feed.markets || []).map((m) => <option key={m.symbol || m.id} value={m.symbol || m.id}>{m.display_name || m.name || m.symbol}</option>)}</select></div>
          <div className="livePrice"><span>LIVE PRICE</span><b>{num(feed.currentPrice).toFixed(priceDecimals)}</b><em>{feed.connected ? "LIVE" : "—"}</em></div>
          <Metric label="TICKS" value={`${digitHistory.length}`} />
          <Metric label="QUALITY" value={`${quality.toFixed(0)}%`} tone={quality >= 80 ? "green" : ""} />
          <Metric label="CONFIDENCE" value={`${confidence.toFixed(0)}%`} tone={confidence >= settings.minConfidence ? "green" : ""} />
          <Metric label="AGREEMENT" value={`${agreement.toFixed(0)}%`} />
          <div className={`connection ${feed.connected ? "ok" : "bad"}`}><i />{feed.connected ? "CONNECTED" : (feed.status || "CONNECTING")}</div>
        </section>

        <section className="dashboardGrid">
          <div className="leftColumn">
            <article className="panel chartPanel">
              <div className="panelHead"><div><span>LIVE MARKET ANALYSIS</span><b>{effectiveSymbol} · Tick-by-tick</b></div><div className="headBadges"><b>EMA</b><b>RSI</b><b>VOLATILITY</b><b>DIGIT PRESSURE</b></div></div>
              <div className="chartWrap">
                {chartPath ? <svg className="priceChart" viewBox="0 0 1000 250" preserveAspectRatio="none">
                  {[40,80,120,160,200].map((y) => <line key={y} x1="0" x2="1000" y1={y} y2={y} className="gridLine" />)}
                  <path d={`${chartPath} L 1000 250 L 0 250 Z`} className="chartFill" />
                  <path d={chartPath} className="chartLine" />
                </svg> : <div className="empty">Waiting for live ticks…</div>}
                <div className="chartTag">{num(feed.currentPrice).toFixed(priceDecimals)}</div>
                <div className="chartState">{gateState}</div>
              </div>
              <div className="chartFooter"><span>LAST DIGIT <b>{feed.lastDigit ?? "—"}</b></span><span>SAMPLE <b>{digitHistory.length}/100</b></span><span>MODEL <b>V71 + WALK-FORWARD</b></span><span>FEED <b className={feed.connected ? "green" : "red"}>{feed.connected ? "LIVE" : "OFFLINE"}</b></span></div>
            </article>

            <section className="analysisRow">
              <article className="panel analysisCard"><div className="cardIcon rise">↗</div><div><span>RISE / FALL</span><h2>{trend}</h2><p>{professional?.reason || "Waiting for directional confirmation."}</p><Meter value={num(professional?.checks?.trend?.score)} /><small>Trend strength <b>{num(professional?.checks?.trend?.score).toFixed(0)}%</b></small></div></article>
              <article className="panel analysisCard"><div className="cardIcon touch">◎</div><div><span>TOUCH / NO TOUCH</span><h2>{timing?.state || "WAIT"}</h2><p>{best ? `Trigger ${setupLabel(best)} · edge ${edge.toFixed(1)}` : "Barrier/distance analysis waiting for a candidate."}</p><Meter value={timing?.readinessScore || agreement} /><small>Readiness <b>{num(timing?.readinessScore).toFixed(0)}%</b></small></div></article>
              <article className="panel analysisCard"><div className="cardIcon gate">✓</div><div><span>SURE ENTRY GATE</span><h2 className={sureEntry ? "green" : ""}>{gateState}</h2><p>{sureEntry ? "Multiple independent checks agree. Entry is eligible, not guaranteed." : (best?.reason || "No setup meets the full gate yet.")}</p><Meter value={entryScore} tone={sureEntry ? "good" : ""} /><small>Composite <b>{entryScore.toFixed(0)}/100</b></small></div></article>
            </section>

            <section className="bottomGrid">
              <article className="panel candidatePanel"><div className="panelHead"><div><span>TOP CANDIDATES</span><b>Ranked by current evidence</b></div><span className="miniNote">No forced entry</span></div><div className="candidateList">{topCandidates.map((item, index) => <div className={`candidate ${index === 0 && sureEntry ? "selected" : ""}`} key={`${setupLabel(item)}-${index}`}><strong>#{index + 1}</strong><b>{setupLabel(item)}</b><span>{num(item.probability).toFixed(1)}% prob</span><span>{num(item.confidence).toFixed(0)}% conf</span><em>{item.approved ? "APPROVED" : "WAIT"}</em></div>)}{!topCandidates.length && <div className="emptyRow">Collecting calibrated digit history…</div>}</div></article>
              <article className="panel recoveryPanel"><div className="panelHead"><div><span>RECOVERY ×2</span><b>One guarded attempt</b></div><em className={activeRecovery ? "warn" : "green"}>{activeRecovery ? "ARMED" : "STANDBY"}</em></div><div className="recoveryStatus"><strong>{recoveryReady ? "RECOVERY READY" : activeRecovery ? "WAIT FOR BETTER SETUP" : "NORMAL STAKE"}</strong><span>{activeRecovery ? `Next eligible stake: ${(settings.stake * 2).toFixed(2)} ${currency}` : `Base stake: ${settings.stake.toFixed(2)} ${currency}`}</span></div><div className="recoveryChecks"><span>Fresh setup <b>{recoveryReady ? "PASS" : "WAIT"}</b></span><span>Confidence ≥92 <b>{confidence >= 92 ? "PASS" : "WAIT"}</b></span><span>Quality ≥85 <b>{quality >= 85 ? "PASS" : "WAIT"}</b></span><span>New setup <b>{setupLabel(best) !== String(botState.lastLossSetup || "").toUpperCase() ? "PASS" : "BLOCK"}</b></span></div><small>Recovery never guarantees a win. It only activates after a stronger, fresh gate.</small></article>
            </section>
          </div>

          <aside className="rightColumn">
            <article className="panel botPanel">
              <div className="botTitle"><div><span>DERIV BOT</span><b>{busy ? botState.status : "SCANNING"}</b></div><i className={busy ? "on" : ""} /></div>
              <div className="botStats"><span>P/L <b className={botState.profit >= 0 ? "green" : "red"}>{botState.profit.toFixed(2)}</b></span><span>WINS <b>{botState.wins}</b></span><span>LOSSES <b>{botState.losses}</b></span><span>TRADES <b>{botState.runs}</b></span></div>
              <div className="botMode"><span>MODE</span><b>DEMO · AUTO</b><span>PHASE</span><b>{botState.executionPhase || "SCAN"}</b></div>
              <div className="settingsGrid">
                <label>STAKE<Stepper value={settings.stake} min={0.35} max={100} step={0.5} disabled={busy} onChange={(v) => setNumber("stake", v)} /></label>
                <label>DURATION<select value={settings.duration} disabled={busy} onChange={(e) => setNumber("duration", Number(e.target.value))}><option value="1">1 tick</option><option value="3">3 ticks</option><option value="5">5 ticks</option><option value="10">10 ticks</option></select></label>
                <label>MIN CONF<Stepper value={settings.minConfidence} min={80} max={95} step={1} disabled={busy} onChange={(v) => setNumber("minConfidence", v)} /></label>
                <label>MAX SCAN<Stepper value={settings.maxScanTicks} min={24} max={120} step={6} disabled={busy} onChange={(v) => setNumber("maxScanTicks", v)} /></label>
                <label>TAKE PROFIT<Stepper value={settings.takeProfit} min={1} max={100} step={1} disabled={busy} onChange={(v) => setNumber("takeProfit", v)} /></label>
                <label>STOP LOSS<Stepper value={settings.stopLoss} min={1} max={100} step={1} disabled={busy} onChange={(v) => setNumber("stopLoss", v)} /></label>
              </div>
              <div className="gateBox"><div><span>ENTRY GATE</span><b className={sureEntry ? "green" : ""}>{gateState}</b></div><Meter value={entryScore} tone={sureEntry ? "good" : ""} /><small>{confidence.toFixed(0)}% confidence · {quality.toFixed(0)}% market quality · {agreement.toFixed(0)}% agreement</small></div>
              <button className="startBtn" disabled={busy || !auth.authenticated || !isDemo || !feed.connected || digitHistory.length < 12} onClick={startBot}>{busy ? "● BOT RUNNING" : "▶ START GUARDED DEMO BOT"}</button>
              <button className="secondaryBtn" disabled={!busy} onClick={() => botRef.current?.pause?.()}>PAUSE SCAN</button>
              <div className="readyText"><i />{!auth.authenticated ? "Connect your Deriv account." : !isDemo ? "Real account is locked for safety." : !feed.connected ? "Connecting to live feed…" : digitHistory.length < 12 ? `Calibrating ${digitHistory.length}/12 ticks…` : botState.message}</div>
            </article>

            <article className="panel accountPanel"><div className="panelHead"><div><span>ACCOUNT / SESSION</span><b>{selectedAccount?.id || "Demo"}</b></div><button className="iconBtn" onClick={() => void auth.refreshAccounts()} disabled={auth.accountsLoading}>↻</button></div><div className="accountStats"><div><span>BALANCE</span><b>{balance.toFixed(2)} {currency}</b></div><div><span>SESSION P/L</span><b className={botState.profit >= 0 ? "green" : "red"}>{botState.profit >= 0 ? "+" : ""}{botState.profit.toFixed(2)}</b></div><div><span>WIN RATE</span><b>{winRate.toFixed(0)}%</b></div><div><span>RECOVERY</span><b>{activeRecovery ? "1 / 1" : "0 / 1"}</b></div></div><Meter value={winRate} tone="good" /></article>

            <article className="panel miniHistory"><div className="panelHead"><div><span>LIVE EXECUTION</span><b>Last 5 trades</b></div><span>{botState.scanTicks}/{botState.maxScanTicks}</span></div><div className="tradeList">{(botState.history || []).slice(0, 5).map((item, i) => <div key={`${item.id || i}-${item.time}`}><i className={String(item.result).toUpperCase() === "WIN" ? "win" : "loss"} /><span>{item.setup || "TRADE"}</span><b className={num(item.profit) >= 0 ? "green" : "red"}>{num(item.profit) >= 0 ? "+" : ""}{num(item.profit).toFixed(2)}</b><em>{String(item.result || "WAIT").toUpperCase()}</em></div>)}{!botState.history?.length && <div className="emptyRow">No settled trades yet.</div>}</div></article>
          </aside>
        </section>

        <section className="panel transactionPanel"><div className="panelHead"><div><span>TRANSACTION LEDGER</span><b>Last 5 · click to expand</b></div><select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="ALL">ALL</option><option value="WIN">WINS</option><option value="LOSS">LOSSES</option></select></div><div className="txHeader"><span>#</span><span>TIME</span><span>SETUP</span><span>STAKE</span><span>RESULT</span><span>P/L</span><span>STATUS</span><span /></div><div className="txList">{transactions.slice(0, 5).map((item, index) => { const id = `${item.id || index}-${item.time || index}`; const open = expandedTx === id; const win = String(item.result || "").toUpperCase() === "WIN"; return <div className={`txItem ${open ? "open" : ""}`} key={id}><button className="txRow" onClick={() => setExpandedTx(open ? null : id)}><span>{index + 1}</span><span>{item.time ? new Date(item.time).toLocaleTimeString() : "—"}</span><span>{item.setup || "TRADE"}</span><span>{num(item.stake, settings.stake).toFixed(2)}</span><b className={win ? "green" : "red"}>{win ? "WIN" : "LOSS"}</b><b className={num(item.profit) >= 0 ? "green" : "red"}>{num(item.profit) >= 0 ? "+" : ""}{num(item.profit).toFixed(2)}</b><span>SETTLED</span><span>{open ? "⌃" : "⌄"}</span></button>{open && <div className="txDetails"><span>CONTRACT <b>{item.id || "—"}</b></span><span>ENTRY <b>{item.entrySpot ?? "—"}</b></span><span>EXIT <b>{item.exitSpot ?? "—"}</b></span><span>PAYOUT <b>{num(item.payout).toFixed(2)}</b></span><span>DURATION <b>{item.duration || settings.duration} {item.durationUnit === "s" ? "sec" : "ticks"}</b></span></div>}</div>; })}{!transactions.length && <div className="emptyRow">No transactions yet — start the guarded Demo Bot.</div>}</div></section>
      </main>

      <footer className="rftFooter"><span>FEED <b className={feed.connected ? "green" : "red"}>● {feed.connected ? "LIVE" : "OFFLINE"}</b></span><span>SERVER <b>{new Date(serverTime).toLocaleTimeString()}</b></span><span>SAMPLE <b>{digitHistory.length}</b></span><span>BOT <b>{botState.status}</b></span><strong>RFT V10 · Guarded Entry · Recovery ×2</strong><span>Demo mode</span></footer>
    </div>
  );
}
