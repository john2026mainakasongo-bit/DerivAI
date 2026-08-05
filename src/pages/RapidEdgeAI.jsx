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
import "../styles/RapidEdgeAI.css";

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, Number(value || 0)));

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function symbolOf(item) {
  return String(
    item?.symbol ??
      item?.value ??
      item?.id ??
      ""
  );
}

function quoteOf(item) {
  if (typeof item === "number") return item;

  return Number(
    item?.quote ??
      item?.price ??
      item?.tick ??
      item?.value ??
      NaN
  );
}

function lastDigitOf(item) {
  const quote = quoteOf(item);

  if (!Number.isFinite(quote)) return null;

  const normalized = quote.toFixed(5).replace(".", "");
  const digit = Number(normalized.at(-1));

  return Number.isInteger(digit) ? digit : null;
}

function contractIdOf(item = {}) {
  return String(
    item?.contract_id ||
      item?.contractId ||
      item?.id ||
      ""
  );
}

function profitOf(item = {}) {
  const value = Number(
    item?.profit ??
      item?.profit_loss ??
      item?.pnl ??
      (
        Number(item?.sell_price || 0) -
        Number(item?.buy_price || 0)
      )
  );

  return Number.isFinite(value) ? value : 0;
}

function statusOf(item = {}) {
  const raw = String(item?.status || "").toUpperCase();
  const profit = profitOf(item);

  if (
    item?.is_sold ||
    item?.is_expired ||
    ["WON", "LOST", "SOLD", "EXPIRED"].includes(raw)
  ) {
    if (raw === "WON" || raw === "LOST") return raw;
    if (profit > 0) return "WON";
    if (profit < 0) return "LOST";
    return "CLOSED";
  }

  return raw || "OPEN";
}

function theoreticalWinRate(side, barrier) {
  if (side === "OVER") {
    return ((9 - Number(barrier)) / 10) * 100;
  }

  return (Number(barrier) / 10) * 100;
}

function estimatedProfitRatio(side, barrier) {
  const probability = theoreticalWinRate(side, barrier) / 100;

  return Math.max(
    0.05,
    0.94 / Math.max(0.1, probability) - 1
  );
}

function candidateKey(candidate, symbol) {
  return [
    String(symbol || ""),
    String(candidate?.side || ""),
    Number(candidate?.barrier ?? -1),
  ].join(":");
}

function analyzeSpeedCandidates(digits) {
  const clean = (Array.isArray(digits) ? digits : [])
    .map(Number)
    .filter(
      (digit) =>
        Number.isInteger(digit) &&
        digit >= 0 &&
        digit <= 9
    )
    .slice(-60);

  if (clean.length < 8) {
    return {
      sample: clean.length,
      candidates: [],
      best: null,
    };
  }

  const short = clean.slice(-20);
  const medium = clean.slice(-40);

  const rows = [];

  for (const side of ["OVER", "UNDER"]) {
    const barriers =
      side === "OVER"
        ? [1, 2, 3, 4]
        : [5, 6, 7, 8];

    for (const barrier of barriers) {
      const wins = (sample) =>
        sample.filter((digit) =>
          side === "OVER"
            ? digit > barrier
            : digit < barrier
        ).length;

      const pShort =
        (wins(short) / Math.max(1, short.length)) * 100;
      const pMedium =
        (wins(medium) / Math.max(1, medium.length)) * 100;
      const pLong =
        (wins(clean) / Math.max(1, clean.length)) * 100;

      const probability =
        pShort * 0.52 +
        pMedium * 0.30 +
        pLong * 0.18;

      const profitRatio =
        estimatedProfitRatio(side, barrier);

      const expectedValue =
        (probability / 100) * profitRatio -
        (1 - probability / 100);

      const consistency =
        100 -
        Math.min(
          100,
          Math.abs(pShort - pMedium) * 2.2 +
            Math.abs(pMedium - pLong) * 1.4
        );

      const votes = [
        pShort >= theoreticalWinRate(side, barrier),
        pMedium >= theoreticalWinRate(side, barrier),
        pLong >= theoreticalWinRate(side, barrier),
        expectedValue >= 0,
        consistency >= 55,
      ].filter(Boolean).length;

      const overOnePenalty =
        side === "OVER" && barrier === 1
          ? probability >= 92 && expectedValue >= 0.02
            ? 0
            : 16
          : 0;

      const risk = clamp(
        100 - consistency +
          Math.max(0, 70 - probability) * 0.55 +
          Math.max(0, -expectedValue * 100) * 1.5,
        0,
        100
      );

      const score = clamp(
        probability * 0.46 +
          consistency * 0.20 +
          votes * 6 +
          expectedValue * 120 -
          risk * 0.18 -
          overOnePenalty,
        0,
        100
      );

      rows.push({
        side,
        barrier,
        probability,
        expectedValue,
        profitRatio,
        consistency,
        votes,
        risk,
        score,
        contract: `${side} ${barrier}`,
      });
    }
  }

  rows.sort((a, b) => {
    const evDifference =
      Number(b.expectedValue || 0) -
      Number(a.expectedValue || 0);

    if (Math.abs(evDifference) >= 0.008) {
      return evDifference;
    }

    return Number(b.score || 0) - Number(a.score || 0);
  });

  return {
    sample: clean.length,
    candidates: rows,
    best: rows[0] || null,
  };
}

