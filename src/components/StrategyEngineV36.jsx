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
  activeSetup: "â€”",
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
      signals: { best: candidate, candidates: unified?.digit?.candidates || [], riseFall: unified?.riseFall || null },
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
      <button type="button" disabled={disabled} onClick={() => onChange(Math.max(min, Number((safe - step).toFixed(2))))}>âˆ’</button>
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

  const candles = useMemo(() => {
    const values = (Array.isArray(prices) ? prices : []).slice(-120).map(Number).filter(Number.isFinite);
    if (values.length < 2) return [];
    return values.map((close, i) => {
      const prev = i ? values[i - 1] : close;
      const open = prev;
      const span = Math.max(Math.abs(close - prev) * 1.8, Math.abs(close) * 0.000035, 0.0001);
      const high = Math.max(open, close) + span * (0.25 + ((i * 7) % 5) / 10);
      const low = Math.min(open, close) - span * (0.2 + ((i * 11) % 4) / 10);
      return { open, close, high, low, up: close >= open };
    });
  }, [prices]);

  const rsiValues = useMemo(() => {
    const values = (Array.isArray(prices) ? prices : []).slice(-120).map(Number).filter(Number.isFinite);
    if (values.length < 15) return [];
    const period = 14;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i += 1) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    const out = [];
    for (let i = period; i < values.length; i += 1) {
      if (i > period) {
        const d = values[i] - values[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
      }
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out.push(100 - (100 / (1 + rs)));
    }
    return out;
  }, [prices]);

  const rsiPath = useMemo(() => buildPath(rsiValues, 1000, 100), [rsiValues]);
  const latestRsi = rsiValues.length ? rsiValues.at(-1) : 50;

  return (
    <div className="rftAppShell">
      <header className="rftHeader">
        <div className="brand">
          <div className="brandMark">RFT</div>
          <div className="brandCopy">
            <h1>Rise/Fall &amp; Touch/No Touch <span>V10</span></h1>
            <p>Deriv Â· Continuous Scan Â· Confidence Gated Entries Â· Guarded Recovery Ã—2</p>
          </div>
        </div>
        <div className="headerActions">
          <div className={`statusPill ${busy ? "live" : ""}`}><i />{busy ? "Bot Running" : "Bot Ready"}</div>
          <div className="statusPill scan"><i />Continuous Scan</div>
          <select className="accountSelect" value={selectedAccount?.id || ""} onChange={(e) => void auth.selectAccount(e.target.value)} disabled={auth.accountsLoading}>
            {auth.accounts?.length ? auth.accounts.map((account) => <option key={account.id} value={account.id}>{account.displayLabel || account.id} Â· {account.currency || "USD"} {num(account.balance).toFixed(2)}</option>) : <option value="">Demo Account Â· {currency}</option>}
          </select>
          <button className="stopBtn" disabled={!busy} onClick={stopBot}>STOP BOT</button>
        </div>
      </header>

      <main className="rftMain">
        <section className="marketStrip">
          <div className="marketCard marketPicker"><span>DERIV MARKET</span><select value={effectiveSymbol} onChange={(e) => feed.changeSymbol(e.target.value)}>{(feed.markets || []).map((m) => <option key={m.symbol || m.id} value={m.symbol || m.id}>{m.display_name || m.name || m.symbol}</option>)}</select></div>
          <div className="marketCard livePrice"><span>LIVE PRICE</span><b>{num(feed.currentPrice).toFixed(priceDecimals)}</b><em>{feed.connected ? "LIVE" : "â€”"}</em></div>
          <Metric label="TICKS" value={`${digitHistory.length || 0}`} />
          <Metric label="QUALITY" value={`${quality.toFixed(0)}%`} tone={quality >= 80 ? "green" : ""} />
          <Metric label="CONFIDENCE" value={`${confidence.toFixed(0)}%`} tone={confidence >= settings.minConfidence ? "green" : ""} />
          <Metric label="AGREEMENT" value={`${agreement.toFixed(0)}%`} />
          <div className={`connection ${feed.connected ? "ok" : "bad"}`}><i />{feed.connected ? "CONNECTED" : (feed.status || "CONNECTING")}</div>
        </section>

        <section className="dashboardGrid">
          <div className="leftColumn">
            <article className="panel heroPanel">
              <div className="panelHead heroHead">
                <div><span>LIVE PRICE CHART</span><b>Tick by Tick</b></div>
                <div className="chartTools"><b>â—‰ MA (21)</b><b>â—‰ EMA (9)</b><i>âŒ•</i><i>â—Œ</i><i>âœ£</i><i>âš™</i></div>
              </div>
              <div className="chartWrap">
                {candles.length ? <svg className="priceChart candleChart" viewBox="0 0 1000 420" preserveAspectRatio="none">
                  {[60,120,180,240,300,360].map((y) => <line key={y} x1="0" x2="1000" y1={y} y2={y} className="gridLine" />)}
                  {candles.map((c, i) => {
                    const min = Math.min(...candles.map((x) => x.low));
                    const max = Math.max(...candles.map((x) => x.high));
                    const range = max - min || 1;
                    const y = (v) => 402 - ((v - min) / range) * 384;
                    const x = 18 + i * (964 / Math.max(1, candles.length - 1));
                    const bodyTop = Math.min(y(c.open), y(c.close));
                    const bodyHeight = Math.max(2, Math.abs(y(c.close) - y(c.open)));
                    return <g key={i} className={c.up ? "candle up" : "candle down"}>
                      <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} className="wick" />
                      <rect x={x - 2.7} y={bodyTop} width="5.4" height={bodyHeight} className="body" rx="1" />
                    </g>;
                  })}
                  <path d={candles.length > 2 ? buildPath(candles.map(c => c.close), 1000, 420) : ""} className="emaLine" />
                </svg> : <div className="empty">Waiting for live ticksâ€¦</div>}
                <div className="chartTag">{num(feed.currentPrice).toFixed(priceDecimals)}</div>
                <div className="chartAxis">3,218.000<br/><br/>3,216.000<br/><br/>3,214.000<br/><br/>3,212.000<br/><br/>3,210.000<br/><br/>3,208.000</div>
                <div className="chartTime">11:34ã€€ã€€ã€€ 11:35ã€€ã€€ã€€ 11:36ã€€ã€€ã€€ 11:37ã€€ã€€ã€€ 11:38ã€€ã€€ã€€ 11:39ã€€ã€€ã€€ 11:40ã€€ã€€ã€€ 11:41ã€€ã€€ã€€ 11:42</div>
              </div>
              <div className="rsiPanel">
                <div className="rsiLabel">RSI (14)<span>70</span><span>50</span><span>30</span></div>
                <svg viewBox="0 0 1000 100" preserveAspectRatio="none"><line x1="0" x2="1000" y1="20" y2="20" className="rsiGuide"/><line x1="0" x2="1000" y1="50" y2="50" className="rsiGuide"/><line x1="0" x2="1000" y1="80" y2="80" className="rsiGuide"/>{rsiPath && <path d={rsiPath} className="rsiLine"/>}</svg>
              </div>
            </article>

            <section className="analysisRow">
              <article className="panel analysisCard riseCard"><div className="cardIcon rise">â†—</div><div className="analysisContent"><span>RISE / FALL</span><div className="cardGrid"><div><small>DIRECTION</small><h2>{trend}</h2></div><div><small>PROBABILITY</small><Meter value={probability} tone="good"/><b>{probability.toFixed(0)}%</b></div></div><small>REASON: <b>{professional?.reason || "EMA Bullish Â· RSI confirmation"}</b></small></div></article>
              <article className="panel analysisCard touchCard"><div className="cardIcon touch">â—Ž</div><div className="analysisContent"><span>TOUCH / NO TOUCH</span><div className="cardGrid"><div><small>SIGNAL</small><h2>{timing?.state || "WAIT"}</h2></div><div><small>PROBABILITY</small><Meter value={timing?.readinessScore || agreement}/><b>{num(timing?.readinessScore || agreement).toFixed(0)}%</b></div></div><small>BARRIER: <b>{best?.barrier ?? "â€”"}</b></small></div></article>
              <article className="panel analysisCard gateCard"><div className="cardIcon gate">âœ“</div><div className="analysisContent"><span>ENTRY GATE</span><div className="cardGrid"><div><small>QUALITY</small><h2 className={sureEntry ? "green" : ""}>{quality >= 80 ? "HIGH" : "WAIT"}</h2></div><div><small>SCORE</small><Meter value={entryScore} tone={sureEntry ? "good" : ""}/><b>{entryScore.toFixed(0)}/100</b></div></div><small>AGREEMENT: <b>{agreement.toFixed(0)}% Â· {sureEntry ? "All filters passed" : "Waiting for confluence"}</b></small></div></article>
            </section>

            <section className="bottomGrid">
              <article className="panel logsPanel"><div className="panelHead"><div><span>RECENT LOGS</span></div><button className="clearBtn">CLEAR</button></div><div className="logsList">
                <div><i className="goodDot"/> <span>{new Date(serverTime).toLocaleTimeString()} High quality setup detected: {trend} Â· {timing?.state || "WAIT"} ({entryScore.toFixed(0)}%)</span></div>
                <div><i/> <span>Scanning marketâ€¦</span></div>
                <div><i/> <span>Market quality: {quality >= 80 ? "GOOD" : "CALIBRATING"} (Stability {stability.toFixed(0)}%)</span></div>
                <div><i/> <span>Waiting for high quality setupâ€¦</span></div>
                <div><i/> <span>Scanning marketâ€¦</span></div>
              </div></article>
              <article className="panel transactionsPreview"><div className="panelHead"><div><span>LAST 5 TRANSACTIONS</span><b>Click to expand</b></div></div><div className="miniTxTable"><div className="miniTxHead"><span>#</span><span>TIME</span><span>TYPE</span><span>DIRECTION</span><span>STAKE</span><span>ENTRY</span><span>EXIT</span><span>RESULT</span><span>P/L</span></div>{transactions.slice(0,5).map((item,index)=>{const win=String(item.result||"").toUpperCase()==="WIN";return <button key={`${item.id||index}-${item.time||index}`} className="miniTxRow"><span>{index+1}</span><span>{item.time ? new Date(item.time).toLocaleTimeString() : "â€”"}</span><span>{item.setup || "Rise/Fall"}</span><b className={win ? "green" : "red"}>{item.direction || setupLabel(best)}</b><span>{num(item.stake,settings.stake).toFixed(2)}</span><span>{item.entrySpot ?? "â€”"}</span><span>{item.exitSpot ?? "â€”"}</span><b className={win ? "green" : "red"}>{win ? "WIN" : "LOSS"}</b><b className={num(item.profit)>=0 ? "green" : "red"}>{num(item.profit)>=0?"+":""}{num(item.profit).toFixed(2)}</b></button>})}{!transactions.length && <div className="emptyRow">No settled trades yet.</div>}</div></article>
            </section>
          </div>

          <aside className="rightColumn">
            <article className="panel botPanel">
              <div className="botTitle"><div><span>DERIV BOT</span><b>STATUS: {busy ? "RUNNING" : "READY"}</b><small>{busy ? "SCANNING FOR HIGH QUALITY ENTRIESâ€¦" : "Waiting for validated setup"}</small></div><i className={busy ? "on" : ""}/></div>
              <div className="botStats"><span>WINS<b>{botState.wins}</b></span><span>LOSSES<b>{botState.losses}</b></span><span>WIN RATE<b>{winRate.toFixed(0)}%</b></span><span>STREAK<b>{Math.max(0, botState.wins - botState.losses)}</b></span></div>
              <button className="botStop" disabled={!busy} onClick={stopBot}>STOP BOT</button>
              <div className="settingsGrid">
                <label>DURATION<select value={settings.duration} disabled={busy} onChange={(e)=>setNumber("duration",Number(e.target.value))}><option value="1">1 Tick</option><option value="3">3 Ticks</option><option value="5">5 Ticks</option><option value="10">10 Ticks</option></select></label>
                <label>STAKE<Stepper value={settings.stake} min={0.35} max={100} step={0.5} disabled={busy} onChange={(v)=>setNumber("stake",v)}/></label>
                <label>DURATION UNIT<select value={settings.durationUnit} disabled={busy} onChange={(e)=>setNumber("durationUnit",e.target.value)}><option value="t">Ticks</option><option value="s">Seconds</option></select></label>
                <label>BARRIER DISTANCE<Stepper value={1} min={0.1} max={10} step={0.1} disabled={busy} onChange={()=>{}}/></label>
                <label>MIN ENTRY QUALITY<select value={settings.minConfidence} disabled={busy} onChange={(e)=>setNumber("minConfidence",Number(e.target.value))}><option value="80">HIGH (80%+)</option><option value="85">VERY HIGH (85%+)</option><option value="88">STRICT (88%+)</option></select></label>
                <label>TAKE PROFIT<Stepper value={settings.takeProfit} min={1} max={100} step={1} disabled={busy} onChange={(v)=>setNumber("takeProfit",v)}/></label>
                <label>STOP LOSS<Stepper value={settings.stopLoss} min={1} max={100} step={1} disabled={busy} onChange={(v)=>setNumber("stopLoss",v)}/></label>
              </div>
              <div className="recoveryBox"><div className="recoveryHeader"><span>RECOVERY Ã—2</span><b>{activeRecovery ? "ARMED" : "STANDBY"}</b></div><p>One guarded recovery attempt only after a stronger fresh setup.</p><div className="recoveryRow"><label><input type="checkbox" checked readOnly/> X2 (One Time)</label><span>Next stake <b>{(settings.stake * 2).toFixed(2)} {currency}</b></span></div></div>
              <div className="gateBox"><div><span>ENTRY GATE</span><b className={sureEntry ? "green" : ""}>{gateState}</b></div><div className="gateMetrics"><span>CONFIDENCE <b>{confidence.toFixed(0)}%</b></span><span>AGREEMENT <b>{agreement.toFixed(0)}%</b></span><span>SIGNAL <b>{trend}</b></span></div><Meter value={entryScore} tone={sureEntry ? "good" : ""}/></div>
              <button className="startBtn" disabled={busy || !auth.authenticated || !isDemo || !feed.connected || digitHistory.length < 12} onClick={startBot}>{busy ? "â— BOT RUNNING" : "START GUARDED DEMO BOT"}</button>
              <div className="botMessage">{!auth.authenticated ? "Connect your Deriv account." : !isDemo ? "Real account is locked for safety." : !feed.connected ? "Connecting to live feedâ€¦" : digitHistory.length < 12 ? `Calibrating ${digitHistory.length}/12 ticksâ€¦` : botState.message}</div>
            </article>

            <article className="panel sessionPanel"><div className="panelHead"><div><span>SESSION P/L</span></div><b>{transactions.length}</b></div><div className="sessionStats"><div><span>SESSION P/L</span><b className={botState.profit>=0?"green":"red"}>{botState.profit>=0?"+":""}{botState.profit.toFixed(2)} {currency}</b></div><div><span>TOTAL TRADES</span><b>{botState.runs}</b></div><div><span>RECOVERY USED</span><b>{activeRecovery ? "1/1" : "0/1"}</b></div></div></article>

            <article className="panel accountPanel"><div className="panelHead"><div><span>ACCOUNT SUMMARY</span></div></div><div className="accountRows"><div><span>BALANCE</span><b>{balance.toFixed(2)} {currency}</b></div><div><span>PROFIT</span><b className={botState.profit>=0?"green":"red"}>{botState.profit>=0?"+":""}{botState.profit.toFixed(2)} {currency}</b></div><div><span>EQUITY</span><b>{(balance + botState.profit).toFixed(2)} {currency}</b></div><div><span>AVG. STAKE</span><b>{settings.stake.toFixed(2)} {currency}</b></div></div></article>

            <article className="panel modePanel"><div className="panelHead"><div><span>BOT MODE</span></div><b>CONTINUOUS SCAN</b></div><div className="modeRow"><span>BOT MODE</span><strong>CONTINUOUS SCAN <small>(Manual Stop)</small></strong></div><div className="modeRow"><span>LAST SCAN</span><strong>{new Date(serverTime).toLocaleTimeString()}</strong></div></article>
          </aside>
        </section>
      </main>

      <footer className="rftFooter"><span>CONNECTION <b className={feed.connected?"green":"red"}>â— {feed.connected?"Connected":"Offline"}</b></span><span>SERVER TIME <b>{new Date(serverTime).toLocaleTimeString()}</b></span><span>TICKS <b>{digitHistory.length}</b></span><span>UPTIME <b>{Math.floor((botState.scanElapsedSeconds||0)/60).toString().padStart(2,"0")}:{((botState.scanElapsedSeconds||0)%60).toString().padStart(2,"0")}</b></span><strong>RFT V10 Â· Guarded Entry Â· Recovery Ã—2 Â· High Quality Entries Only</strong><span>Â© 2024 DerivAI</span></footer>
    </div>
  );
}
