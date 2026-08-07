import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import useDerivTicks from "../hooks/useDerivTicks";
import "./DerivAIAnalyzer.css";

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));

function pct(n) {
  return `${Number(n || 0).toFixed(1)}%`;
}

function digitCounts(history = []) {
  const arr = Array.isArray(history) ? history.map(Number).filter(Number.isFinite) : [];
  const counts = Array(10).fill(0);
  for (const d of arr) {
    if (d >= 0 && d <= 9) counts[d] += 1;
  }
  const total = arr.length || 1;
  return counts.map((count, digit) => ({
    digit,
    count,
    percent: (count / total) * 100,
  }));
}

function transitionMatrix(history = []) {
  const rows = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < history.length; i++) {
    const a = Number(history[i - 1]);
    const b = Number(history[i]);
    if (a >= 0 && a <= 9 && b >= 0 && b <= 9) rows[a][b] += 1;
  }
  return rows;
}

function entropyScore(distribution) {
  const probs = distribution.map((x) => x.percent / 100).filter((p) => p > 0);
  const h = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
  const max = Math.log2(10);
  return clamp((h / max) * 100);
}

function buildThresholdRows(history = []) {
  const arr = history.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 9);
  const short = arr.slice(-35);
  const long = arr.slice(-250);
  const sourceShort = short.length ? short : arr;
  const sourceLong = long.length ? long : arr;

  const calc = (type, barrier) => {
    const hit = (d) => type === "OVER" ? d > barrier : d < barrier;
    const s = sourceShort.length
      ? (sourceShort.filter(hit).length / sourceShort.length) * 100
      : 0;
    const l = sourceLong.length
      ? (sourceLong.filter(hit).length / sourceLong.length) * 100
      : 0;

    const recentWeight = sourceShort.length >= 12 ? 0.68 : 0.5;
    const score = clamp(s * recentWeight + l * (1 - recentWeight));
    return {
      key: `${type}-${barrier}`,
      type,
      barrier,
      score,
      shortRate: s,
      longRate: l,
    };
  };

  const over = Array.from({ length: 9 }, (_, i) => calc("OVER", i));
  const under = Array.from({ length: 9 }, (_, i) => calc("UNDER", i + 1));
  return { over, under };
}

function buildParity(history = []) {
  const arr = history.map(Number).filter(Number.isFinite);
  const recent = arr.slice(-120);
  const total = recent.length || 1;
  const even = recent.filter((d) => d % 2 === 0).length / total * 100;
  const odd = 100 - even;
  return { even, odd };
}

function useLearningMemory(symbol) {
  const key = `deriv-ai-analyzer-learning:${symbol || "default"}`;
  const [memory, setMemory] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(memory));
    } catch {}
  }, [key, memory]);

  return [memory, setMemory];
}

