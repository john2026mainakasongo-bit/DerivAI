import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";
import { analyzeFreshEdge } from "../analysis/freshEdgeEngine";
import "../styles/FreshEdgeBot.css";
import "../styles/FreshEdgeBot.V9.css";

const STORAGE_KEY = "fresh-edge-ai-v9";
const MARKET_MEMORY_KEY = "fresh-edge-ai-v9-market-memory";

const INITIAL_STATS = {
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  history: [],
};

const INITIAL_SETTINGS = {
  stake: 0.35,
  duration: 20,
  durationUnit: "s",
  minimumTicks: 12,
  minimumConfidence: 69,
  minimumQuality: 60,
  minimumVotes: 62,
  minimumContinuation: 65,
  maximumNoise: 60,
  maximumReversal: 50,
  maximumSpikeRatio: 6,
  confirmationTicks: 2,
  marketVisitSeconds: 12,
  highRiskExitSeconds: 6,
  idleWatchdogSeconds: 45,
  postSettlementDelayMs: 350,
  maximumOpenTrades: 1,
  takeProfit: 2,
  stopLoss: 1.4,
  memoryFreshnessSeconds: 180,
};

function contractIdOf(value) {
  return String(
    value?.contractId ||
      value?.contract_id ||
      value?.buy?.contract_id ||
      value?.raw?.buy?.contract_id ||
      ""
  );
}

function contractKey(contract) {
  return String(
    contract?.contract_id ||
      contract?.contractId ||
      contract?.id ||
      ""
  );
}

function isSettled(contract) {
  return (
    contract?.is_sold === true ||
    contract?.is_sold === 1 ||
    contract?.is_expired === true ||
    contract?.is_expired === 1 ||
    ["WON", "LOST", "SOLD"].includes(
      String(contract?.status || "").toUpperCase()
    )
  );
}

function resultOf(contract) {
  const status = String(contract?.status || "").toUpperCase();
  const profit = Number(contract?.profit || 0);

  if (status === "WON" || profit > 0) return "WON";
  if (status === "LOST" || profit < 0) return "LOST";
  return profit >= 0 ? "WON" : "LOST";
}

function profitOf(contract, fallbackStake = 0.35) {
  const direct = Number(contract?.profit);
  if (Number.isFinite(direct)) return direct;

  const payout = Number(contract?.payout || 0);
  const buyPrice = Number(
    contract?.buy_price ||
      contract?.purchase_price ||
      fallbackStake
  );

  return payout - buyPrice;
}

function readStorage(key, fallback) {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(key) || "null"
    );
    return parsed || fallback;
  } catch {
    return fallback;
  }
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function scoreAnalysis(analysis) {
  return (
    safeNumber(analysis?.confidence) * 0.34 +
    safeNumber(analysis?.quality) * 0.24 +
    safeNumber(analysis?.voteConsensus) * 0.16 +
    safeNumber(analysis?.continuation) * 0.18 +
    Math.max(0, 100 - safeNumber(analysis?.noise, 100)) *
      0.04 +
    Math.max(
      0,
      100 - safeNumber(analysis?.reversalRisk, 100)
    ) *
      0.04
  );
}

function qualifies(analysis, settings) {
  return Boolean(
    analysis?.ready &&
      analysis?.decision === "BUY" &&
      analysis?.direction &&
      analysis.direction !== "WAIT" &&
      safeNumber(analysis.confidence) >=
        safeNumber(settings.minimumConfidence) &&
      safeNumber(analysis.quality) >=
        safeNumber(settings.minimumQuality) &&
      safeNumber(analysis.voteConsensus) >=
        safeNumber(settings.minimumVotes) &&
      safeNumber(analysis.continuation) >=
        safeNumber(settings.minimumContinuation) &&
      safeNumber(analysis.noise, 100) <=
        safeNumber(settings.maximumNoise) &&
      safeNumber(analysis.reversalRisk, 100) <=
        safeNumber(settings.maximumReversal) &&
      safeNumber(analysis.spikeRatio, 100) <=
        safeNumber(settings.maximumSpikeRatio)
  );
}

