import {
  useEffect,
  useMemo,
  useState,
} from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import SignalCard from "../components/SignalCard";
import MarketSelector from "../components/MarketSelector";
import ProfessionalDecisionPanel from "../components/ProfessionalDecisionPanel";

import useDerivTicks from "../hooks/useDerivTicks";

import {
  completeDerivLogin,
} from "../auth/derivOAuth";

import {
  analyzeMarket,
} from "../analysis/analysisEngine";

import {
  buildValidatedSignals,
} from "../analysis/backtestEngine";

import {
  buildEntryTiming,
} from "../analysis/entryTimingEngine";

import {
  buildProfessionalDecision,
} from "../analysis/professionalDecisionEngine";

import "../styles/AnalysisEngine.css";
import "../styles/ProfessionalDecision.css";
import BotDashboardCatalog from "../components/BotDashboardCatalog";

function buildPath(
  prices,
  width = 900,
  height = 320
) {
  if (
    !Array.isArray(prices) ||
    prices.length < 2
  ) {
    return "";
  }

  const visible = prices.slice(-120);

  const min = Math.min(...visible);
  const max = Math.max(...visible);
  const range = max - min || 1;

  return visible
    .map((price, index) => {
      const x =
        (index /
          Math.max(
            1,
            visible.length - 1
          )) *
        width;

      const y =
        height -
        ((price - min) / range) *
          (height - 24) -
        12;

      return `${
        index === 0 ? "M" : "L"
      } ${x.toFixed(2)} ${y.toFixed(
        2
      )}`;
    })
    .join(" ");
}

