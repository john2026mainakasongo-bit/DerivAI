import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import Topbar from "../components/Topbar";
import { useDerivAuth } from "../auth/DerivAuthContext";
import derivPublicClient from "../services/derivApi";
import { analyzeRiseFallTouch } from "../analysis/riseFallTouchEngine";
import "../styles/RiseFallTouchAnalysis.css";

const INITIAL = {
  mode: "AUTO",
  stake: 1,
  duration: 5,
  durationUnit: "t",
  barrierDistance: 1,
  minConfidence: 78,
  takeProfit: 5,
  stopLoss: 3,
  cooldown: 3
};

function fmt(v, d = 5) {
  return Number.isFinite(Number(v)) ? Number(v).toFixed(d) : "—";
}
function accountId(a) {
  return String(a?.id || a?.account_id || a?.loginid || a?.login_id || "");
}
function isDemo(a) {
  const id = accountId(a).toUpperCase();
  const type = String(a?.type || a?.account_type || a?.accountType || "").toLowerCase();
  return ["demo", "virtual", "vrt"].includes(type) || id.startsWith("VRTC");
}
function buildPath(values, width = 900, height = 340) {
  const v = values.map(Number).filter(Number.isFinite).slice(-100);
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v), range = max - min || 1;
  return v.map((x, i) => {
    const px = i / (v.length - 1) * width;
    const py = height - ((x - min) / range) * (height - 20) - 10;
    return `${i ? "L" : "M"} ${px.toFixed(1)} ${py.toFixed(1)}`;
  }).join(" ");
}