export default function DerivAIAnalyzer() {
  const deriv = useDerivTicks();
  const {
    markets = [],
    market = {},
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    prices = [],
    currentPrice,
    lastDigit,
    digitHistory = [],
    connect,
    disconnect,
    changeSymbol,
  } = deriv;

  const [autoFocus, setAutoFocus] = useState(true);
  const [memory, setMemory] = useLearningMemory(symbol);
  const lastTickRef = useRef(null);

  const history = useMemo(
    () => digitHistory.map(Number).filter((d) => Number.isFinite(d) && d >= 0 && d <= 9),
    [digitHistory]
  );

  const distribution = useMemo(() => digitCounts(history.slice(-300)), [history]);
  const thresholds = useMemo(() => buildThresholdRows(history), [history]);
  const parity = useMemo(() => buildParity(history), [history]);
  const transitions = useMemo(() => transitionMatrix(history.slice(-500)), [history]);
  const entropy = useMemo(() => entropyScore(distribution), [distribution]);

  const transitionBias = useMemo(() => {
    if (lastDigit == null) return { high: 50, low: 50, samples: 0 };
    const row = transitions[Number(lastDigit)] || [];
    const samples = row.reduce((a, b) => a + b, 0);
    if (!samples) return { high: 50, low: 50, samples: 0 };
    const high = row.slice(2).reduce((a, b) => a + b, 0) / samples * 100;
    const low = row.slice(0, 2).reduce((a, b) => a + b, 0) / samples * 100;
    return { high, low, samples };
  }, [lastDigit, transitions]);

  const contracts = useMemo(() => {
    const base = [...thresholds.over, ...thresholds.under].map((item) => {
      let adjusted = item.score;

      // Small adaptive component: if current digit is 0/1 and historical transitions
      // usually rebound upward, modestly raise OVER 1 confidence. Never force a signal.
      if (
        item.type === "OVER" &&
        item.barrier === 1 &&
        Number(lastDigit) <= 1 &&
        transitionBias.samples >= 5
      ) {
        adjusted = clamp(adjusted * 0.78 + transitionBias.high * 0.22);
      }

      const learned = memory[item.key];
      if (learned?.samples >= 5) {
        const observed = learned.wins / learned.samples * 100;
        adjusted = clamp(adjusted * 0.82 + observed * 0.18);
      }

      return { ...item, adjusted };
    });

    const extras = [
      { key: "EVEN", type: "EVEN", barrier: null, score: parity.even, adjusted: parity.even },
      { key: "ODD", type: "ODD", barrier: null, score: parity.odd, adjusted: parity.odd },
    ];

    return [...base, ...extras].sort((a, b) => b.adjusted - a.adjusted);
  }, [thresholds, parity, memory, lastDigit, transitionBias]);

  const best = contracts[0] || {
    key: "WAIT",
    type: "WAIT",
    barrier: null,
    adjusted: 0,
  };

  const confidence = best.adjusted || 0;
  const enoughData = history.length >= 35;
  const lowNoise = entropy < 98.5;
  const entryValid = connected && enoughData && confidence >= 76 && lowNoise;

  const entryLabel = best.barrier == null
    ? best.type
    : `${best.type} ${best.barrier}`;

  const regime = !enoughData
    ? "COLLECTING"
    : entropy > 98.5
      ? "HIGH NOISE"
      : confidence >= 80
        ? "FAVORABLE"
        : "MIXED";

  const momentum = useMemo(() => {
    const p = prices.slice(-20).map(Number).filter(Number.isFinite);
    if (p.length < 4) return "WAIT";
    const delta = p[p.length - 1] - p[0];
    if (Math.abs(delta) < 1e-9) return "FLAT";
    return delta > 0 ? "UP" : "DOWN";
  }, [prices]);

  // Local learning: score how the previous one-tick recommendation would have done.
  useEffect(() => {
    if (lastDigit == null || !connected || !enoughData) return;
    if (lastTickRef.current === lastDigit) return;
    lastTickRef.current = lastDigit;

    const previous = sessionStorage.getItem(`deriv-ai-last-signal:${symbol}`);
    if (previous) {
      try {
        const sig = JSON.parse(previous);
        const d = Number(lastDigit);
        let won = false;
        if (sig.type === "OVER") won = d > sig.barrier;
        if (sig.type === "UNDER") won = d < sig.barrier;
        if (sig.type === "EVEN") won = d % 2 === 0;
        if (sig.type === "ODD") won = d % 2 === 1;

        setMemory((old) => {
          const current = old[sig.key] || { samples: 0, wins: 0 };
          return {
            ...old,
            [sig.key]: {
              samples: current.samples + 1,
              wins: current.wins + (won ? 1 : 0),
            },
          };
        });
      } catch {}
    }

    if (confidence >= 65) {
      sessionStorage.setItem(
        `deriv-ai-last-signal:${symbol}`,
        JSON.stringify({
          key: best.key,
          type: best.type,
          barrier: best.barrier,
          confidence,
        })
      );
    }
  }, [
    lastDigit,
    connected,
    enoughData,
    symbol,
    best.key,
    best.type,
    best.barrier,
    confidence,
    setMemory,
  ]);

  const connecting = status === "CONNECTING" || loadingMarket;
  const displayPrice =
    Number.isFinite(Number(currentPrice)) && market?.decimals != null
      ? Number(currentPrice).toFixed(market.decimals)
      : "—";

  const recentDigits = history.slice(-24);

  const marketRows = useMemo(() => {
    // Current hook exposes one live stream at a time; do not fabricate scores
    // for markets that are not currently subscribed.
    return (markets || []).slice(0, 8).map((m) => ({
      ...m,
      active: m.symbol === symbol,
    }));
  }, [markets, symbol]);

  return (
    <div className="daaShell">
      <Sidebar />

      <main className="daaMain">
        <Topbar
          title="Deriv AI Analyzer"
          subtitle="Live market analysis only — manual execution on Deriv"
          connected={connected}
          connecting={connecting}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {statusDetail ? <div className="daaError">{statusDetail}</div> : null}

        <section className="daaToolbar">
          <div>
            <span className="daaKicker">ACTIVE MARKET</span>
            <select
              value={symbol || ""}
              disabled={loadingMarket}
              onChange={(e) => changeSymbol(e.target.value)}
            >
              {markets.map((m) => (
                <option key={m.symbol} value={m.symbol}>
                  {m.label || m.symbol}
                </option>
              ))}
            </select>
          </div>

          <div className={`daaLive ${connected ? "on" : ""}`}>
            <span />
            {connected ? "DERIV LIVE" : status}
          </div>

          <label className="daaToggle">
            <input
              type="checkbox"
              checked={autoFocus}
              onChange={(e) => setAutoFocus(e.target.checked)}
            />
            <span>Auto focus best setup</span>
          </label>
        </section>

        <section className="daaHeroGrid">
          <article className="daaCard daaBest">
            <span className="daaKicker">BEST SETUP</span>
            <h2>{enoughData ? entryLabel : "COLLECTING DATA"}</h2>
            <div className="daaBigNumber">{pct(confidence)}</div>
            <p>Adaptive score from recent hit-rate, longer history, transition behavior and local signal results.</p>
          </article>

          <article className={`daaCard daaEntry ${entryValid ? "valid" : ""}`}>
            <span className="daaKicker">ENTRY STATUS</span>
            <h2>{entryValid ? "ENTRY VALID" : enoughData ? "WAIT" : "LEARNING"}</h2>
            <div className={`daaOrb ${entryValid ? "blink" : ""}`}>
              {lastDigit ?? "—"}
            </div>
            <p>{entryValid ? "Green blink = current setup passed the configured filters." : "Signal has not passed all filters yet."}</p>
          </article>

          <article className="daaCard">
            <span className="daaKicker">CURRENT DIGIT</span>
            <div className="daaCurrentDigit">{lastDigit ?? "—"}</div>
            <div className="daaMiniRows">
              <span>Price <b>{displayPrice}</b></span>
              <span>Momentum <b>{momentum}</b></span>
              <span>Regime <b>{regime}</b></span>
            </div>
          </article>

          <article className="daaCard">
            <span className="daaKicker">MARKET QUALITY</span>
            <div className="daaCurrentDigit">{Math.round(clamp(100 - Math.max(0, entropy - 90) * 4))}</div>
            <div className="daaMiniRows">
              <span>Entropy <b>{entropy.toFixed(1)}</b></span>
              <span>Samples <b>{history.length}</b></span>
              <span>Transition samples <b>{transitionBias.samples}</b></span>
            </div>
          </article>
        </section>

        <section className="daaWorkspace">
          <article className="daaCard daaStreamCard">
            <div className="daaCardHead">
              <div>
                <span className="daaKicker">LIVE DIGITS</span>
                <h3>{market?.label || symbol || "Market"}</h3>
              </div>
              <strong>{displayPrice}</strong>
            </div>

            <div className="daaDigitStream">
              {recentDigits.length ? recentDigits.map((d, i) => (
                <span
                  className={i === recentDigits.length - 1 ? "active" : ""}
                  key={`${i}-${d}`}
                >
                  {d}
                </span>
              )) : <em>Waiting for live ticks…</em>}
            </div>

            <div className="daaDistribution">
              {distribution.map((d) => (
                <div key={d.digit} className={d.digit === Number(lastDigit) ? "hot" : ""}>
                  <span>{d.percent.toFixed(0)}%</span>
                  <i style={{ height: `${Math.max(4, d.percent * 4)}px` }} />
                  <b>{d.digit}</b>
                </div>
              ))}
            </div>
          </article>

          <article className="daaCard daaContractCard">
            <div className="daaCardHead">
              <div>
                <span className="daaKicker">CONTRACT ANALYZER</span>
                <h3>Over / Under</h3>
              </div>
              <strong>{entryValid ? "READY" : "SCANNING"}</strong>
            </div>

            <div className="daaContractColumns">
              <div>
                <h4>OVER</h4>
                {thresholds.over.map((row) => {
                  const adjusted = contracts.find((x) => x.key === row.key)?.adjusted ?? row.score;
                  const active = best.key === row.key;
                  return (
                    <div className={`daaContractRow ${active ? "active" : ""}`} key={row.key}>
                      <span>Over {row.barrier}</span>
                      <b>{pct(adjusted)}</b>
                    </div>
                  );
                })}
              </div>

              <div>
                <h4>UNDER</h4>
                {thresholds.under.map((row) => {
                  const adjusted = contracts.find((x) => x.key === row.key)?.adjusted ?? row.score;
                  const active = best.key === row.key;
                  return (
                    <div className={`daaContractRow ${active ? "active" : ""}`} key={row.key}>
                      <span>Under {row.barrier}</span>
                      <b>{pct(adjusted)}</b>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="daaParity">
              <div className={best.key === "EVEN" ? "active" : ""}>
                <span>EVEN</span><b>{pct(parity.even)}</b>
              </div>
              <div className={best.key === "ODD" ? "active" : ""}>
                <span>ODD</span><b>{pct(parity.odd)}</b>
              </div>
            </div>
          </article>

          <article className="daaCard daaLearningCard">
            <div className="daaCardHead">
              <div>
                <span className="daaKicker">AI LEARNING</span>
                <h3>Pattern & self-check</h3>
              </div>
              <strong>{Object.keys(memory).length} learned</strong>
            </div>

            <div className="daaInsightList">
              <div>
                <span>Low-digit rebound</span>
                <b>{pct(transitionBias.high)}</b>
              </div>
              <div>
                <span>Noise / entropy</span>
                <b>{entropy.toFixed(1)}</b>
              </div>
              <div>
                <span>Recent window</span>
                <b>{Math.min(history.length, 35)} ticks</b>
              </div>
              <div>
                <span>Long window</span>
                <b>{Math.min(history.length, 250)} ticks</b>
              </div>
            </div>

            <div className="daaReasonBox">
              <span className="daaKicker">WHY THIS SETUP</span>
              <p>
                {entryValid
                  ? `${entryLabel} currently has the strongest measured edge in the active stream. Confidence can fall immediately if recent behavior changes.`
                  : enoughData
                    ? `No setup has cleared the entry threshold. The analyzer keeps recalculating every incoming tick.`
                    : `Collecting at least 35 live digits before allowing a valid-entry alert.`}
              </p>
            </div>

            <button
              className="daaReset"
              onClick={() => setMemory({})}
              type="button"
            >
              Reset local learning
            </button>
          </article>

          <article className="daaCard daaMarketsCard">
            <div className="daaCardHead">
              <div>
                <span className="daaKicker">MARKETS</span>
                <h3>Available streams</h3>
              </div>
              <strong>{marketRows.length}</strong>
            </div>

            <div className="daaMarketList">
              {marketRows.map((m) => (
                <button
                  type="button"
                  key={m.symbol}
                  className={m.active ? "active" : ""}
                  onClick={() => changeSymbol(m.symbol)}
                  disabled={loadingMarket}
                >
                  <span>{m.label || m.symbol}</span>
                  <b>{m.active ? "LIVE" : "SCAN"}</b>
                </button>
              ))}
            </div>

            <p className="daaFootnote">
              This page does not fabricate rankings for markets that are not currently subscribed.
              Switch markets to analyze their real live stream.
            </p>
          </article>
        </section>

        <footer className="daaFooter">
          Analysis only. No orders are placed by this page. Confirm the setup yourself before trading on Deriv.
        </footer>
      </main>
    </div>
  );
}
