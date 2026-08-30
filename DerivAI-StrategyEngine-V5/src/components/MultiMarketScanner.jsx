import { useEffect, useMemo, useRef, useState } from "react";
import "./MultiMarketScanner.css";

const APP_ID = 1089;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, Number(n) || 0));

function marketName(symbol, fallback = "") {
  const exact = {
    "1HZ10V": "Volatility 10 (1s) Index",
    "1HZ15V": "Volatility 15 (1s) Index",
    "1HZ25V": "Volatility 25 (1s) Index",
    "1HZ30V": "Volatility 30 (1s) Index",
    "1HZ50V": "Volatility 50 (1s) Index",
    "1HZ75V": "Volatility 75 (1s) Index",
    "1HZ90V": "Volatility 90 (1s) Index",
    "1HZ100V": "Volatility 100 (1s) Index",
    "R_10": "Volatility 10 Index",
    "R_25": "Volatility 25 Index",
    "R_50": "Volatility 50 Index",
    "R_75": "Volatility 75 Index",
    "R_100": "Volatility 100 Index",
  };
  if (exact[symbol]) return exact[symbol];
  const one = String(symbol || "").match(/^1HZ(\d+)V$/i);
  if (one) return `Volatility ${one[1]} (1s) Index`;
  const normal = String(symbol || "").match(/^R_(\d+)$/i);
  if (normal) return `Volatility ${normal[1]} Index`;
  return fallback || symbol || "Deriv Market";
}

function avg(a = []) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function sd(a = []) {
  if (a.length < 2) return 0;
  const m = avg(a);
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)));
}

function slope(a = []) {
  return a.length >= 2 ? a[a.length - 1] - a[0] : 0;
}