function ladderQualification(candidate, ageMs) {
  if (!candidate) {
    return {
      qualified: false,
      stage: "WARMING",
      reason: "NO_CANDIDATE",
    };
  }

  const probability = Number(candidate.probability || 0);
  const expectedValue = Number(candidate.expectedValue || -1);
  const votes = Number(candidate.votes || 0);
  const risk = Number(candidate.risk || 100);

  if (ageMs < 3000) {
    return {
      qualified:
        probability >= 74 &&
        expectedValue >= 0.005 &&
        votes >= 3 &&
        risk <= 52,
      stage: "STRICT",
      reason: "STRICT_GATE",
    };
  }

  if (ageMs < 6000) {
    return {
      qualified:
        probability >= 69 &&
        expectedValue >= 0 &&
        votes >= 2 &&
        risk <= 58,
      stage: "BALANCED",
      reason: "BALANCED_GATE",
    };
  }

  return {
    qualified:
      probability >= 65 &&
      expectedValue >= -0.004 &&
      votes >= 2 &&
      risk <= 62,
    stage: ageMs >= 8000 ? "WATCHDOG" : "RELAXED",
    reason: "WATCHDOG_GATE",
  };
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

export default function RapidEdgeAI() {
  const {
    markets = [],
    symbol = "",
    connected = false,
    authenticatedFeed = false,
    loadingMarket = false,
    prices = [],
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
    refreshContract,
  } = useDerivTicks();

  const [running, setRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [durationTicks, setDurationTicks] = useState(1);
  const [allowReal, setAllowReal] = useState(false);
  const [message, setMessage] = useState(
    "RapidEdge V4 Speed Core is ready."
  );
  const [trades, setTrades] = useState([]);
  const [clock, setClock] = useState(Date.now());
  const [lastSettlementAt, setLastSettlementAt] =
    useState(Date.now());
  const [lastLossKey, setLastLossKey] = useState("");
  const [lastLossAt, setLastLossAt] = useState(0);
  const [lastEntryAt, setLastEntryAt] = useState(0);
  const [marketEnteredAt, setMarketEnteredAt] =
    useState(Date.now());
  const [switches, setSwitches] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [executionAttempts, setExecutionAttempts] = useState(0);
  const [lastExecutionError, setLastExecutionError] = useState("");
  const [lastBuyRequestAt, setLastBuyRequestAt] = useState(0);

  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const recentRunTimesRef = useRef([]);
  const audioRef = useRef(null);
  const executeTradeRef = useRef(null);

  const marketSymbols = useMemo(
    () =>
      (Array.isArray(markets) ? markets : [])
        .map(symbolOf)
        .filter(Boolean),
    [markets]
  );

  const digits = useMemo(
    () =>
      (Array.isArray(prices) ? prices : [])
        .map(lastDigitOf)
        .filter((digit) => digit !== null)
        .slice(-60),
    [prices]
  );

  const analysis = useMemo(
    () => analyzeSpeedCandidates(digits),
    [digits]
  );

  const blockedLossKey =
    clock - lastLossAt < 4000
      ? lastLossKey
      : "";

  const rankedCandidates = useMemo(
    () =>
      analysis.candidates.filter(
        (candidate) =>
          candidateKey(candidate, symbol) !==
          blockedLossKey
      ),
    [
      analysis.candidates,
      symbol,
      blockedLossKey,
    ]
  );

  const best = rankedCandidates[0] || null;

  const scanAgeMs =
    clock -
    Math.max(
      Number(lastSettlementAt || 0),
      Number(marketEnteredAt || 0)
    );

  const ladder = ladderQualification(
    best,
    scanAgeMs
  );

  const hasOpenTrade = trades.some(
    (trade) => trade.status === "OPEN"
  );

  const runsThisMinute = useMemo(() => {
    const cutoff = clock - 60000;

    return recentRunTimesRef.current.filter(
      (time) => time >= cutoff
    ).length;
  }, [clock, trades]);

  const stats = useMemo(() => {
    const settled = trades.filter((trade) =>
      ["WON", "LOST"].includes(trade.status)
    );
    const wins = settled.filter(
      (trade) => trade.status === "WON"
    ).length;
    const losses = settled.length - wins;
    const profit = settled.reduce(
      (total, trade) =>
        total + Number(trade.profit || 0),
      0
    );

    return {
      runs: settled.length,
      wins,
      losses,
      profit,
      winRate: settled.length
        ? (wins / settled.length) * 100
        : 0,
    };
  }, [trades]);

  const playTone = useCallback(
    async (type) => {
      if (!soundEnabled) return;

      try {
        const AudioContextClass =
          window.AudioContext ||
          window.webkitAudioContext;

        if (!AudioContextClass) return;

        if (!audioRef.current) {
          audioRef.current =
            new AudioContextClass();
        }

        const context = audioRef.current;

        if (context.state === "suspended") {
          await context.resume();
        }

        const oscillator =
          context.createOscillator();
        const gain = context.createGain();
        const now = context.currentTime;

        oscillator.type =
          type === "LOST"
            ? "triangle"
            : "sine";

        oscillator.frequency.setValueAtTime(
          type === "WON"
            ? 1120
            : type === "LOST"
            ? 240
            : 620,
          now
        );

        if (type === "LOST") {
          oscillator.frequency.exponentialRampToValueAtTime(
            130,
            now + 0.28
          );
        }

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(
          0.07,
          now + 0.01
        );
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          now + 0.32
        );

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.34);
      } catch {
        // Audio is optional.
      }
    },
    [soundEnabled]
  );

  const rotateMarket = useCallback(
    async (reason) => {
      if (
        !marketSymbols.length ||
        loadingMarket ||
        hasOpenTrade
      ) {
        return;
      }

      const currentIndex = Math.max(
        0,
        marketSymbols.indexOf(symbol)
      );

      const next =
        marketSymbols[
          (currentIndex + 1) %
            marketSymbols.length
        ];

      if (!next || next === symbol) return;

      setMessage(
        `${reason} · switching ${symbol} → ${next}`
      );
      setMarketEnteredAt(Date.now());
      setSwitches((value) => value + 1);

      try {
        await changeSymbol(next);
      } catch (error) {
        setMessage(
          error?.message ||
            "Market switch failed."
        );
      }
    },
    [
      marketSymbols,
      loadingMarket,
      hasOpenTrade,
      symbol,
      changeSymbol,
    ]
  );

  const executeTrade = useCallback(
    async () => {
      if (
        !running ||
        !connected ||
        !best ||
        !ladder.qualified ||
        hasOpenTrade ||
        tradeBusy ||
        busyRef.current
      ) {
        return false;
      }

      const now = Date.now();

      if (now - lastBuyRequestAt < 650) {
        return false;
      }

      if (
        !authenticatedFeed ||
        !selectedAccountId
      ) {
        setLastExecutionError(
          "Choose a connected Deriv Demo or Real account."
        );
        setMessage(
          "EXECUTION BLOCKED · authenticated Deriv account is not ready."
        );
        return false;
      }

      if (
        selectedAccountType !== "demo" &&
        !allowReal
      ) {
        setRunning(false);
        setLastExecutionError(
          "Real execution is locked."
        );
        setMessage(
          "Real execution is locked. Enable it manually."
        );
        return false;
      }

      recentRunTimesRef.current =
        recentRunTimesRef.current.filter(
          (time) => time >= now - 60000
        );

      if (
        recentRunTimesRef.current.length >= 20
      ) {
        setMessage(
          "20-runs-per-minute cap reached."
        );
        return false;
      }

      if (now - lastEntryAt < 2200) {
        return false;
      }

      busyRef.current = true;
      setLastBuyRequestAt(now);
      setExecutionAttempts((value) => value + 1);
      setLastExecutionError("");
      setMessage(
        `BUY REQUEST · ${best.contract} · ${pct(
          best.probability
        )} · ${ladder.stage}`
      );

      try {
        const request = Promise.resolve(
          placeTrade({
            symbol,
            contractType:
              best.side === "OVER"
                ? "DIGITOVER"
                : "DIGITUNDER",
            amount: Math.max(
              0.35,
              Number(stake || 0.35)
            ),
            basis: "stake",
            duration: Math.max(
              1,
              Number(durationTicks || 1)
            ),
            durationUnit: "t",
            barrier: String(best.barrier),
          })
        );

        const timeout = new Promise((_, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                "Deriv buy request timed out after 12 seconds."
              )
            );
          }, 12000);
        });

        const result = await Promise.race([
          request,
          timeout,
        ]);

        const contractId = String(
          result?.contractId ||
            result?.contract_id ||
            result?.buy?.contract_id ||
            result?.raw?.buy?.contract_id ||
            result?.raw?.data?.buy?.contract_id ||
            ""
        );

        if (!contractId) {
          throw new Error(
            "Deriv purchase returned no contract ID."
          );
        }

        const trade = {
          id: contractId,
          contractId,
          symbol,
          side: best.side,
          barrier: best.barrier,
          contract: best.contract,
          stake: Number(stake || 0.35),
          probability: best.probability,
          expectedValue: best.expectedValue,
          stage: ladder.stage,
          status: "OPEN",
          profit: 0,
          createdAt: now,
        };

        recentRunTimesRef.current.push(now);
        setLastEntryAt(now);
        setTrades((current) => [
          trade,
          ...current,
        ].slice(0, 100));
        setMessage(
          `OPENED ${best.contract} · contract ${contractId} · ${ladder.stage}`
        );

        if (typeof refreshContract === "function") {
          Promise.resolve(
            refreshContract(contractId)
          ).catch(() => {});
        }

        void playTone("OPEN");
        return true;
      } catch (error) {
        const failure =
          error instanceof Error
            ? error.message
            : tradeError || "Trade failed.";

        setLastExecutionError(failure);
        setMessage(`BUY FAILED · ${failure}`);
        return false;
      } finally {
        busyRef.current = false;
      }
    },
    [
      running,
      connected,
      authenticatedFeed,
      selectedAccountId,
      best,
      ladder,
      hasOpenTrade,
      tradeBusy,
      selectedAccountType,
      allowReal,
      lastEntryAt,
      lastBuyRequestAt,
      placeTrade,
      refreshContract,
      symbol,
      stake,
      durationTicks,
      tradeError,
      playTone,
    ]
  );

  useEffect(() => {
    executeTradeRef.current = executeTrade;
  }, [executeTrade]);

  useEffect(() => {
    if (!running) return undefined;

    const executionTimer = window.setInterval(() => {
      if (
        ladder.qualified &&
        !hasOpenTrade &&
        !tradeBusy &&
        !busyRef.current
      ) {
        void executeTradeRef.current?.();
      }
    }, 200);

    return () =>
      window.clearInterval(executionTimer);
  }, [
    running,
    ladder.qualified,
    hasOpenTrade,
    tradeBusy,
  ]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setClock(Date.now()),
      150
    );

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected && typeof connect === "function") {
      Promise.resolve(connect()).catch(() => {});
    }
  }, [connected, connect]);

  useEffect(() => {
    if (!running) return;

    if (
      !ladder.qualified &&
      scanAgeMs >= 8000 &&
      !hasOpenTrade &&
      !busyRef.current
    ) {
      void rotateMarket(
        "8s watchdog found no acceptable entry"
      );
      setLastSettlementAt(Date.now());
    }
  }, [
    running,
    ladder.qualified,
    hasOpenTrade,
    scanAgeMs,
    rotateMarket,
    clock,
  ]);

  useEffect(() => {
    if (!Array.isArray(openContracts)) return;

    for (const contract of openContracts) {
      const id = contractIdOf(contract);
      const status = statusOf(contract);

      if (
        !id ||
        !["WON", "LOST"].includes(status)
      ) {
        continue;
      }

      const processKey = `${id}:${status}`;

      if (processedRef.current.has(processKey)) {
        continue;
      }

      processedRef.current.add(processKey);

      setTrades((current) => {
        const existing = current.find(
          (trade) =>
            String(trade.contractId) === id
        );

        if (!existing) return current;

        const settled = {
          ...existing,
          status,
          profit: profitOf(contract),
          settledAt: Date.now(),
        };

        if (status === "LOST") {
          setLastLossKey(
            candidateKey(settled, settled.symbol)
          );
          setLastLossAt(Date.now());
        }

        setLastSettlementAt(Date.now());
        setMessage(
          `${status} ${settled.contract} · P/L ${money(settled.profit)} · rescanning now`
        );
        void playTone(status);

        return current.map((trade) =>
          String(trade.contractId) === id
            ? settled
            : trade
        );
      });
    }
  }, [openContracts, playTone]);

  function start() {
    setRunning(true);
    setLastSettlementAt(Date.now());
    setMarketEnteredAt(Date.now());
    setMessage(
      "RapidEdge V4.1 started · direct execution loop armed."
    );
    void playTone("OPEN");
  }

  function stop() {
    setRunning(false);
    setMessage("RapidEdge V4.1 stopped.");
  }

  function reset() {
    setRunning(false);
    setTrades([]);
    setLastLossKey("");
    setLastLossAt(0);
    setLastSettlementAt(Date.now());
    recentRunTimesRef.current = [];
    processedRef.current.clear();
    setExecutionAttempts(0);
    setLastExecutionError("");
    setLastBuyRequestAt(0);
    setMessage("RapidEdge V4.1 session reset.");
  }

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent oulPage">
        <Topbar
          title="RapidEdge AI V4.1 · Direct Execution"
          subtitle="200ms direct execution loop · authenticated buy diagnostics · one open trade · up to 20 runs/min"
          connected={connected}
          connecting={loadingMarket}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        <section className="oulToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket}
            onChange={(next) => {
              setMarketEnteredAt(Date.now());
              setLastSettlementAt(Date.now());
              void changeSymbol(next);
            }}
          />

          <div>
            <button
              type="button"
              className="oulReset"
              onClick={reset}
            >
              RESET SESSION
            </button>

            <button
              type="button"
              className={
                running
                  ? "oulStop"
                  : "oulStart"
              }
              onClick={running ? stop : start}
            >
              {running ? "STOP BOT" : "START BOT"}
            </button>
          </div>
        </section>

        <section
          className={`oulDecision ${
            ladder.qualified ? "ready" : ""
          }`}
        >
          <div>
            <small>V4.1 DIRECT EXECUTION</small>
            <h1>
              {best
                ? `${best.contract} · ${pct(
                    best.probability
                  )}`
                : "WARMING TICKS"}
            </h1>
            <p>
              {message}
            </p>
          </div>

          <div className="oulDecisionGrid">
            <article>
              <span>Stage</span>
              <strong>{ladder.stage}</strong>
            </article>
            <article>
              <span>Sample</span>
              <strong>{analysis.sample}/60</strong>
            </article>
            <article>
              <span>Probability</span>
              <strong>
                {pct(best?.probability)}
              </strong>
            </article>
            <article>
              <span>EV</span>
              <strong>
                {Number(
                  best?.expectedValue || 0
                ).toFixed(3)}
              </strong>
            </article>
            <article>
              <span>Votes</span>
              <strong>{best?.votes || 0}/5</strong>
            </article>
            <article>
              <span>Risk</span>
              <strong>{pct(best?.risk)}</strong>
            </article>
            <article>
              <span>Scan Age</span>
              <strong>
                {(scanAgeMs / 1000).toFixed(1)}s
              </strong>
            </article>
            <article>
              <span>Runs / 60s</span>
              <strong>{runsThisMinute}/20</strong>
            </article>
            <article>
              <span>Open Trade</span>
              <strong>
                {hasOpenTrade ? "YES" : "NO"}
              </strong>
            </article>
            <article>
              <span>Auth</span>
              <strong>
                {authenticatedFeed && selectedAccountId
                  ? "READY"
                  : "BLOCKED"}
              </strong>
            </article>
            <article>
              <span>Buy Attempts</span>
              <strong>{executionAttempts}</strong>
            </article>
            <article>
              <span>Last Buy Error</span>
              <strong title={lastExecutionError}>
                {lastExecutionError || "NONE"}
              </strong>
            </article>
          </div>
        </section>

        <section className="oulControls">
          <label>
            <span>Stake</span>
            <input
              type="number"
              min="0.35"
              step="0.01"
              value={stake}
              onChange={(event) =>
                setStake(event.target.value)
              }
            />
          </label>

          <label>
            <span>Ticks</span>
            <input
              type="number"
              min="1"
              max="10"
              value={durationTicks}
              onChange={(event) =>
                setDurationTicks(
                  event.target.value
                )
              }
            />
          </label>

          <label>
            <span>Real Account</span>
            <select
              value={allowReal ? "ON" : "OFF"}
              onChange={(event) =>
                setAllowReal(
                  event.target.value === "ON"
                )
              }
            >
              <option value="OFF">LOCKED</option>
              <option value="ON">ENABLED</option>
            </select>
          </label>

          <label>
            <span>Sound</span>
            <select
              value={soundEnabled ? "ON" : "OFF"}
              onChange={(event) =>
                setSoundEnabled(
                  event.target.value === "ON"
                )
              }
            >
              <option value="ON">ON</option>
              <option value="OFF">OFF</option>
            </select>
          </label>
        </section>

        <section className="oulStats">
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
            <span>Win Rate</span>
            <strong>{pct(stats.winRate)}</strong>
          </article>
          <article>
            <span>P/L</span>
            <strong>{money(stats.profit)}</strong>
          </article>
          <article>
            <span>Switches</span>
            <strong>{switches}</strong>
          </article>
          <article>
            <span>Market</span>
            <strong>{symbol || "—"}</strong>
          </article>
          <article>
            <span>Account</span>
            <strong>{selectedAccountType}</strong>
          </article>
          <article>
            <span>Feed</span>
            <strong>
              {connected ? "LIVE" : "OFFLINE"}
            </strong>
          </article>
          <article>
            <span>Trading Auth</span>
            <strong>
              {authenticatedFeed && selectedAccountId
                ? "READY"
                : "BLOCKED"}
            </strong>
          </article>
        </section>

        <section className="oulMainGrid">
          <article className="oulPanel">
            <header>
              <div>
                <small>LAST 60 DIGITS</small>
                <h2>Rolling Speed Window</h2>
              </div>
              <strong>{digits.length}</strong>
            </header>

            <div className="oulDigits">
              {digits.map((digit, index) => (
                <span key={`${digit}-${index}`}>
                  {digit}
                </span>
              ))}
            </div>
          </article>

          <article className="oulPanel">
            <header>
              <div>
                <small>FAST CANDIDATES</small>
                <h2>EV + Probability Ranking</h2>
              </div>
            </header>

            <div className="oulCandidates">
              {rankedCandidates
                .slice(0, 8)
                .map((candidate) => (
                  <div
                    key={`${candidate.side}-${candidate.barrier}`}
                  >
                    <strong>
                      {candidate.contract}
                    </strong>
                    <span>
                      P {pct(candidate.probability)}
                    </span>
                    <span>
                      EV{" "}
                      {candidate.expectedValue.toFixed(
                        3
                      )}
                    </span>
                    <span>
                      Risk {pct(candidate.risk)}
                    </span>
                  </div>
                ))}
            </div>
          </article>
        </section>

        <section className="oulTransactionPanel">
          <header className="oulTransactionHeader">
            <div>
              <small>TRANSACTION MONITOR</small>
              <h2>RapidEdge V4.1 Trades</h2>
            </div>
          </header>

          <div className="oulTransactionScroll">
            <div className="oulTransactionHead">
              <span>Time</span>
              <span>Market</span>
              <span>Contract</span>
              <span>Stage</span>
              <span>Stake</span>
              <span>Status</span>
              <span>P/L</span>
              <span>Probability</span>
            </div>

            {trades.length ? (
              trades.map((trade) => (
                <div
                  className={`oulTransactionRow ${String(
                    trade.status || ""
                  ).toLowerCase()}`}
                  key={trade.id}
                >
                  <div className="oulTransactionMain">
                    <span>
                      {new Date(
                        trade.createdAt
                      ).toLocaleTimeString()}
                    </span>
                    <span>{trade.symbol}</span>
                    <span>{trade.contract}</span>
                    <span>{trade.stage}</span>
                    <span>{money(trade.stake)}</span>
                    <b>{trade.status}</b>
                    <span>{money(trade.profit)}</span>
                    <span>
                      {pct(trade.probability)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="oulNoTransactions">
                No RapidEdge V4.1 transactions yet.
              </p>
            )}
          </div>
        </section>

        <p className="oulDisclaimer">
          Speed mode does not guarantee profit or 20 trades
          every minute. Test on demo first.
        </p>
      </main>
    </div>
  );
}