function diagnoseTrade(trade, result) {
  if (result === "WON") {
    return "Setup held through expiry.";
  }

  if (safeNumber(trade?.spikeRatio) >= 4.5) {
    return "A tick spike weakened the expiry timing.";
  }

  if (safeNumber(trade?.reversalRisk) >= 58) {
    return "Reversal pressure was elevated at entry.";
  }

  if (safeNumber(trade?.noise) >= 68) {
    return "Noise disrupted the short expiry.";
  }

  return "Short-term expiry variance beat the setup.";
}

export default function FreshEdgeBot() {
  const {
    markets,
    market,
    symbol,
    connected,
    authenticatedFeed,
    loadingMarket,
    prices,
    currentPrice,
    openContracts,
    tradeBusy,
    tradeError,
    connect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("STOPPED");
  const [message, setMessage] = useState(
    "FreshEdge V9 is ready."
  );
  const [settings, setSettings] = useState(
    INITIAL_SETTINGS
  );
  const [stats, setStats] = useState(() =>
    readStorage(STORAGE_KEY, INITIAL_STATS)
  );
  const [marketMemory, setMarketMemory] = useState(() =>
    readStorage(MARKET_MEMORY_KEY, {})
  );
  const [confirmation, setConfirmation] = useState({
    key: "",
    ticks: 0,
  });
  const [marketStartedAt, setMarketStartedAt] = useState(
    Date.now()
  );
  const [lastEntryAt, setLastEntryAt] = useState(Date.now());

  const buyingRef = useRef(false);
  const switchingRef = useRef(false);
  const processedRef = useRef(new Set());
  const botContractsRef = useRef(new Map());
  const runningRef = useRef(false);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(stats)
      );
    } catch {
      // Storage can be unavailable.
    }
  }, [stats]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MARKET_MEMORY_KEY,
        JSON.stringify(marketMemory)
      );
    } catch {
      // Storage can be unavailable.
    }
  }, [marketMemory]);

  useEffect(() => {
    if (!connected) {
      void connect().catch((error) => {
        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to connect."
        );
      });
    }
  }, [connected, connect]);

  const analysis = useMemo(
    () =>
      analyzeFreshEdge(prices, settings, {
        totalTrades: stats.runs,
        winRate: stats.runs
          ? (stats.wins / stats.runs) * 100
          : 50,
      }),
    [prices, settings, stats.runs, stats.wins]
  );

  const activeBotTrades = useMemo(
    () =>
      openContracts.filter((contract) =>
        botContractsRef.current.has(contractKey(contract))
      ),
    [openContracts]
  );

  const sessionStopped =
    stats.profit >= safeNumber(settings.takeProfit) ||
    stats.profit <=
      -Math.abs(safeNumber(settings.stopLoss));

  const currentQualified = useMemo(
    () => qualifies(analysis, settings),
    [analysis, settings]
  );

  const rankedMarkets = useMemo(() => {
    const freshness =
      safeNumber(settings.memoryFreshnessSeconds, 180) *
      1000;
    const now = Date.now();

    return Object.values(marketMemory)
      .filter(
        (row) =>
          row?.symbol &&
          now - safeNumber(row.updatedAt) <= freshness
      )
      .sort(
        (a, b) =>
          safeNumber(b.score) - safeNumber(a.score)
      );
  }, [
    marketMemory,
    settings.memoryFreshnessSeconds,
    currentPrice,
  ]);

  useEffect(() => {
    if (!symbol || !analysis.ready) return;

    const row = {
      symbol,
      label: market?.label || symbol,
      score: scoreAnalysis(analysis),
      qualified: qualifies(analysis, settings),
      direction: analysis.direction || "WAIT",
      confidence: safeNumber(analysis.confidence),
      quality: safeNumber(analysis.quality),
      votes: safeNumber(analysis.voteConsensus),
      continuation: safeNumber(analysis.continuation),
      noise: safeNumber(analysis.noise),
      reversal: safeNumber(analysis.reversalRisk),
      spikeRatio: safeNumber(analysis.spikeRatio),
      updatedAt: Date.now(),
    };

    setMarketMemory((current) => ({
      ...current,
      [symbol]: row,
    }));
  }, [
    symbol,
    market?.label,
    analysis.ready,
    analysis.direction,
    analysis.confidence,
    analysis.quality,
    analysis.voteConsensus,
    analysis.continuation,
    analysis.noise,
    analysis.reversalRisk,
    analysis.spikeRatio,
    settings,
  ]);

  const chooseNextMarket = useCallback(() => {
    if (!Array.isArray(markets) || markets.length < 2) {
      return "";
    }

    const cached = rankedMarkets.find(
      (row) => row.symbol !== symbol
    );

    if (cached?.symbol) return cached.symbol;

    const index = Math.max(
      0,
      markets.findIndex((item) => item.id === symbol)
    );

    return markets[(index + 1) % markets.length]?.id || "";
  }, [markets, rankedMarkets, symbol]);

  const rotateMarket = useCallback(
    async (reason) => {
      if (
        switchingRef.current ||
        loadingMarket ||
        activeBotTrades.length > 0
      ) {
        return;
      }

      const nextSymbol = chooseNextMarket();

      if (!nextSymbol || nextSymbol === symbol) return;

      switchingRef.current = true;
      setPhase("SWITCHING");
      setMessage(reason);
      setConfirmation({ key: "", ticks: 0 });

      try {
        await changeSymbol(nextSymbol);
        setMarketStartedAt(Date.now());
        setPhase("SCANNING");
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Market switch failed."
        );
      } finally {
        window.setTimeout(() => {
          switchingRef.current = false;
        }, 500);
      }
    },
    [
      loadingMarket,
      activeBotTrades.length,
      chooseNextMarket,
      symbol,
      changeSymbol,
    ]
  );

  useEffect(() => {
    if (
      !running ||
      sessionStopped ||
      activeBotTrades.length > 0 ||
      tradeBusy ||
      buyingRef.current
    ) {
      return;
    }

    setPhase(
      currentQualified ? "CONFIRMING" : "SCANNING"
    );

    if (!currentQualified) {
      setConfirmation({ key: "", ticks: 0 });
      return;
    }

    const key = [
      symbol,
      analysis.direction,
      Math.round(safeNumber(analysis.confidence)),
      Math.round(safeNumber(analysis.quality)),
    ].join("|");

    setConfirmation((current) => ({
      key,
      ticks:
        current.key === key
          ? Math.min(
              safeNumber(settings.confirmationTicks, 2),
              safeNumber(current.ticks) + 1
            )
          : 1,
    }));
  }, [
    running,
    sessionStopped,
    activeBotTrades.length,
    tradeBusy,
    currentQualified,
    currentPrice,
    symbol,
    analysis.direction,
    analysis.confidence,
    analysis.quality,
    settings.confirmationTicks,
  ]);

  useEffect(() => {
    if (
      !running ||
      sessionStopped ||
      activeBotTrades.length > 0 ||
      tradeBusy ||
      buyingRef.current ||
      switchingRef.current
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      const now = Date.now();
      const visitSeconds =
        (now - marketStartedAt) / 1000;
      const idleSeconds =
        (now - lastEntryAt) / 1000;

      const highRisk =
        safeNumber(analysis.noise, 100) >
          safeNumber(settings.maximumNoise) ||
        safeNumber(analysis.reversalRisk, 100) >
          safeNumber(settings.maximumReversal) ||
        safeNumber(analysis.spikeRatio, 100) >
          safeNumber(settings.maximumSpikeRatio);

      if (
        highRisk &&
        visitSeconds >=
          safeNumber(settings.highRiskExitSeconds, 6)
      ) {
        void rotateMarket(
          `${market?.label || symbol} remained high-risk. Scanning another market.`
        );
        return;
      }

      if (
        visitSeconds >=
        safeNumber(settings.marketVisitSeconds, 12)
      ) {
        void rotateMarket(
          `No confirmed entry on ${market?.label || symbol}. Moving to the next ranked market.`
        );
        return;
      }

      if (
        idleSeconds >=
        safeNumber(settings.idleWatchdogSeconds, 45)
      ) {
        buyingRef.current = false;
        switchingRef.current = false;
        setConfirmation({ key: "", ticks: 0 });
        setLastEntryAt(Date.now());
        void rotateMarket(
          "Idle watchdog reset the scanner and refreshed the portfolio."
        );
      }
    }, 500);

    return () => window.clearInterval(timer);
  }, [
    running,
    sessionStopped,
    activeBotTrades.length,
    tradeBusy,
    marketStartedAt,
    lastEntryAt,
    analysis.noise,
    analysis.reversalRisk,
    analysis.spikeRatio,
    settings.maximumNoise,
    settings.maximumReversal,
    settings.maximumSpikeRatio,
    settings.highRiskExitSeconds,
    settings.marketVisitSeconds,
    settings.idleWatchdogSeconds,
    market?.label,
    symbol,
    rotateMarket,
  ]);

  useEffect(() => {
    if (
      !running ||
      sessionStopped ||
      !authenticatedFeed ||
      tradeBusy ||
      buyingRef.current ||
      switchingRef.current ||
      activeBotTrades.length >=
        safeNumber(settings.maximumOpenTrades, 1) ||
      !currentQualified ||
      confirmation.ticks <
        safeNumber(settings.confirmationTicks, 2)
    ) {
      return;
    }

    buyingRef.current = true;
    setPhase("OPENING");

    void (async () => {
      try {
        const direction = analysis.direction;
        const response = await placeTrade({
          contractType:
            direction === "RISE" ? "CALL" : "PUT",
          amount: Math.max(
            0.35,
            safeNumber(settings.stake, 0.35)
          ),
          basis: "stake",
          duration: Math.max(
            5,
            safeNumber(settings.duration, 20)
          ),
          durationUnit: settings.durationUnit || "s",
          symbol,
        });

        const contractId = contractIdOf(response);

        if (!contractId) {
          throw new Error(
            "Deriv did not return a contract ID."
          );
        }

        botContractsRef.current.set(contractId, {
          contractId,
          symbol,
          market: market?.label || symbol,
          direction,
          stake: safeNumber(settings.stake, 0.35),
          confidence: safeNumber(analysis.confidence),
          quality: safeNumber(analysis.quality),
          votes: safeNumber(analysis.voteConsensus),
          continuation: safeNumber(analysis.continuation),
          noise: safeNumber(analysis.noise),
          reversalRisk: safeNumber(
            analysis.reversalRisk
          ),
          spikeRatio: safeNumber(analysis.spikeRatio),
          score: scoreAnalysis(analysis),
          openedAt: Date.now(),
        });

        setLastEntryAt(Date.now());
        setConfirmation({ key: "", ticks: 0 });
        setPhase("OPEN");
        setMessage(
          `${direction} opened on ${market?.label || symbol} at ${safeNumber(
            analysis.confidence
          ).toFixed(1)}% confidence.`
        );
      } catch (error) {
        setPhase("SCANNING");
        setMessage(
          error instanceof Error
            ? error.message
            : "Trade failed."
        );
      } finally {
        buyingRef.current = false;
      }
    })();
  }, [
    running,
    sessionStopped,
    authenticatedFeed,
    tradeBusy,
    activeBotTrades.length,
    currentQualified,
    confirmation.ticks,
    settings,
    analysis,
    symbol,
    market?.label,
    placeTrade,
  ]);

  useEffect(() => {
    const settled = openContracts.filter(
      (contract) => {
        const id = contractKey(contract);
        return (
          isSettled(contract) &&
          botContractsRef.current.has(id) &&
          !processedRef.current.has(id)
        );
      }
    );

    if (!settled.length) return;

    for (const contract of settled) {
      const id = contractKey(contract);
      const original = botContractsRef.current.get(id);

      if (!original) continue;

      processedRef.current.add(id);
      botContractsRef.current.delete(id);

      const result = resultOf(contract);
      const profit = profitOf(contract, original.stake);
      const diagnosis = diagnoseTrade(original, result);
      const settledAt = Date.now();

      setStats((current) => ({
        runs: current.runs + 1,
        wins: current.wins + (result === "WON" ? 1 : 0),
        losses:
          current.losses + (result === "LOST" ? 1 : 0),
        profit: current.profit + profit,
        history: [
          {
            ...original,
            result,
            profit,
            diagnosis,
            settledAt,
          },
          ...current.history,
        ].slice(0, 100),
      }));

      buyingRef.current = false;
      switchingRef.current = false;
      setConfirmation({ key: "", ticks: 0 });
      setLastEntryAt(Date.now());
      setPhase("SETTLED");
      setMessage(
        `${original.market} ${result.toLowerCase()} ${profit.toFixed(
          2
        )} USD. Returning to scanner immediately.`
      );

      window.setTimeout(() => {
        if (!runningRef.current) return;
        setPhase("SCANNING");
        setMarketStartedAt(Date.now());
        void rotateMarket(
          `${result} settled. Re-ranking the portfolio.`
        );
      }, Math.max(
        100,
        safeNumber(settings.postSettlementDelayMs, 350)
      ));
    }
  }, [
    openContracts,
    rotateMarket,
    settings.postSettlementDelayMs,
  ]);

  useEffect(() => {
    if (!sessionStopped || !running) return;

    setRunning(false);
    runningRef.current = false;
    setPhase("STOPPED");
    setMessage(
      stats.profit >= safeNumber(settings.takeProfit)
        ? "Take-profit reached. FreshEdge stopped."
        : "Stop-loss reached. FreshEdge stopped."
    );
  }, [
    sessionStopped,
    running,
    stats.profit,
    settings.takeProfit,
  ]);

  const startBot = () => {
    if (sessionStopped) {
      setStats((current) => ({
        ...INITIAL_STATS,
        history: current.history,
      }));
    }

    buyingRef.current = false;
    switchingRef.current = false;
    setConfirmation({ key: "", ticks: 0 });
    setMarketStartedAt(Date.now());
    setLastEntryAt(Date.now());
    setRunning(true);
    runningRef.current = true;
    setPhase("SCANNING");
    setMessage("FreshEdge V9 scanner started.");
  };

  const stopBot = () => {
    setRunning(false);
    runningRef.current = false;
    setPhase("STOPPED");
    setMessage("FreshEdge stopped.");
  };

  const resetSession = () => {
    stopBot();
    setStats(INITIAL_STATS);
    setMarketMemory({});
    setConfirmation({ key: "", ticks: 0 });
    processedRef.current.clear();
    botContractsRef.current.clear();
    setMessage("FreshEdge V9 session reset.");
  };

  const winRate = stats.runs
    ? (stats.wins / stats.runs) * 100
    : 0;

  return (
    <div className="appShell freshEdgeShell freshEdgeV9">
      <Sidebar />

      <main className="mainArea">
        <Topbar />

        <section className="freshEdgeHeader">
          <div>
            <small>CLEAN SCANNER + EXECUTOR</small>
            <h1>FreshEdge AI V9</h1>
            <p>
              One state machine · persistent market memory · immediate
              settlement re-arm
            </p>
          </div>

          <div className="freshEdgeHeaderActions">
            <strong className={running ? "running" : ""}>
              {phase}
            </strong>

            <button
              type="button"
              onClick={startBot}
              disabled={running}
            >
              Start
            </button>

            <button
              type="button"
              onClick={stopBot}
              disabled={!running}
            >
              Stop
            </button>

            <button type="button" onClick={resetSession}>
              Reset
            </button>
          </div>
        </section>

        <section className="freshEdgeMarketBar">
          <MarketSelector
            markets={markets}
            value={symbol}
            onChange={(value) => {
              setConfirmation({ key: "", ticks: 0 });
              setMarketStartedAt(Date.now());
              void changeSymbol(value);
            }}
            disabled={loadingMarket}
          />

          <article>
            <span>Feed</span>
            <strong>
              {authenticatedFeed
                ? "AUTHENTICATED"
                : connected
                ? "ANALYSIS"
                : "CONNECTING"}
            </strong>
          </article>

          <article>
            <span>Current market</span>
            <strong>{market?.label || symbol || "—"}</strong>
          </article>

          <article>
            <span>Ticks</span>
            <strong>{prices.length}</strong>
          </article>

          <article>
            <span>Open</span>
            <strong>{activeBotTrades.length}</strong>
          </article>
        </section>

        <section className="freshEdgeDecision">
          <div>
            <small>LIVE DECISION</small>
            <h2>
              {currentQualified
                ? analysis.direction
                : analysis.decision || "WAIT"}
            </h2>
            <p>{analysis.reason}</p>
          </div>

          <div className="freshEdgeDecisionGrid">
            {[
              ["Phase", phase],
              [
                "Confidence",
                `${safeNumber(analysis.confidence).toFixed(1)}%`,
              ],
              [
                "Quality",
                `${safeNumber(analysis.quality).toFixed(1)}%`,
              ],
              [
                "Votes",
                `${safeNumber(
                  analysis.voteConsensus
                ).toFixed(1)}%`,
              ],
              [
                "Continuation",
                `${safeNumber(
                  analysis.continuation
                ).toFixed(1)}%`,
              ],
              [
                "Noise",
                `${safeNumber(analysis.noise).toFixed(1)}%`,
              ],
              [
                "Reversal",
                `${safeNumber(
                  analysis.reversalRisk
                ).toFixed(1)}%`,
              ],
              [
                "Confirm",
                `${confirmation.ticks}/${settings.confirmationTicks}`,
              ],
            ].map(([label, value]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        </section>

        <section className="freshEdgeV9Portfolio">
          <header>
            <div>
              <small>BROWSER MARKET MEMORY</small>
              <h3>Recently scanned markets</h3>
            </div>
            <strong>{rankedMarkets.length} CACHED</strong>
          </header>

          <div>
            {rankedMarkets.slice(0, 10).map((row, index) => (
              <article
                key={row.symbol}
                className={row.qualified ? "qualified" : ""}
              >
                <span>#{index + 1}</span>
                <strong>{row.label}</strong>
                <b>{safeNumber(row.score).toFixed(1)}</b>
                <small>
                  {row.direction} · C{" "}
                  {safeNumber(row.confidence).toFixed(1)}% · Q{" "}
                  {safeNumber(row.quality).toFixed(1)}%
                </small>
                <em>
                  {row.qualified ? "READY" : "WATCH"}
                </em>
              </article>
            ))}

            {!rankedMarkets.length && (
              <p>Scanning markets to build browser memory...</p>
            )}
          </div>
        </section>

        <section className="freshEdgeSettings">
          {[
            ["Stake", "stake", 0.35, 100, 0.05],
            ["Duration", "duration", 5, 120, 5],
            [
              "Confidence",
              "minimumConfidence",
              50,
              95,
              1,
            ],
            ["Quality", "minimumQuality", 45, 95, 1],
            ["Votes", "minimumVotes", 45, 95, 1],
            [
              "Continuation",
              "minimumContinuation",
              40,
              95,
              1,
            ],
            ["Max noise", "maximumNoise", 30, 95, 1],
            [
              "Max reversal",
              "maximumReversal",
              30,
              95,
              1,
            ],
            [
              "Confirm ticks",
              "confirmationTicks",
              1,
              5,
              1,
            ],
            [
              "Market visit",
              "marketVisitSeconds",
              5,
              60,
              1,
            ],
            [
              "Risk exit",
              "highRiskExitSeconds",
              3,
              30,
              1,
            ],
            [
              "Idle watchdog",
              "idleWatchdogSeconds",
              15,
              120,
              5,
            ],
            ["Take profit", "takeProfit", 0.5, 100, 0.5],
            ["Stop loss", "stopLoss", 0.5, 100, 0.5],
          ].map(([label, key, min, max, step]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="number"
                min={min}
                max={max}
                step={step}
                value={settings[key]}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    [key]: Number(event.target.value),
                  }))
                }
              />
            </label>
          ))}
        </section>

        <div className="freshEdgeMessage">
          {tradeError || message}
        </div>

        <section className="freshEdgeBottom">
          <div className="freshEdgeExecution">
            <header>
              <div>
                <small>LIVE EXECUTION</small>
                <h3>FreshEdge monitor</h3>
              </div>
              <strong>{activeBotTrades.length} OPEN</strong>
            </header>

            {activeBotTrades.length ? (
              activeBotTrades.map((contract) => {
                const id = contractKey(contract);
                const original =
                  botContractsRef.current.get(id);

                return (
                  <article key={id}>
                    <strong>
                      {original?.direction || "OPEN"}
                    </strong>
                    <span>
                      {original?.market || contract?.symbol}
                    </span>
                    <span>{id}</span>
                  </article>
                );
              })
            ) : (
              <p>No open FreshEdge trades.</p>
            )}
          </div>

          <div className="freshEdgePerformance">
            <header>
              <small>PERFORMANCE</small>
              <h3>Isolated session</h3>
            </header>

            <div>
              <article>
                <span>Runs</span>
                <strong>{stats.runs}</strong>
              </article>
              <article>
                <span>Wins</span>
                <strong>{stats.wins}</strong>
              </article>
              <article>
                <span>Losses</span>
                <strong>{stats.losses}</strong>
              </article>
              <article>
                <span>Win rate</span>
                <strong>{winRate.toFixed(1)}%</strong>
              </article>
              <article>
                <span>P/L</span>
                <strong>{stats.profit.toFixed(2)}</strong>
              </article>
            </div>
          </div>
        </section>

        <section className="freshEdgeJournal">
          <header>
            <small>TRADE JOURNAL</small>
            <h3>FreshEdge V9 trades</h3>
          </header>

          {stats.history.length ? (
            stats.history.map((trade) => (
              <article
                key={`${trade.contractId}-${trade.settledAt}`}
                className="freshEdgeJournalRow"
              >
                <div>
                  <strong>{trade.market}</strong>
                  <span>{trade.direction}</span>
                </div>

                <div>
                  <span>Entry score</span>
                  <strong>
                    {safeNumber(trade.score).toFixed(1)} · C{" "}
                    {safeNumber(trade.confidence).toFixed(1)}%
                  </strong>
                </div>

                <div>
                  <span>Diagnosis</span>
                  <strong>{trade.diagnosis}</strong>
                </div>

                <b
                  className={
                    trade.result === "WON" ? "won" : "lost"
                  }
                >
                  {trade.result}{" "}
                  {safeNumber(trade.profit).toFixed(2)}
                </b>
              </article>
            ))
          ) : (
            <p>No settled FreshEdge V9 trades yet.</p>
          )}
        </section>

        <footer className="freshEdgeFooter">
          FreshEdge V9 separates scanning from execution and re-arms
          immediately after settlement. It filters entries but cannot
          guarantee wins. Test on Demo.
        </footer>
      </main>
    </div>
  );
}