function sgn(n) {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function analyze(prices = [], barrierSigma = 1.5) {
  const p = prices.map(Number).filter(Number.isFinite);
  if (p.length < 8) {
    return {
      mode: "LEARNING",
      signal: "WAIT",
      confidence: 0,
      trend: 0,
      momentum: 0,
      volatility: 0,
      pattern: 0,
      transition: 0,
      samples: p.length,
    };
  }

  const short = p.slice(-12);
  const medium = p.slice(-35);
  const long = p.slice(-80);
  const ds = short.slice(1).map((x, i) => x - short[i]);
  const abs = avg(ds.map(Math.abs)) || 1e-9;
  const sig = sd(ds);

  const ss = slope(short);
  const sm = slope(medium);
  const sl = slope(long);
  const align = sgn(ss) * 0.5 + sgn(sm) * 0.3 + sgn(sl) * 0.2;

  const nonzero = ds.filter((d) => d !== 0);
  const same = nonzero.filter((d) => sgn(d) === sgn(ss)).length;

  const trend = clamp(Math.abs(align) * 100);
  const momentum = clamp((Math.abs(ss) / (abs * Math.max(1, short.length - 1))) * 100);
  const volatility = clamp(100 - Math.min(100, (sig / abs) * 32));
  const pattern = clamp(nonzero.length ? (same / nonzero.length) * 100 : 0);
  const last5 = ds.slice(-5);
  const transition = clamp(last5.length ? (last5.filter((d) => sgn(d) === sgn(ss)).length / last5.length) * 100 : 0);

  const rfConfidence = clamp(
    trend * 0.28 +
    momentum * 0.20 +
    volatility * 0.12 +
    pattern * 0.24 +
    transition * 0.16
  );

  const rfSignal = rfConfidence >= 66
    ? align > 0 ? "RISE" : align < 0 ? "FALL" : "WAIT"
    : "WAIT";

  const current = p[p.length - 1];
  const recent = p.slice(-60);
  const rd = recent.slice(1).map((x, i) => x - recent[i]);
  const rs = sd(rd);
  const distance = Math.max(rs * Number(barrierSigma || 1.5), Math.abs(current) * 0.00001);
  const expected = rs * Math.sqrt(Math.max(1, recent.length));
  const range = Math.max(...recent) - Math.min(...recent);
  const touch = clamp((distance > 0 ? expected / distance : 0) * 54 + Math.min(1.5, distance > 0 ? range / distance : 0) * 20);
  const noTouch = clamp(100 - touch);
  const tntConfidence = Math.max(touch, noTouch);
  const tntSignal = tntConfidence >= 62 ? (touch > noTouch ? "TOUCH" : "NO TOUCH") : "WAIT";

  const useRF = rfConfidence >= tntConfidence;

  return {
    mode: useRF ? "RISE/FALL" : "TOUCH/NO TOUCH",
    signal: useRF ? rfSignal : tntSignal,
    confidence: useRF ? rfConfidence : tntConfidence,
    trend,
    momentum,
    volatility,
    pattern,
    transition,
    samples: p.length,
  };
}

function quality(score) {
  if (score >= 85) return "EXCELLENT";
  if (score >= 76) return "GOOD";
  if (score >= 66) return "MEDIUM";
  return "POOR";
}

export default function MultiMarketScanner({
  markets = [],
  activeSymbol,
  changeSymbol,
  connected,
  barrierDistance = 1.5,
}) {
  const histories = useRef({});
  const wsRef = useRef(null);
  const lastSwitch = useRef(0);
  const [rows, setRows] = useState({});
  const [status, setStatus] = useState("OFFLINE");
  const [autoBest, setAutoBest] = useState(false);
  const [events, setEvents] = useState([]);
  const [quotesSeen, setQuotesSeen] = useState(0);

  useEffect(() => {
    if (!connected || !markets.length) {
      setStatus("OFFLINE");
      return;
    }

    const list = markets
      .map((m) => ({ ...m, id: m.symbol || m.id }))
      .filter((m) => /^R_\d+$/i.test(m.id) || /^1HZ\d+V$/i.test(m.id))
      .slice(0, 16);

    if (!list.length) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    histories.current = {};
    setRows({});
    setStatus("CONNECTING");

    ws.onopen = () => {
      setStatus("LIVE");
      list.forEach((m) => {
        histories.current[m.id] = [];
        ws.send(JSON.stringify({ ticks: m.id, subscribe: 1 }));
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (!msg?.tick) return;

        const id = msg.tick.symbol || msg.tick.underlying_symbol || msg.echo_req?.ticks;
        const quote = Number(msg.tick.quote);
        if (!id || !Number.isFinite(quote)) return;

        const old = histories.current[id] || [];
        const next = [...old.slice(-79), quote];
        histories.current[id] = next;
        const result = analyze(next, barrierDistance);
        setQuotesSeen((n) => n + 1);

        setRows((prev) => ({
          ...prev,
          [id]: {
            ...result,
            symbol: id,
            label: marketName(id, list.find((m) => m.id === id)?.label),
            updatedAt: Date.now(),
          },
        }));

        if (result.samples >= 12 && result.signal !== "WAIT" && result.confidence >= 76) {
          setEvents((prev) => {
            const latest = prev[0];
            if (latest && latest.symbol === id && latest.signal === result.signal && Date.now() - latest.ts < 5000) return prev;
            return [{
              ts: Date.now(),
              symbol: id,
              market: marketName(id),
              signal: result.signal,
              confidence: result.confidence,
            }, ...prev].slice(0, 8);
          });
        }
      } catch {}
    };

    ws.onerror = () => setStatus("ERROR");
    ws.onclose = () => setStatus("OFFLINE");

    const ping = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);

    return () => {
      window.clearInterval(ping);
      try { ws.close(); } catch {}
    };
  }, [connected, markets, barrierDistance]);

  const ranked = useMemo(
    () => Object.values(rows)
      .filter((r) => r.samples >= 8)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8),
    [rows]
  );

  const best = ranked[0] || null;

  useEffect(() => {
    if (!autoBest || !best || !connected || best.symbol === activeSymbol || best.confidence < 76) return;
    const now = Date.now();
    if (now - lastSwitch.current < 8000) return;
    lastSwitch.current = now;
    changeSymbol(best.symbol);
  }, [autoBest, best, connected, activeSymbol, changeSymbol]);

  const checks = best ? [
    ["Trend", best.trend],
    ["Momentum", best.momentum],
    ["Volatility", best.volatility],
    ["Pattern", best.pattern],
    ["Transition", best.transition],
  ] : [];

  return (
    <section className="mmScanner">
      <div className="mmTop">
        <div>
          <span>MULTI-MARKET AI SCANNER</span>
          <h3>Best Market Now</h3>
        </div>

        <label className="mmAuto">
          <input type="checkbox" checked={autoBest} onChange={(e) => setAutoBest(e.target.checked)} />
          <b>AUTO BEST MARKET</b>
        </label>

        <div className={`mmStatus ${status === "LIVE" ? "live" : ""}`}>{status}</div>
      </div>

      <div className="mmBestRow">
        <article className="mmBestCard">
          <span>BEST MARKET NOW</span>
          <h2>{best?.label || "SCANNING..."}</h2>
          <div>
            <strong className={(best?.signal || "wait").toLowerCase().replace(/\s+/g, "-")}>{best?.signal || "WAIT"}</strong>
            <b>{best ? `${best.confidence.toFixed(1)}%` : "—"}</b>
          </div>
          <small>{best ? `${best.mode} · ${quality(best.confidence)}` : "Collecting live samples"}</small>
        </article>

        <article className="mmBreakdown">
          <span>CONFIDENCE BREAKDOWN</span>
          {checks.length ? checks.map(([label, value]) => (
            <div key={label}>
              <em>{label}</em>
              <i><b style={{ width: `${value}%` }} /></i>
              <strong>{value.toFixed(0)}%</strong>
            </div>
          )) : <p>Waiting for enough samples...</p>}
        </article>

        <article className="mmChecklist">
          <span>ENTRY CHECKLIST</span>
          {checks.length ? checks.map(([label, value]) => {
            const pass = value >= (label === "Volatility" ? 45 : 55);
            return (
              <div key={label} className={pass ? "pass" : "wait"}>
                <b>{pass ? "✓" : "×"}</b>
                <em>{label}</em>
                <strong>{pass ? "PASS" : "WAIT"}</strong>
              </div>
            );
          }) : <p>Scanning...</p>}
        </article>
      </div>

      <div className="mmRanking">
        {ranked.length ? ranked.map((row, index) => (
          <button
            type="button"
            key={row.symbol}
            className={`${row.symbol === activeSymbol ? "active" : ""} ${index === 0 ? "best" : ""}`}
            onClick={() => changeSymbol(row.symbol)}
          >
            <span className="mmRank">{index + 1}</span>
            <span className="mmMarket">{row.label}</span>
            <span className={`mmSignal ${row.signal.toLowerCase().replace(/\s+/g, "-")}`}>{row.signal}</span>
            <b>{row.confidence.toFixed(1)}%</b>
          </button>
        )) : <p className="mmEmpty">Collecting samples across volatility markets...</p>}
      </div>

      <div className="mmBottom">
        <article>
          <span>AI LEARNING</span>
          <div><em>Observed quotes</em><b>{quotesSeen}</b></div>
          <div><em>Markets ready</em><b>{ranked.length}</b></div>
          <div><em>Valid detections</em><b>{events.length}</b></div>
          <div><em>Scanner status</em><b>{status}</b></div>
        </article>

        <article>
          <span>RECENT SIGNALS</span>
          {events.length ? events.slice(0, 5).map((e) => (
            <div key={`${e.ts}-${e.symbol}`}>
              <em>{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</em>
              <b>{e.market}</b>
              <strong className={e.signal.toLowerCase().replace(/\s+/g, "-")}>{e.signal}</strong>
              <i>{e.confidence.toFixed(0)}%</i>
            </div>
          )) : <p>No valid detections yet.</p>}
        </article>
      </div>
    </section>
  );
}
