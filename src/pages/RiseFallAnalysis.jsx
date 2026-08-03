
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

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent rfPage">
        <Topbar
          title="EdgePilot V55 · Rise/Fall Pro Analysis"
          subtitle="Standalone 15-second and 10-tick directional intelligence"
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
            value={
              active.ready ? "READY" : "WAIT"
            }
            note="Requires aligned indicators and non-ranging regime."
            tone={active.ready ? "ready" : ""}
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

        <div className="rfSafety">
          Analysis only. A high confidence score does not guarantee
          that the next price will rise or fall.
        </div>
      </main>
    </div>
  );
}
