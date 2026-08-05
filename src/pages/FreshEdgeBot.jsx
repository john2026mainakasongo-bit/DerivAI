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

const STORAGE_KEY = "fresh-edge-ai-v3-learning-history";

const INITIAL_STATS = {
  runs: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  history: [],
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


function diagnoseFreshEdgeTrade(trade, result) {
  if (result === "WON") {
    return {
      code: "SETUP_HELD",
      summary: "Trend, votes and continuation held through expiry.",
      nextAction: "Keep the same thresholds; continue scanning fresh setups.",
    };
  }

  const confidence = Number(trade?.confidence || 0);
  const quality = Number(trade?.quality || 0);
  const noise = Number(trade?.noise || 0);
  const reversal = Number(trade?.reversalRisk || 0);
  const spike = Number(trade?.spikeRatio || 0);
  const continuation = Number(trade?.continuation || 0);
  const votes = Number(trade?.voteConsensus || 0);

  if (spike >= 4.5) {
    return {
      code: "SPIKE_ENTRY",
      summary: "A large tick spike weakened the expiry timing.",
      nextAction: "Block the market briefly and require a lower spike ratio.",
    };
  }

  if (reversal >= 58) {
    return {
      code: "REVERSAL_PRESSURE",
      summary: "Reversal pressure was already elevated at entry.",
      nextAction: "Require stronger continuation and avoid repeating that side.",
    };
  }

  if (noise >= 68) {
    return {
      code: "HIGH_NOISE",
      summary: "Noise was high enough to disrupt the short expiry.",
      nextAction: "Skip this market until noise drops.",
    };
  }

  if (votes < 62 || continuation < 60) {
    return {
      code: "WEAK_FOLLOW_THROUGH",
      summary: "The direction was correct briefly but follow-through was weak.",
      nextAction: "Raise vote/continuation requirements for the next setup.",
    };
  }

  if (confidence < 66 || quality < 62) {
    return {
      code: "MARGINAL_EDGE",
      summary: "The setup passed, but its safety margin was small.",
      nextAction: "Wait for a stronger fresh-tick setup on another market.",
    };
  }

  return {
    code: "EXPIRY_VARIANCE",
    summary: "A strong setup lost to short-term expiry variance.",
    nextAction: "Do not chase; move to a fresh market and rebuild the signal.",
  };
}


const EMPTY_LEARNING = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 50,
  confidenceAdjustment: 0,
  qualityAdjustment: 0,
  voteAdjustment: 0,
  continuationAdjustment: 0,
  weights: {
    quality: 0.42,
    votes: 0.22,
    continuation: 0.20,
    risk: 0.16,
  },
  causes: {
    SETUP_HELD: 0,
    SPIKE_ENTRY: 0,
    REVERSAL_PRESSURE: 0,
    HIGH_NOISE: 0,
    WEAK_FOLLOW_THROUGH: 0,
    MARGINAL_EDGE: 0,
    EXPIRY_VARIANCE: 0,
  },
  directions: {
    RISE: { trades: 0, wins: 0, rate: 50 },
    FALL: { trades: 0, wins: 0, rate: 50 },
  },
};