function Stat({ label, value }) {
  return (
    <div className="aiStat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function Dashboard() {
  const [
    oauthError,
    setOauthError,
  ] = useState("");

  const [
    completingOAuth,
    setCompletingOAuth,
  ] = useState(false);

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

  useEffect(() => {
    let cancelled = false;

    async function finishOAuthLogin() {
      const currentUrl = new URL(
        window.location.href
      );

      const hasCode =
        currentUrl.searchParams.has(
          "code"
        );

      const hasOAuthError =
        currentUrl.searchParams.has(
          "error"
        );

      if (
        !hasCode &&
        !hasOAuthError
      ) {
        return;
      }

      try {
        setCompletingOAuth(true);
        setOauthError("");

        const session =
          await completeDerivLogin();

        if (cancelled) {
          return;
        }

        if (session?.accessToken) {
          /*
           * completeDerivLogin removes
           * code and state from the URL
           * before this reload.
           */
          window.location.reload();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setOauthError(
          error instanceof Error
            ? error.message
            : "Unable to complete Deriv login."
        );
      } finally {
        if (!cancelled) {
          setCompletingOAuth(false);
        }
      }
    }

    finishOAuthLogin();

    return () => {
      cancelled = true;
    };
  }, []);

  const snapshot = useMemo(
    () => ({
      prices,
      currentPrice,
      lastDigit,
      digitHistory,
    }),
    [
      prices,
      currentPrice,
      lastDigit,
      digitHistory,
    ]
  );

  const analysis = useMemo(
    () => analyzeMarket(snapshot),
    [snapshot]
  );

  const validatedSignals =
    useMemo(
      () =>
        buildValidatedSignals(
          snapshot
        ),
      [snapshot]
    );

  const entryTiming = useMemo(
    () =>
      buildEntryTiming(
        validatedSignals,
        snapshot,
        {
          tradeTicks: 5,
          validitySeconds: 15,
        }
      ),
    [
      validatedSignals,
      snapshot,
    ]
  );

  const professionalDecision =
    useMemo(
      () =>
        buildProfessionalDecision(
          snapshot,
          validatedSignals
        ),
      [
        snapshot,
        validatedSignals,
      ]
    );

  const path = useMemo(
    () => buildPath(prices),
    [prices]
  );

  const connecting =
    status === "CONNECTING" ||
    loadingMarket;

  const displayPrice =
    Number.isFinite(currentPrice)
      ? currentPrice.toFixed(
          market.decimals
        )
      : "â€”";

  const signals = [
    {
      title: "Even / Odd",
      signal:
        analysis.signals.parity
          .signal,
      confidence:
        analysis.signals.parity
          .confidence,
      detail:
        analysis.signals.parity
          .detail,
    },
    {
      title: "Over / Under 2",
      signal:
        analysis.signals.threshold
          .signal,
      confidence:
        analysis.signals.threshold
          .confidence,
      detail:
        analysis.signals.threshold
          .detail,
    },
    {
      title: "Matches / Differs",
      signal:
        analysis.signals.matchDiff
          .signal,
      confidence:
        analysis.signals.matchDiff
          .confidence,
      detail:
        analysis.signals.matchDiff
          .detail,
    },
    {
      title: "Rise / Fall",
      signal:
        analysis.signals.riseFall
          .signal,
      confidence:
        analysis.signals.riseFall
          .confidence,
      detail:
        analysis.signals.riseFall
          .detail,
    },
  ];

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="Trading Dashboard"
          subtitle="Trend, momentum, range, volatility and historical validation"
          connected={connected}
          connecting={
            connecting ||
            completingOAuth
          }
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {completingOAuth ? (
          <div className="connectionError">
            Completing Deriv login.
            Please wait...
          </div>
        ) : null}

        {oauthError ? (
          <div className="connectionError">
            Deriv login failed:{" "}
            {oauthError}
          </div>
        ) : null}

        <section className="toolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={
              loadingMarket ||
              completingOAuth
            }
            onChange={changeSymbol}
          />

          <div
            className={
              connected
                ? "liveBadge connected"
                : "liveBadge"
            }
          >
            â—{" "}
            {connected
              ? "DERIV LIVE"
              : status}
          </div>
        </section>

        {statusDetail ? (
          <div className="connectionError">
            {statusDetail}
          </div>
        ) : null}

        <section className="signalGrid">
          {signals.map((item) => (
            <SignalCard
              key={item.title}
              {...item}
            />
          ))}
        </section>

        <section className="dashboardGrid">
          <article className="panel chartPanel">
            <div className="panelHeader">
              <div>
                <small>
                  {market.label.toUpperCase()}
                </small>

                <h2>
                  {displayPrice}
                </h2>
              </div>

              <span className="priceDigit">
                {lastDigit ?? "â€”"}
              </span>
            </div>

            <div className="demoChart liveChart">
              {path ? (
                <svg
                  viewBox="0 0 900 320"
                  preserveAspectRatio="none"
                >
                  <path
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="4"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              ) : (
                <div className="chartEmpty">
                  Connect Deriv and
                  wait for live ticks.
                </div>
              )}
            </div>

            <div className="digitStrip">
              {analysis.distribution.map(
                (item) => (
                  <div
                    className={
                      item.digit ===
                      lastDigit
                        ? "digitItem active"
                        : "digitItem"
                    }
                    key={item.digit}
                  >
                    <strong>
                      {item.digit}
                    </strong>

                    <small>
                      {item.percent.toFixed(
                        1
                      )}
                      %
                    </small>
                  </div>
                )
              )}
            </div>
          </article>

          <article className="panel">
            <h3>
              Professional Summary
            </h3>

            <div className="statsGrid">
              <Stat
                label="Final status"
                value={
                  professionalDecision.status
                }
              />

              <Stat
                label="Best setup"
                value={
                  professionalDecision.setup
                }
              />

              <Stat
                label="Confidence"
                value={`${professionalDecision.confidence.toFixed(
                  1
                )}%`}
              />

              <Stat
                label="Votes"
                value={`${professionalDecision.passedCount}/${professionalDecision.totalChecks}`}
              />

              <Stat
                label="Historical"
                value={`${validatedSignals.approvedCount} passed`}
              />

              <Stat
                label="Entry timing"
                value={
                  entryTiming.state
                }
              />
            </div>
          </article>
        </section>

        <ProfessionalDecisionPanel
          decision={
            professionalDecision
          }
        />

        <section
          className={
            professionalDecision.validated
              ? "finalProfessionalEntry valid"
              : "finalProfessionalEntry"
          }
        >
          <div>
            <small>
              FINAL SIGNAL
            </small>

            <h2>
              {professionalDecision.validated
                ? professionalDecision.setup
                : "NO TRADE"}
            </h2>

            <p>
              {professionalDecision.validated
                ? professionalDecision.reason
                : "The current evidence is not strong enough. Wait for a better setup."}
            </p>
          </div>

          <div className="finalProfessionalStats">
            <Stat
              label="Confidence"
              value={`${professionalDecision.confidence.toFixed(
                1
              )}%`}
            />

            <Stat
              label="Current digit"
              value={
                lastDigit ?? "â€”"
              }
            />

            <Stat
              label="Entry status"
              value={
                entryTiming.state
              }
            />

            <Stat
              label="Duration"
              value={
                entryTiming.tradeDuration
              }
            />
          </div>
        </section>
              <BotDashboardCatalog />
</main>
    </div>
  );
}
