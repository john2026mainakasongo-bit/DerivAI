
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeRiseFall } from "../analysis/riseFallAnalysisEngine";
import "../styles/RiseFallAnalysis.css";

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function num(value, digits = 5) {
  return Number.isFinite(Number(value))
    ? Number(value).toFixed(digits)
    : "—";
}

function signalClass(value) {
  return String(value || "WAIT").toLowerCase();
}

function MiniChart({
  points = [],
  signal = "WAIT",
}) {
  const values = points
    .map((point) => Number(point.quote))
    .filter(Number.isFinite);

  if (values.length < 2) {
    return (
      <div className="rfEmptyChart">
        Waiting for live prices…
      </div>
    );
  }

  const width = 1000;
  const height = 280;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(0.00001, max - min);

  const coordinates = values
    .map((value, index) => {
      const x =
        (index /
          Math.max(1, values.length - 1)) *
        width;

      const y =
        height -
        ((value - min) / range) *
          (height - 30) -
        15;

      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className={`rfChart ${signalClass(signal)}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
      >
        <defs>
          <linearGradient
            id="rfFillV55"
            x1="0"
            x2="0"
            y1="0"
            y2="1"
          >
            <stop
              offset="0%"
              stopColor="currentColor"
              stopOpacity=".28"
            />
            <stop
              offset="100%"
              stopColor="currentColor"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        <polyline
          points={coordinates}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          vectorEffect="non-scaling-stroke"
        />

        <polygon
          points={`0,${height} ${coordinates} ${width},${height}`}
          fill="url(#rfFillV55)"
        />
      </svg>

      <span>{num(min)}</span>
      <span>{num(max)}</span>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  tone = "",
}) {
  return (
    <article className={`rfMetricCard ${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function ModeSummary({
  label,
  analysis,
  active,
  onClick,
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rfModeCard ${active ? "active" : ""} ${signalClass(
        analysis.signal
      )}`}
    >
      <small>{label}</small>
      <strong>{analysis.signal}</strong>
      <span>{pct(analysis.confidence)}</span>
      <em>{analysis.regime}</em>
    </button>
  );
}

export default function RiseFallAnalysis() {
  const {
    markets = [],
    market = null,
    symbol = "",
    connected = false,
    loadingMarket = false,
    prices = [],
    currentPrice = null,
    connect,
    disconnect,
    changeSymbol,
  } = useDerivTicks();

  const [mode, setMode] = useState("15s");
  const [feedMessage, setFeedMessage] = useState(
    "Connecting live feed…"
  );
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [signalLog, setSignalLog] = useState([]);
  const previousSignalRef = useRef("WAIT");
  const lastAlertAtRef = useRef(0);

  const connectingRef = useRef(false);

  useEffect(() => {
    if (
      connected ||
      connectingRef.current ||
      typeof connect !== "function"
    ) {
      return;
    }

    connectingRef.current = true;

    Promise.resolve(connect())
      .then(() =>
        setFeedMessage(
          "Deriv live feed requested."
        )
      )
      .catch((error) =>
        setFeedMessage(
          error instanceof Error
            ? error.message
            : "Feed connection failed."
        )
      )
      .finally(() => {
        connectingRef.current = false;
      });
  }, [connected, connect]);

  const analysis15 = useMemo(
    () => analyzeRiseFall(prices, "15s"),
    [prices]
  );

  const analysis10 = useMemo(
    () => analyzeRiseFall(prices, "10ticks"),
    [prices]
  );

  const active =
    mode === "15s" ? analysis15 : analysis10;

  const consensus =
    analysis15.signal !== "WAIT" &&
    analysis15.signal === analysis10.signal
      ? analysis15.signal
      : "WAIT";

  const consensusConfidence =
    consensus === "WAIT"
      ? Math.min(
          analysis15.confidence,
          analysis10.confidence
        )
      : (
          analysis15.confidence +
          analysis10.confidence
        ) / 2;


  function playSignalTone(signal) {
    if (!soundEnabled || typeof window === "undefined") return;

    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = signal === "RISE" ? "sine" : "triangle";
    oscillator.frequency.value = signal === "RISE" ? 880 : 430;

    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.18,
      context.currentTime + 0.02
    );
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      context.currentTime + 0.45
    );

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.48);

    oscillator.addEventListener("ended", () => {
      context.close().catch(() => {});
    });
  }

  useEffect(() => {
    const currentSignal = active.tradeNow ? active.signal : "WAIT";
    const previousSignal = previousSignalRef.current;
    const now = Date.now();

    if (
      currentSignal !== "WAIT" &&
      currentSignal !== previousSignal &&
      now - lastAlertAtRef.current > 3000
    ) {
      lastAlertAtRef.current = now;
      playSignalTone(currentSignal);

      setSignalLog((current) =>
        [
          {
            id: `${now}-${currentSignal}`,
            time: now,
            signal: currentSignal,
            mode,
            confidence: active.confidence,
            probability:
              currentSignal === "RISE"
                ? active.probabilityRise
                : active.probabilityFall,
            price: currentPrice,
            grade: active.setupGrade,
          },
          ...current,
        ].slice(0, 12)
      );
    }

    previousSignalRef.current = currentSignal;
  }, [
    active.signal,
    active.confidence,
    active.probabilityRise,
    active.probabilityFall,
    active.setupGrade,
    currentPrice,
    mode,
    soundEnabled,
  ]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent rfPage">
        <Topbar
          title="EdgePilot V58 · Rise/Fall Pro Analysis"
          subtitle="Professional Rise/Fall terminal with trend, pressure, reversal and quality scoring"
          connected={connected}
          connecting={false}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="rfToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket}
            onChange={changeSymbol}
          />

          <div className="rfToolbarActions">
            <button
              type="button"
              className={`rfSoundToggle ${soundEnabled ? "on" : "off"}`}
              onClick={() => setSoundEnabled((value) => !value)}
            >
              {soundEnabled ? "🔊 SOUND ON" : "🔇 SOUND OFF"}
            </button>

            <div className="rfModeSwitch">
            <button
              type="button"
              className={
                mode === "15s" ? "active" : ""
              }
              onClick={() => setMode("15s")}
            >
              15 SECONDS
            </button>

            <button
              type="button"
              className={
                mode === "10ticks" ? "active" : ""
              }
              onClick={() => setMode("10ticks")}
            >
              10 TICKS
            </button>
            </div>
          </div>
        </section>

        <div
          className={`rfFeed ${
            connected ? "live" : "waiting"
          }`}
        >
          {connected
            ? `LIVE FEED · ${
                market?.label || symbol
              }`
            : feedMessage}
        </div>

        <section
          className={`rfEntryBanner ${signalClass(active.signal)}`}
        >
          <div>
            <small>VISIBLE ENTRY ALERT</small>
            <strong>
              {active.decision || "NO TRADE"}
            </strong>
            <span>{active.reason}</span>
          </div>

          <div className="rfEntryBannerStats">
            <span>
              <small>Grade</small>
              <strong>{active.setupGrade || "WAIT"}</strong>
            </span>

            <span>
              <small>Confirmations</small>
              <strong>
                {active.confirmationsPassed || 0}/
                {active.confirmationChecks?.length || 8}
              </strong>
            </span>

            <span>
              <small>Direction probability</small>
              <strong>
                {active.rawDirection === "RISE"
                  ? pct(active.probabilityRise)
                  : active.rawDirection === "FALL"
                    ? pct(active.probabilityFall)
                    : "—"}
              </strong>
            </span>

            <span>
              <small>Duration</small>
              <strong>{active.duration}</strong>
            </span>
          </div>
        </section>

        <section className="rfFastDecisionRow">
          <article className={active.tradeNow ? "active trade" : ""}>
            <small>TRADE NOW</small>
            <strong>
              {active.tradeNow ? active.signal : "NO"}
            </strong>
            <span>
              {active.tradeNow
                ? `${pct(active.confidence)} confidence`
                : "Waiting for final alignment"}
            </span>
          </article>

          <article className={active.prepare ? "active prepare" : ""}>
            <small>PREPARE</small>
            <strong>
              {active.prepare
                ? active.rawDirection
                : "NO"}
            </strong>
            <span>
              {active.prepare
                ? "Signal is forming"
                : "No early setup"}
            </span>
          </article>

          <article className={!active.tradeNow && !active.prepare ? "active wait" : ""}>
            <small>NO TRADE</small>
            <strong>
              {!active.tradeNow && !active.prepare
                ? "WAIT"
                : "—"}
            </strong>
            <span>
              {!active.tradeNow && !active.prepare
                ? active.reason
                : "A directional setup exists"}
            </span>
          </article>
        </section>

        <section
          className={`rfHero ${signalClass(
            active.signal
          )}`}
        >
          <div className="rfHeroDecision">
            <small>
              ACTIVE{" "}
              {mode === "15s"
                ? "15-SECOND"
                : "10-TICK"}{" "}
              SIGNAL
            </small>

            <h1>{active.signal}</h1>
            <p>{active.reason}</p>

            <div className="rfDecisionChips">
              <span>{active.regime}</span>
              <span>{active.duration}</span>
              <span>{active.risk} RISK</span>
              <span>{active.breakout}</span>
              <span>{active.pullback}</span>
            </div>
          </div>

          <div className="rfProbabilityBlock">
            <div className="rfProbability rise">
              <small>RISE PROBABILITY</small>
              <strong>
                {pct(active.probabilityRise)}
              </strong>
              <i>
                <b
                  style={{
                    width: `${active.probabilityRise}%`,
                  }}
                />
              </i>
            </div>

            <div className="rfProbability fall">
              <small>FALL PROBABILITY</small>
              <strong>
                {pct(active.probabilityFall)}
              </strong>
              <i>
                <b
                  style={{
                    width: `${active.probabilityFall}%`,
                  }}
                />
              </i>
            </div>
          </div>

          <div className="rfHeroStats">
            <div>
              <small>Confidence</small>
              <strong>
                {pct(active.confidence)}
              </strong>
            </div>

            <div>
              <small>Votes</small>
              <strong>
                {active.riseVotes}/
                {active.fallVotes}
              </strong>
            </div>

            <div>
              <small>Samples</small>
              <strong>{active.samples || 0}</strong>
            </div>

            <div>
              <small>Price</small>
              <strong>{num(currentPrice)}</strong>
            </div>
          </div>
        </section>

        <section className="rfModeCards">
          <ModeSummary
            label="15 SECONDS"
            analysis={analysis15}
            active={mode === "15s"}
            onClick={() => setMode("15s")}
          />

          <ModeSummary
            label="10 TICKS"
            analysis={analysis10}
            active={mode === "10ticks"}
            onClick={() => setMode("10ticks")}
          />

          <article
            className={`rfConsensus ${signalClass(
              consensus
            )}`}
          >
            <small>CONSENSUS</small>
            <strong>{consensus}</strong>
            <span>{pct(consensusConfidence)}</span>
            <em>
              {consensus === "WAIT"
                ? "MIXED WINDOWS"
                : "BOTH WINDOWS ALIGNED"}
            </em>
          </article>
        </section>

        <section className="rfGrid">
          <article className="rfPanel rfChartPanel">
            <div className="rfPanelHead">
              <div>
                <small>PRICE ACTION</small>
                <h2>
                  {mode === "15s"
                    ? "Last 15 seconds"
                    : "Last 10 ticks"}
                </h2>
              </div>

              <span>
                {active.rawDirection || "WAIT"}
              </span>
            </div>

            <MiniChart
              points={active.points}
              signal={active.signal}
            />
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>INDICATOR STACK</small>
                <h2>Directional confirmation</h2>
              </div>
            </div>

            <div className="rfIndicatorStack">
              <div>
                <span>EMA 5</span>
                <strong>
                  {num(
                    active.indicators?.emaFast,
                    6
                  )}
                </strong>
              </div>

              <div>
                <span>EMA 9</span>
                <strong>
                  {num(
                    active.indicators?.emaSlow,
                    6
                  )}
                </strong>
              </div>

              <div>
                <span>RSI 9</span>
                <strong>
                  {Number(
                    active.indicators?.rsi || 0
                  ).toFixed(1)}
                </strong>
              </div>

              <div>
                <span>MACD</span>
                <strong>
                  {num(
                    active.indicators?.macd
                      ?.histogram,
                    7
                  )}
                </strong>
              </div>

              <div>
                <span>ATR</span>
                <strong>
                  {num(
                    active.indicators?.atr,
                    7
                  )}
                </strong>
              </div>

              <div>
                <span>Stochastic</span>
                <strong>
                  {Number(
                    active.indicators?.stochastic || 0
                  ).toFixed(1)}
                </strong>
              </div>

              <div>
                <span>ROC</span>
                <strong>
                  {num(active.indicators?.roc, 5)}
                </strong>
              </div>

              <div>
                <span>Z-score</span>
                <strong>
                  {num(active.indicators?.zScore, 3)}
                </strong>
              </div>

              <div>
                <span>Streak</span>
                <strong>
                  {active.streak?.direction || "FLAT"}{" "}
                  {active.streak?.length || 0}
                </strong>
              </div>

              <div>
                <span>Regime</span>
                <strong>{active.regime}</strong>
              </div>
            </div>
          </article>
        </section>

        <section className="rfMetrics">
          <MetricCard
            label="Net move"
            value={num(active.netMove, 6)}
            note="Difference between first and latest price."
          />

          <MetricCard
            label="Linear slope"
            value={num(active.slope, 7)}
            note="Overall direction of the selected window."
          />

          <MetricCard
            label="Consistency"
            value={pct(active.consistency)}
            note="Share of moves agreeing with one direction."
          />

          <MetricCard
            label="Volatility"
            value={num(active.volatility, 7)}
            note="Noise across the fresh price changes."
          />

          <MetricCard
            label="Reversals"
            value={active.reversalCount || 0}
            note="Direction changes reducing signal quality."
          />

          <MetricCard
            label="Decision"
            value={active.decision || "NO TRADE"}
            note="Fast decision updates on every fresh tick."
            tone={active.tradeNow ? "ready" : ""}
          />

          <MetricCard
            label="Support"
            value={num(
              active.supportResistance?.support,
              6
            )}
            note="Lowest recent price in the analysis window."
          />

          <MetricCard
            label="Resistance"
            value={num(
              active.supportResistance
                ?.resistance,
              6
            )}
            note="Highest recent price in the analysis window."
          />
        </section>

        <section className="rfGrid">
          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>MULTI-WINDOW MOMENTUM</small>
                <h2>Fast, medium and slow</h2>
              </div>
            </div>

            <div className="rfMomentum">
              <div>
                <span>Fast 3</span>
                <strong>
                  {num(
                    active.momentum?.fast,
                    6
                  )}
                </strong>
                <i
                  className={
                    Number(
                      active.momentum?.fast
                    ) >= 0
                      ? "up"
                      : "down"
                  }
                />
              </div>

              <div>
                <span>Medium 5</span>
                <strong>
                  {num(
                    active.momentum?.medium,
                    6
                  )}
                </strong>
                <i
                  className={
                    Number(
                      active.momentum?.medium
                    ) >= 0
                      ? "up"
                      : "down"
                  }
                />
              </div>

              <div>
                <span>Slow 10</span>
                <strong>
                  {num(
                    active.momentum?.slow,
                    6
                  )}
                </strong>
                <i
                  className={
                    Number(
                      active.momentum?.slow
                    ) >= 0
                      ? "up"
                      : "down"
                  }
                />
              </div>
            </div>

            <div className="rfVotes">
              <span>
                RISE votes{" "}
                <strong>
                  {active.riseVotes || 0}/
                  {active.totalVotes || 8}
                </strong>
              </span>

              <span>
                FALL votes{" "}
                <strong>
                  {active.fallVotes || 0}/
                  {active.totalVotes || 8}
                </strong>
              </span>
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>ENTRY CONDITIONS</small>
                <h2>What the engine sees</h2>
              </div>
            </div>

            <div className="rfConditionList">
              <div>
                <span>EMA direction</span>
                <strong>
                  {Number(
                    active.indicators?.emaFast
                  ) >
                  Number(
                    active.indicators?.emaSlow
                  )
                    ? "BULLISH"
                    : Number(
                          active.indicators
                            ?.emaFast
                        ) <
                        Number(
                          active.indicators
                            ?.emaSlow
                        )
                      ? "BEARISH"
                      : "FLAT"}
                </strong>
              </div>

              <div>
                <span>RSI state</span>
                <strong>
                  {Number(
                    active.indicators?.rsi
                  ) >= 55
                    ? "BULLISH"
                    : Number(
                          active.indicators
                            ?.rsi
                        ) <= 45
                      ? "BEARISH"
                      : "NEUTRAL"}
                </strong>
              </div>

              <div>
                <span>MACD state</span>
                <strong>
                  {Number(
                    active.indicators?.macd
                      ?.histogram
                  ) > 0
                    ? "POSITIVE"
                    : Number(
                          active.indicators
                            ?.macd?.histogram
                        ) < 0
                      ? "NEGATIVE"
                      : "FLAT"}
                </strong>
              </div>

              <div>
                <span>Breakout</span>
                <strong>{active.breakout}</strong>
              </div>

              <div>
                <span>Pullback</span>
                <strong>{active.pullback}</strong>
              </div>

              <div>
                <span>Recommended duration</span>
                <strong>{active.duration}</strong>
              </div>
            </div>
          </article>
        </section>

        <section className="rfGrid">
          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>ENTRY CONFIRMATIONS</small>
                <h2>Buy/Wait checklist</h2>
              </div>
              <span>
                {active.confirmationsPassed || 0}/
                {active.confirmationChecks?.length || 8}
              </span>
            </div>

            <div className="rfConfirmationList">
              {(active.confirmationChecks || []).map((check) => (
                <div
                  key={check.id}
                  className={check.passed ? "passed" : "failed"}
                >
                  <span>
                    {check.passed ? "✓" : "×"} {check.label}
                  </span>
                  <strong>{check.detail}</strong>
                </div>
              ))}
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>SESSION SIGNAL LOG</small>
                <h2>Recent visible/audio alerts</h2>
              </div>
              <button
                type="button"
                className="rfClearLog"
                onClick={() => setSignalLog([])}
              >
                Clear
              </button>
            </div>

            <div className="rfSignalLog">
              {signalLog.map((item) => (
                <div key={item.id} className={signalClass(item.signal)}>
                  <span>
                    {new Date(item.time).toLocaleTimeString()}
                  </span>
                  <strong>BUY {item.signal}</strong>
                  <em>{item.mode === "15s" ? "15 SEC" : "10 TICKS"}</em>
                  <b>{pct(item.confidence)}</b>
                  <small>Grade {item.grade}</small>
                </div>
              ))}

              {!signalLog.length ? (
                <p>No confirmed signal alerts in this session.</p>
              ) : null}
            </div>
          </article>
        </section>


        <section className="rfProGrid">
          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>MARKET PRESSURE</small>
                <h2>Buying vs selling pressure</h2>
              </div>
            </div>

            <div className="rfPressureBars">
              <div className="buy">
                <span>Buying pressure</span>
                <strong>{pct(active.pressure?.buying)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.pressure?.buying || 0}%`,
                    }}
                  />
                </i>
              </div>

              <div className="sell">
                <span>Selling pressure</span>
                <strong>{pct(active.pressure?.selling)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.pressure?.selling || 0}%`,
                    }}
                  />
                </i>
              </div>
            </div>

            <div className="rfConditionList">
              <div>
                <span>Trend age</span>
                <strong>
                  {active.trend?.direction || "FLAT"}{" "}
                  {active.trend?.ticks || 0} ticks
                </strong>
              </div>

              <div>
                <span>Continuation probability</span>
                <strong>
                  {pct(active.continuationProbability)}
                </strong>
              </div>

              <div>
                <span>Reversal probability</span>
                <strong>
                  {pct(active.reversalProbability)}
                </strong>
              </div>
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>BOLLINGER & BREAKOUT</small>
                <h2>Range and breakout quality</h2>
              </div>
            </div>

            <div className="rfConditionList">
              <div>
                <span>Bollinger position</span>
                <strong>{active.bollinger?.position || "MIDDLE"}</strong>
              </div>

              <div>
                <span>Upper band</span>
                <strong>{num(active.bollinger?.upper, 6)}</strong>
              </div>

              <div>
                <span>Middle band</span>
                <strong>{num(active.bollinger?.middle, 6)}</strong>
              </div>

              <div>
                <span>Lower band</span>
                <strong>{num(active.bollinger?.lower, 6)}</strong>
              </div>

              <div>
                <span>Fake breakout probability</span>
                <strong>{pct(active.breakoutFakeProbability)}</strong>
              </div>
            </div>
          </article>

          <article className="rfPanel">
            <div className="rfPanelHead">
              <div>
                <small>LEVEL STRENGTH</small>
                <h2>Support and resistance tests</h2>
              </div>
            </div>

            <div className="rfStrengthMeters">
              <div>
                <span>Support strength</span>
                <strong>{pct(active.supportStrength)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.supportStrength || 0}%`,
                    }}
                  />
                </i>
              </div>

              <div>
                <span>Resistance strength</span>
                <strong>{pct(active.resistanceStrength)}</strong>
                <i>
                  <b
                    style={{
                      width: `${active.resistanceStrength || 0}%`,
                    }}
                  />
                </i>
              </div>
            </div>
          </article>
        </section>

        <section className="rfScoreTerminal">
          <div className="rfPanelHead">
            <div>
              <small>SMART SCORE TERMINAL</small>
              <h2>Final analysis quality</h2>
            </div>

            <span className="rfFinalGrade">
              Grade {active.setupGrade || "WAIT"}
            </span>
          </div>

          <div className="rfScoreGrid">
            {[
              ["Trend", active.scores?.trend],
              ["Pattern", active.scores?.pattern],
              ["Momentum", active.scores?.momentum],
              ["Volatility", active.scores?.volatility],
              ["Quality", active.scores?.quality],
              ["Final score", active.scores?.final],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{Number(value || 0).toFixed(0)}</strong>
                <i>
                  <b
                    style={{
                      width: `${Math.max(0, Math.min(100, Number(value || 0)))}%`,
                    }}
                  />
                </i>
              </div>
            ))}
          </div>
        </section>

        <div className="rfSafety">
          Analysis only. A high confidence score does not guarantee
          that the next price will rise or fall.
        </div>
      </main>
    </div>
  );
}