function buildFreshEdgeLearning(history = []) {
  const settled = Array.isArray(history)
    ? history.filter(
        (trade) =>
          trade?.result === "WON" ||
          trade?.result === "LOST"
      )
    : [];

  if (!settled.length) {
    return EMPTY_LEARNING;
  }

  const recent = settled.slice(0, 60);
  const wins = recent.filter(
    (trade) => trade.result === "WON"
  ).length;
  const losses = recent.length - wins;
  const winRate = (wins / recent.length) * 100;

  const causes = {
    ...EMPTY_LEARNING.causes,
  };

  const directions = {
    RISE: { trades: 0, wins: 0, rate: 50 },
    FALL: { trades: 0, wins: 0, rate: 50 },
  };

  let confidenceLossPressure = 0;
  let qualityLossPressure = 0;
  let voteLossPressure = 0;
  let continuationLossPressure = 0;

  recent.forEach((trade, index) => {
    const recencyWeight =
      1 - index / Math.max(80, recent.length * 1.5);
    const code =
      trade?.diagnosis?.code ||
      (trade.result === "WON"
        ? "SETUP_HELD"
        : "EXPIRY_VARIANCE");

    causes[code] = Number(causes[code] || 0) + 1;

    const side =
      trade.direction === "RISE" ? "RISE" : "FALL";
    directions[side].trades += 1;

    if (trade.result === "WON") {
      directions[side].wins += 1;
    } else {
      if (Number(trade.confidence || 0) < 68) {
        confidenceLossPressure += recencyWeight;
      }

      if (Number(trade.quality || 0) < 64) {
        qualityLossPressure += recencyWeight;
      }

      if (Number(trade.voteConsensus || 0) < 64) {
        voteLossPressure += recencyWeight;
      }

      if (Number(trade.continuation || 0) < 62) {
        continuationLossPressure += recencyWeight;
      }
    }
  });

  for (const side of ["RISE", "FALL"]) {
    directions[side].rate = directions[side].trades
      ? (directions[side].wins /
          directions[side].trades) *
        100
      : 50;
  }

  const lossBase = Math.max(1, losses);

  const confidenceAdjustment = Math.min(
    10,
    (confidenceLossPressure / lossBase) * 4
  );
  const qualityAdjustment = Math.min(
    8,
    (qualityLossPressure / lossBase) * 3
  );
  const voteAdjustment = Math.min(
    8,
    (voteLossPressure / lossBase) * 3
  );
  const continuationAdjustment = Math.min(
    8,
    (continuationLossPressure / lossBase) * 3
  );

  const normalize = (weights) => {
    const total = Object.values(weights).reduce(
      (sum, value) => sum + Number(value || 0),
      0
    );

    return Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [
        key,
        Number(value || 0) / Math.max(0.01, total),
      ])
    );
  };

  const weights = normalize({
    quality:
      0.42 +
      Math.min(0.10, qualityLossPressure * 0.012),
    votes:
      0.22 +
      Math.min(0.08, voteLossPressure * 0.010),
    continuation:
      0.20 +
      Math.min(
        0.10,
        continuationLossPressure * 0.012
      ),
    risk:
      0.16 +
      Math.min(
        0.12,
        (
          Number(causes.HIGH_NOISE || 0) +
          Number(causes.REVERSAL_PRESSURE || 0) +
          Number(causes.SPIKE_ENTRY || 0)
        ) *
          0.006
      ),
  });

  return {
    totalTrades: recent.length,
    wins,
    losses,
    winRate,
    confidenceAdjustment,
    qualityAdjustment,
    voteAdjustment,
    continuationAdjustment,
    weights,
    causes,
    directions,
  };
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
  const [message, setMessage] = useState(
    "FreshEdge V3 is ready with adaptive learning."
  );
  const [settings, setSettings] = useState({
    stake: 0.35,
    duration: 20,
    durationUnit: "s",
    minimumTicks: 16,
    minimumConfidence: 60,
    minimumQuality: 56,
    minimumVotes: 56,
    minimumContinuation: 54,
    maximumNoise: 76,
    maximumReversal: 70,
    maximumSpikeRatio: 6,
    confirmationTicks: 2,
    maximumMarketSeconds: 7,
    marketBlockSeconds: 15,
    maximumOpenTrades: 1,
    takeProfit: 2,
    stopLoss: 1.4,
  });
  const [stats, setStats] = useState(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) || "null"
      );
      return saved || INITIAL_STATS;
    } catch {
      return INITIAL_STATS;
    }
  });
  const [confirmation, setConfirmation] = useState({
    key: "",
    ticks: 0,
  });
  const [blockedMarkets, setBlockedMarkets] = useState({});
  const [marketStartedAt, setMarketStartedAt] = useState(Date.now());

  const buyingRef = useRef(false);
  const processedRef = useRef(new Set());
  const botContractsRef = useRef(new Map());

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(stats)
      );
    } catch {
      // Storage can be unavailable in private mode.
    }
  }, [stats]);

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

  const learning = useMemo(
    () => buildFreshEdgeLearning(stats.history),
    [stats.history]
  );

  const analysis = useMemo(
    () =>
      analyzeFreshEdge(
        prices,
        settings,
        learning
      ),
    [prices, settings, learning]
  );

  const directionHeatmap = useMemo(() => {
    const riseHistory =
      learning.directions.RISE.rate;
    const fallHistory =
      learning.directions.FALL.rate;

    const liveRise =
      analysis.direction === "RISE"
        ? analysis.confidence
        : Math.max(
            0,
            100 - analysis.confidence
          );

    const liveFall =
      analysis.direction === "FALL"
        ? analysis.confidence
        : Math.max(
            0,
            100 - analysis.confidence
          );

    return {
      RISE:
        liveRise * 0.72 +
        riseHistory * 0.28,
      FALL:
        liveFall * 0.72 +
        fallHistory * 0.28,
    };
  }, [
    analysis.direction,
    analysis.confidence,
    learning.directions,
  ]);

  const activeBotTrades = useMemo(
    () =>
      openContracts.filter((contract) =>
        botContractsRef.current.has(contractKey(contract))
      ),
    [openContracts]
  );

  const sessionStopped =
    stats.profit >= Number(settings.takeProfit) ||
    stats.profit <= -Math.abs(Number(settings.stopLoss));

  useEffect(() => {
    if (!running || sessionStopped) return;

    const key = [
      symbol,
      analysis.direction,
      Math.round(analysis.confidence),
      Math.round(analysis.quality),
    ].join("|");

    if (
      analysis.decision === "BUY" &&
      analysis.direction
    ) {
      setConfirmation((current) => ({
        key,
        ticks:
          current.key === key
            ? Math.min(
                Number(settings.confirmationTicks),
                current.ticks + 1
              )
            : 1,
      }));
    } else {
      setConfirmation({ key: "", ticks: 0 });
    }
  }, [
    running,
    sessionStopped,
    symbol,
    currentPrice,
    analysis.decision,
    analysis.direction,
    analysis.confidence,
    analysis.quality,
    settings.confirmationTicks,
  ]);

  const switchMarket = useCallback(
    async (reason) => {
      if (markets.length < 2 || loadingMarket) return;

      const now = Date.now();
      const available = markets.filter(
        (item) =>
          item.id !== symbol &&
          Number(blockedMarkets[item.id] || 0) <= now
      );

      const next =
        available[0] ||
        markets.find((item) => item.id !== symbol);

      if (!next) return;

      setMessage(`${reason} Switching to ${next.label}.`);
      setConfirmation({ key: "", ticks: 0 });
      setMarketStartedAt(Date.now());

      await changeSymbol(next.id);
    },
    [
      markets,
      loadingMarket,
      symbol,
      blockedMarkets,
      changeSymbol,
    ]
  );

  useEffect(() => {
    if (
      !running ||
      loadingMarket ||
      activeBotTrades.length ||
      markets.length < 2
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      const elapsed =
        (Date.now() - marketStartedAt) / 1000;

      const hardRisk =
        analysis.ready &&
        (
          analysis.noise >= settings.maximumNoise ||
          analysis.reversalRisk >=
            settings.maximumReversal ||
          analysis.spikeRatio >=
            settings.maximumSpikeRatio
        );

      if (hardRisk && elapsed >= 3) {
        void switchMarket("Hard risk detected.");
      } else if (
        analysis.ready &&
        analysis.confidence < 48 &&
        analysis.quality < 45 &&
        elapsed >= 6
      ) {
        void switchMarket("Weak fresh setup.");
      } else if (
        elapsed >= Number(settings.maximumMarketSeconds)
      ) {
        void switchMarket("No confirmed entry.");
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [
    running,
    loadingMarket,
    activeBotTrades.length,
    markets.length,
    marketStartedAt,
    analysis,
    settings.maximumNoise,
    settings.maximumReversal,
    settings.maximumSpikeRatio,
    settings.maximumMarketSeconds,
    switchMarket,
  ]);

  useEffect(() => {
    if (
      !running ||
      sessionStopped ||
      !authenticatedFeed ||
      tradeBusy ||
      buyingRef.current ||
      activeBotTrades.length >=
        Number(settings.maximumOpenTrades) ||
      confirmation.ticks <
        Number(settings.confirmationTicks) ||
      analysis.decision !== "BUY" ||
      !analysis.direction
    ) {
      return;
    }

    buyingRef.current = true;

    void (async () => {
      try {
        const contractType =
          analysis.direction === "RISE"
            ? "CALL"
            : "PUT";

        const response = await placeTrade({
          contractType,
          amount: Math.max(
            0.35,
            Number(settings.stake || 0.35)
          ),
          basis: "stake",
          duration: Number(settings.duration || 20),
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
          direction: analysis.direction,
          confidence: analysis.confidence,
          quality: analysis.quality,
          noise: analysis.noise,
          reversalRisk: analysis.reversalRisk,
          continuation: analysis.continuation,
          voteConsensus: analysis.voteConsensus,
          spikeRatio: analysis.spikeRatio,
          entryReasons: analysis.entryReasons || [],
          adaptiveThresholds:
            analysis.adaptiveThresholds || {},
          learnedWeights:
            analysis.learnedWeights || {},
          learningTrades:
            learning.totalTrades,
          openedAt: Date.now(),
          stake: Number(settings.stake || 0.35),
        });

        setMessage(
          `${analysis.direction} opened on ${market?.label || symbol} at ${analysis.confidence.toFixed(
            1
          )}% confidence.`
        );
        setConfirmation({ key: "", ticks: 0 });
      } catch (error) {
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
    confirmation.ticks,
    analysis,
    settings.maximumOpenTrades,
    settings.confirmationTicks,
    settings.stake,
    settings.duration,
    settings.durationUnit,
    symbol,
    market?.label,
    placeTrade,
  ]);

  useEffect(() => {
    const settled = openContracts.filter(
      (contract) =>
        isSettled(contract) &&
        botContractsRef.current.has(contractKey(contract)) &&
        !processedRef.current.has(contractKey(contract))
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
      const diagnosis = diagnoseFreshEdgeTrade(
        original,
        result
      );

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
            settledAt: Date.now(),
          },
          ...current.history,
        ].slice(0, 50),
      }));

      if (result === "LOST") {
        setBlockedMarkets((current) => ({
          ...current,
          [original.symbol]:
            Date.now() +
            Number(settings.marketBlockSeconds) * 1000,
        }));

        setMessage(
          `${original.market} lost · ${diagnosis.code}: ${diagnosis.summary} Learning memory now has ${learning.totalTrades + 1} trades. ${diagnosis.nextAction}`
        );

        void switchMarket("Loss rearm.");
      } else {
        setMessage(
          `${original.market} won ${profit.toFixed(2)} USD · ${diagnosis.summary} Learning memory now has ${learning.totalTrades + 1} trades.`
        );
        setMarketStartedAt(Date.now());
      }
    }
  }, [
    openContracts,
    settings.marketBlockSeconds,
    switchMarket,
    learning.totalTrades,
  ]);

  useEffect(() => {
    if (!sessionStopped || !running) return;
    setRunning(false);
    setMessage(
      stats.profit >= Number(settings.takeProfit)
        ? "Take-profit reached. FreshEdge stopped."
        : "Stop-loss reached. FreshEdge stopped."
    );
  }, [
    sessionStopped,
    running,
    stats.profit,
    settings.takeProfit,
  ]);

  const resetSession = () => {
    setRunning(false);
    setStats(INITIAL_STATS);
    setConfirmation({ key: "", ticks: 0 });
    setBlockedMarkets({});
    processedRef.current.clear();
    botContractsRef.current.clear();
    setMessage("FreshEdge session reset.");
  };

  return (
    <div className="appShell freshEdgeShell">
      <Sidebar />

      <main className="mainArea">
        <Topbar />

        <section className="freshEdgeHeader">
          <div>
            <small>STANDALONE BOT</small>
            <h1>FreshEdge AI V3</h1>
            <p>
              Adaptive learning · live probability · explainable outcomes
            </p>
          </div>

          <div className="freshEdgeHeaderActions">
            <strong className={running ? "running" : ""}>
              {running ? "RUNNING" : "STOPPED"}
            </strong>

            <button
              type="button"
              onClick={() => {
                setMarketStartedAt(Date.now());
                setRunning(true);
                setMessage("FreshEdge started.");
              }}
              disabled={running}
            >
              Start
            </button>

            <button
              type="button"
              onClick={() => setRunning(false)}
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
            <span>Account feed</span>
            <strong>
              {authenticatedFeed
                ? "AUTHENTICATED"
                : connected
                ? "ANALYSIS ONLY"
                : "CONNECTING"}
            </strong>
          </article>

          <article>
            <span>Price</span>
            <strong>
              {Number.isFinite(Number(currentPrice))
                ? Number(currentPrice).toFixed(
                    market?.decimals || 3
                  )
                : "—"}
            </strong>
          </article>

          <article>
            <span>Fresh ticks</span>
            <strong>{prices.length}</strong>
          </article>
        </section>

        <section className="freshEdgeDecision">
          <div>
            <small>LIVE DECISION</small>
            <h2>{analysis.decision}</h2>
            <p>{analysis.reason}</p>
          </div>

          <div className="freshEdgeDecisionGrid">
            {[
              ["Direction", analysis.direction || "WAIT"],
              ["Confidence", `${analysis.confidence.toFixed(1)}%`],
              ["Quality", `${analysis.quality.toFixed(1)}%`],
              ["Votes", `${Number(analysis.voteConsensus || 0).toFixed(1)}%`],
              ["Continuation", `${Number(analysis.continuation || 0).toFixed(1)}%`],
              ["Noise", `${analysis.noise.toFixed(1)}%`],
              ["Reversal", `${analysis.reversalRisk.toFixed(1)}%`],
              ["Spike ratio", Number(analysis.spikeRatio || 0).toFixed(2)],
              [
                "Adaptive gate",
                `${Number(
                  analysis.adaptiveThresholds?.confidence ||
                    settings.minimumConfidence
                ).toFixed(1)}%`,
              ],
            ].map(([label, value]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        </section>

        <section className="freshEdgeLearning">
          <header>
            <div>
              <small>V3 ADAPTIVE LEARNING</small>
              <h3>What FreshEdge has learned</h3>
            </div>
            <strong>
              {learning.totalTrades} TRADES
            </strong>
          </header>

          <div className="freshEdgeLearningGrid">
            <article>
              <span>Learned win rate</span>
              <strong>
                {learning.winRate.toFixed(1)}%
              </strong>
            </article>
            <article>
              <span>Required confidence</span>
              <strong>
                {Number(
                  analysis.adaptiveThresholds
                    ?.confidence ||
                    settings.minimumConfidence
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Required quality</span>
              <strong>
                {Number(
                  analysis.adaptiveThresholds
                    ?.quality ||
                    settings.minimumQuality
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Required votes</span>
              <strong>
                {Number(
                  analysis.adaptiveThresholds
                    ?.votes ||
                    settings.minimumVotes
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Quality weight</span>
              <strong>
                {(
                  learning.weights.quality * 100
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Votes weight</span>
              <strong>
                {(
                  learning.weights.votes * 100
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Continuation weight</span>
              <strong>
                {(
                  learning.weights.continuation *
                  100
                ).toFixed(1)}
                %
              </strong>
            </article>
            <article>
              <span>Risk weight</span>
              <strong>
                {(
                  learning.weights.risk * 100
                ).toFixed(1)}
                %
              </strong>
            </article>
          </div>

          <div className="freshEdgeHeatmap">
            <article>
              <span>RISE probability</span>
              <strong>
                {directionHeatmap.RISE.toFixed(1)}%
              </strong>
              <small>
                Learned {learning.directions.RISE.rate.toFixed(
                  1
                )}%
              </small>
            </article>
            <article>
              <span>FALL probability</span>
              <strong>
                {directionHeatmap.FALL.toFixed(1)}%
              </strong>
              <small>
                Learned {learning.directions.FALL.rate.toFixed(
                  1
                )}%
              </small>
            </article>
          </div>

          <div className="freshEdgeCauseGrid">
            {Object.entries(learning.causes).map(
              ([code, count]) => (
                <article key={code}>
                  <span>{code}</span>
                  <strong>{count}</strong>
                </article>
              )
            )}
          </div>
        </section>

        <section className="freshEdgeExplain">
          <header>
            <div>
              <small>WHY THIS TRADE CAN HAPPEN</small>
              <h3>Live entry explanation</h3>
            </div>
            <strong>
              {analysis.decision === "BUY"
                ? "QUALIFIED"
                : "FILTERING"}
            </strong>
          </header>

          <div className="freshEdgeExplainGrid">
            {(analysis.entryReasons || [
              analysis.reason,
            ]).map((reason, index) => (
              <article key={`${reason}-${index}`}>
                <span>{index + 1}</span>
                <strong>{reason}</strong>
              </article>
            ))}
          </div>

          <p>
            Entry confirmation: {confirmation.ticks}/
            {settings.confirmationTicks} live ticks. Market changes
            after {settings.maximumMarketSeconds}s without a valid setup.
          </p>
        </section>

        <section className="freshEdgeSettings">
          {[
            ["Stake", "stake", 0.35, 100, 0.05],
            ["Fresh ticks", "minimumTicks", 10, 60, 1],
            ["Duration", "duration", 5, 120, 5],
            ["Confidence", "minimumConfidence", 50, 90, 1],
            ["Quality", "minimumQuality", 45, 90, 1],
            ["Votes", "minimumVotes", 45, 90, 1],
            ["Continuation", "minimumContinuation", 40, 90, 1],
            ["Max noise", "maximumNoise", 40, 95, 1],
            ["Max reversal", "maximumReversal", 40, 95, 1],
            ["Confirm ticks", "confirmationTicks", 1, 5, 1],
            ["Market seconds", "maximumMarketSeconds", 3, 30, 1],
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
                <span>P/L</span>
                <strong>{stats.profit.toFixed(2)}</strong>
              </article>
            </div>
          </div>
        </section>

        <section className="freshEdgeJournal">
          <header>
            <small>TRADE JOURNAL</small>
            <h3>FreshEdge trades only</h3>
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
                  <span>
                    Why entered · memory{" "}
                    {trade.learningTrades || 0} trades
                  </span>
                  <strong>
                    {(trade.entryReasons || []).join(" · ") ||
                      `C ${Number(trade.confidence).toFixed(
                        1
                      )}% · Q ${Number(trade.quality).toFixed(
                        1
                      )}%`}
                  </strong>
                </div>

                <div>
                  <span>Outcome diagnosis</span>
                  <strong>
                    {trade.diagnosis?.code || "SETTLED"}
                  </strong>
                  <small>
                    {trade.diagnosis?.summary || "Trade settled."}
                  </small>
                </div>

                <div>
                  <span>Next protection</span>
                  <strong>
                    {trade.diagnosis?.nextAction ||
                      "Continue fresh scan."}
                  </strong>
                </div>

                <b
                  className={
                    trade.result === "WON" ? "won" : "lost"
                  }
                >
                  {trade.result}{" "}
                  {Number(trade.profit).toFixed(2)}
                </b>
              </article>
            ))
          ) : (
            <p>No settled FreshEdge trades yet.</p>
          )}
        </section>

        <footer className="freshEdgeFooter">
          FreshEdge V3 learning is isolated from Quantum AI and Higher High. Learning adjusts filters; it does not guarantee future wins. Test on Demo.
        </footer>
      </main>
    </div>
  );
}