export default function RiseFallTouchAnalysis() {
  const auth = useDerivAuth();
  const feed = useDerivTicks();
  const [settings, setSettings] = useState(INITIAL);
  const [botRunning, setBotRunning] = useState(false);
  const [realTradingUnlocked, setRealTradingUnlocked] = useState(false);
  const [botStatus, setBotStatus] = useState("READY");
  const [sessionPnl, setSessionPnl] = useState(0);
  const [wins, setWins] = useState(0);
  const [losses, setLosses] = useState(0);
  const [tradeCount, setTradeCount] = useState(0);
  const [logs, setLogs] = useState([]);
  const activeRef = useRef(null);
  const busyRef = useRef(false);
  const lastTradeRef = useRef(0);
  const pnlRef = useRef(0);
  const chartRef = useRef(null);

  const analysis = useMemo(
    () => analyzeRiseFallTouch(feed.prices || []),
    [feed.prices]
  );

  const prices = feed.prices || [];
  const path = buildPath(prices.map(Number));
  const demo = isDemo(auth.selectedAccount);
  const active = analysis.engines?.[0];

  function log(message, type = "info") {
    setLogs(current => [
      { time: new Date().toLocaleTimeString(), message, type },
      ...current
    ].slice(0, 80));
  }

  function update(key, value) {
    setSettings(current => ({ ...current, [key]: value }));
  }

  function selectedSignal() {
    if (!analysis?.ready) return null;
    if (settings.mode === "AUTO") return analysis;
    const found = analysis.engines?.find(x => x.setup === settings.mode);
    return found ? { ...analysis, ...found, signal: found.setup } : null;
  }

  async function execute(signal) {
    if (busyRef.current || activeRef.current || !signal) return;    const selectedType = String(
      auth.selectedAccountType ||
      auth.selectedAccount?.type ||
      auth.selectedAccount?.account_type ||
      ""
    ).toLowerCase();

    const isReal = selectedType === "real" && !demo;

    if (!auth.authenticated || !auth.selectedAccount || !feed.selectedAccountId) {
      setBotStatus("ACCOUNT REQUIRED");
      log("Connect Deriv and select an account first.", "error");
      return;
    }

    if (isReal && !realTradingUnlocked) {
      setBotStatus("REAL LOCKED");
      log("Real trading is locked. Enable Real Trading first.", "error");
      return;
    }
    if (Date.now() - lastTradeRef.current < settings.cooldown * 1000) return;

    busyRef.current = true;
    try {
      const setup = String(signal.signal || signal.setup || "").toUpperCase();
      let contractType = setup === "RISE" ? "CALL" : setup === "FALL" ? "PUT" : setup === "TOUCH" ? "ONETOUCH" : "NOTOUCH";
      let barrier;

      if (setup === "TOUCH" || setup === "NO TOUCH") {
        const distance = Math.max(Number(settings.barrierDistance) || 1, 0.1);
        const vol = Number(analysis.metrics?.volatility || 0);
        const px = Number(analysis.metrics?.current || feed.currentPrice || 0);
        const direction = setup === "TOUCH" ? (active?.setup === "RISE" ? 1 : -1) : (active?.setup === "RISE" ? -1 : 1);
        barrier = String(px + direction * Math.max(vol * distance, 0.00001));
      }

      log(`SETUP SPOTTED → ${setup} · confidence ${Number(signal.confidence || 0).toFixed(1)}%`, "signal");
      setBotStatus(`BUYING ${setup}`);

      const bought = await feed.placeTrade({
        symbol: feed.symbol,
        contractType,
        amount: Number(settings.stake),
        currency: auth.selectedAccount?.currency || "USD",
        duration: Number(settings.duration),
        durationUnit: settings.durationUnit,
        barrier
      });

      const contractId = String(bought?.contractId || "");
      if (!contractId) throw new Error("No contract ID returned.");

      activeRef.current = {
        contractId,
        setup,
        stake: Number(settings.stake),
        started: Date.now()
      };
      setTradeCount(x => x + 1);
      lastTradeRef.current = Date.now();
      setBotStatus(`MONITORING ${setup}`);
      log(`TRADE OPEN → ${contractId}`, "trade");
    } catch (error) {
      log(error?.message || "Trade failed.", "error");
      setBotStatus("SCAN");
    } finally {
      busyRef.current = false;
    }
  }

  useEffect(() => {
    if (!botRunning) return;
    if (sessionPnl >= Number(settings.takeProfit)) {
      setBotRunning(false);
      setBotStatus("TAKE PROFIT");
      log(`SESSION TAKE PROFIT HIT → +${sessionPnl.toFixed(2)}`, "win");
      return;
    }
    if (sessionPnl <= -Math.abs(Number(settings.stopLoss))) {
      setBotRunning(false);
      setBotStatus("STOP LOSS");
      log(`SESSION STOP LOSS HIT → ${sessionPnl.toFixed(2)}`, "loss");
      return;
    }

    const signal = selectedSignal();
    if (!signal?.ready || signal.signal === "WAIT") {
      setBotStatus("SCANNING");
      return;
    }
    if (Number(signal.confidence || 0) < Number(settings.minConfidence)) {
      setBotStatus(`WAITING ${Number(signal.confidence || 0).toFixed(1)}%`);
      return;
    }
    if (!activeRef.current) void execute(signal);
  }, [
    botRunning,
    analysis,
    settings.mode,
    settings.minConfidence,
    settings.stake,
    settings.duration,
    settings.durationUnit,
    settings.barrierDistance,
    settings.takeProfit,
    settings.stopLoss,
    settings.cooldown,
    sessionPnl
  ]);

  useEffect(() => {
    if (!activeRef.current) return;
    const timer = window.setInterval(async () => {
      const active = activeRef.current;
      if (!active) return;
      try {
        const response = await feed.refreshContract(active.contractId);
        const contract =
          response?.proposal_open_contract ||
          response?.data?.proposal_open_contract ||
          response?.contract ||
          response?.data?.contract ||
          response;
        const status = String(contract?.status || "").toLowerCase();
        const finished = Boolean(
          contract?.is_sold || contract?.is_expired ||
          ["sold", "won", "lost", "expired", "cancelled"].includes(status)
        );
        const profit = Number(
          contract?.profit ?? contract?.profit_loss ?? contract?.pnl ??
          (Number(contract?.sell_price || 0) - Number(contract?.buy_price || active.stake))
        );
        if (finished) {
          const pnl = Number.isFinite(profit) ? profit : 0;
          activeRef.current = null;
          pnlRef.current += pnl;
          setSessionPnl(pnlRef.current);
          if (pnl >= 0) {
            setWins(x => x + 1);
            log(`RESULT WON → ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`, "win");
          } else {
            setLosses(x => x + 1);
            log(`RESULT LOST → ${pnl.toFixed(2)}`, "loss");
          }
          setBotStatus("SCANNING");
        }
      } catch (error) {
        log(`Contract monitor: ${error?.message || "retrying"}`, "error");
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [feed.refreshContract]);

  function startBot() {
    if (!feed.connected) {
      log("Connect the Deriv feed first.", "error");
      return;
    }    const selectedType = String(
      auth.selectedAccountType ||
      auth.selectedAccount?.type ||
      auth.selectedAccount?.account_type ||
      ""
    ).toLowerCase();

    const isReal = selectedType === "real" && !demo;

    if (!auth.authenticated || !auth.selectedAccount) {
      log("Connect Deriv and select an account first.", "error");
      setBotStatus("ACCOUNT REQUIRED");
      return;
    }

    if (isReal && !realTradingUnlocked) {
      log("Enable Real Trading before starting the bot.", "error");
      setBotStatus("REAL LOCKED");
      return;
    }
    if (sessionPnl >= Number(settings.takeProfit) || sessionPnl <= -Math.abs(Number(settings.stopLoss))) {
      pnlRef.current = 0;
      setSessionPnl(0);
      setWins(0);
      setLosses(0);
      setTradeCount(0);
    }
    setBotRunning(true);
    setBotStatus("SCANNING");
    log("BOT STARTED → continuous scan until signal / TP / SL.", "system");
  }

  function stopBot() {
    setBotRunning(false);
    setBotStatus("STOPPED");
    log("BOT STOPPED by operator.", "system");
  }

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.scrollLeft = chartRef.current.scrollWidth;
  }, [prices.length]);

  return (
    <section className="rftShell" id="rise-fall-touch-tool">
      <header className="rftHeader">
        <div>
          <div className="rftEyebrow">DERIV LIVE ANALYSIS</div>
          <h2>Rise/Fall and Touch/No Touch Analysis Tool</h2>
          <p>Dedicated market-reading engine with live signals, chart overlays and continuous Demo/Real bot execution.</p>
        </div>
        <div className={`rftConnection ${feed.connected ? "online" : ""}`}>
          <i /> {feed.connected ? "LIVE" : "CONNECTING"}
        </div>
      </header>

      <div className="rftGrid">
        <main className="rftMain">
          <div className="rftToolbar">
            <select value={feed.symbol || ""} onChange={e => feed.changeSymbol(e.target.value)}>
              {(feed.markets || []).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <span className="rftPrice">{fmt(feed.currentPrice)}</span>
            <span className="rftMeta">{feed.market?.label || feed.symbol || "No market"}</span>
          </div>

          <div className="rftChartCard" ref={chartRef}>
            <svg className="rftChart" viewBox="0 0 900 340" preserveAspectRatio="none">
              {[.2,.4,.6,.8].map(r => <line key={r} x1="0" x2="900" y1={340*r} y2={340*r} className="rftGridLine" />)}
              {path && <path d={path} className="rftPriceLine" />}
              {analysis?.barrier && <line x1="0" x2="900" y1="170" y2="170" className="rftBarrier" />}
            </svg>
            <div className="rftChartOverlay">
              <span>EMA / MOMENTUM / RSI / VOLATILITY</span>
              <b>{analysis.signal || "WAIT"} {analysis.ready ? `${Number(analysis.confidence).toFixed(1)}%` : ""}</b>
            </div>
          </div>

          <div className="rftSignalRow">
            <article className={`rftSignal ${analysis.signal === "RISE" ? "active" : ""}`}>
              <span>RISE</span><strong>{Number(analysis.engines?.find(x => x.family === "RISE_FALL")?.probability || 0).toFixed(1)}%</strong>
            </article>
            <article className={`rftSignal ${analysis.signal === "FALL" ? "active" : ""}`}>
              <span>FALL</span><strong>{Number(analysis.engines?.find(x => x.family === "RISE_FALL")?.probability || 0).toFixed(1)}%</strong>
            </article>
            <article className={`rftSignal ${analysis.signal === "TOUCH" ? "active" : ""}`}>
              <span>TOUCH</span><strong>{Number(analysis.engines?.find(x => x.setup === "TOUCH")?.probability || 0).toFixed(1)}%</strong>
            </article>
            <article className={`rftSignal ${analysis.signal === "NO TOUCH" ? "active" : ""}`}>
              <span>NO TOUCH</span><strong>{Number(analysis.engines?.find(x => x.setup === "NO TOUCH")?.probability || 0).toFixed(1)}%</strong>
            </article>
          </div>

          <div className="rftEngineGrid">
            {(analysis.engines || []).map(engine => (
              <article key={engine.family} className="rftCard">
                <div className="rftCardTitle"><span>{engine.family.replaceAll("_", " ")}</span><b>{engine.setup}</b></div>
                <div className="rftScore">{Number(engine.score || 0).toFixed(1)}%</div>
                <p>{engine.reason}</p>
              </article>
            ))}
            <article className="rftCard">
              <div className="rftCardTitle"><span>MARKET METRICS</span><b>{analysis.ready ? "READY" : "CALIBRATING"}</b></div>
              <p>RSI {fmt(analysis.metrics?.rsi, 1)} · Vol {fmt(analysis.metrics?.volatility, 5)} · Z {fmt(analysis.metrics?.zScore, 2)}</p>
              <p>Samples {analysis.metrics?.samples || 0} · Current {fmt(analysis.metrics?.current)}</p>
            </article>
          </div>
        </main>

        <aside className="rftBot">
          <div className="rftBotHead">
            <div><span>DERIV BOT</span><strong>{botStatus}</strong></div>
            <div className={`rftBotDot ${botRunning ? "running" : ""}`} />
          </div>

          <div className="rftBotStats">
            <div><span>P/L</span><b className={sessionPnl >= 0 ? "positive" : "negative"}>{sessionPnl.toFixed(2)}</b></div>
            <div><span>WINS</span><b>{wins}</b></div>
            <div><span>LOSSES</span><b>{losses}</b></div>
            <div><span>TRADES</span><b>{tradeCount}</b></div>
          </div>

          <div className="rftControls">
            <label>Mode<select value={settings.mode} disabled={botRunning} onChange={e => update("mode", e.target.value)}>
              <option>AUTO</option><option>RISE</option><option>FALL</option><option>TOUCH</option><option>NO TOUCH</option>
            </select></label>
            <label>Stake<input type="number" min="0.35" step="0.01" value={settings.stake} disabled={botRunning} onChange={e => update("stake", e.target.value)} /></label>
            <label>Duration<input type="number" min="1" step="1" value={settings.duration} disabled={botRunning} onChange={e => update("duration", e.target.value)} /></label>
            <label>Min confidence<input type="number" min="50" max="99" value={settings.minConfidence} disabled={botRunning} onChange={e => update("minConfidence", e.target.value)} /></label>
            <label>Take profit<input type="number" min="0.1" step="0.1" value={settings.takeProfit} disabled={botRunning} onChange={e => update("takeProfit", e.target.value)} /></label>
            <label>Stop loss<input type="number" min="0.1" step="0.1" value={settings.stopLoss} disabled={botRunning} onChange={e => update("stopLoss", e.target.value)} /></label>
          </div>

          <div className="rftChat">
            {logs.length ? logs.map((item, i) => <div key={`${item.time}-${i}`} className={`rftChatLine ${item.type}`}><time>{item.time}</time><span>{item.message}</span></div>) : <div className="rftChatEmpty">Deriv bot chat will appear here…</div>}
          </div>

          <div className="rftBotActions">
            {!botRunning
              ? <button type="button" className="primary" onClick={startBot}>START CONTINUOUS BOT</button>
              : <button type="button" className="danger" onClick={stopBot}>STOP BOT</button>}
          </div>
          <div className="rftRealControl">
  <div className="rftAccountMode">
    <span>EXECUTION ACCOUNT</span>
    <b>
      {String(
        auth.selectedAccountType ||
        auth.selectedAccount?.type ||
        "NONE"
      ).toUpperCase()}
    </b>
  </div>

  {String(
    auth.selectedAccountType ||
    auth.selectedAccount?.type ||
    ""
  ).toLowerCase() === "real" ? (
    <label className="rftRealUnlock">
      <input
        type="checkbox"
        checked={realTradingUnlocked}
        onChange={(event) => {
          const enabled = event.target.checked;
          setRealTradingUnlocked(enabled);

          if (!enabled && botRunning) {
            setBotRunning(false);
            setBotStatus("REAL LOCKED");
            log("Real trading disabled. Bot stopped.", "system");
          }
        }}
      />
      <span>I understand this enables REAL-MONEY trading</span>
    </label>
  ) : (
    <div className="rftDemoNotice">
      Demo/VRTC execution is enabled.
    </div>
  )}

  <div className="rftExecutionNote">
    Real trading requires explicit unlock.
  </div>
</div>
        </aside>
      </div>
    </section>
  );
}




