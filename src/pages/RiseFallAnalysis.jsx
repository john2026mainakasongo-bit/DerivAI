
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
    selectedAccountType = "demo",
    selectedAccountId = "",
    openContracts = [],
    transactions = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const [mode, setMode] = useState("15s");
  const [feedMessage, setFeedMessage] = useState(
    "Connecting live feed…"
  );
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [signalLog, setSignalLog] = useState([]);
  const [autoRunning, setAutoRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [maxRuns, setMaxRuns] = useState(5);
  const [stopAfterLoss, setStopAfterLoss] = useState(true);
  const [allowReal, setAllowReal] = useState(false);
  const [durationMode, setDurationMode] = useState("AUTO");
  const [allowOneTick, setAllowOneTick] = useState(true);
  const [oneTickMinimumScore, setOneTickMinimumScore] = useState(78);
  const [oneTickMinimumConfidence, setOneTickMinimumConfidence] = useState(60);
  const [executionMessage, setExecutionMessage] = useState(
    "Auto execution is stopped."
  );
  const [executionRuns, setExecutionRuns] = useState(0);
  const [sessionTrades, setSessionTrades] = useState([]);
  const previousSignalRef = useRef("WAIT");
  const lastAlertAtRef = useRef(0);
  const lastExecutedSignalRef = useRef("");
  const executionBusyRef = useRef(false);
  const autoRunningRef = useRef(false);
  const executionRunsRef = useRef(0);

  const connectingRef = useRef(false);

  useEffect(() => {
    autoRunningRef.current = autoRunning;
  }, [autoRunning]);

  useEffect(() => {
    executionRunsRef.current = executionRuns;
  }, [executionRuns]);

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



  function contractIdOf(item = {}) {
    return String(
      item?.contract_id ||
        item?.id ||
        item?.contractId ||
        ""
    );
  }

  function contractStatus(item = {}) {
    const status = String(item?.status || "").toUpperCase();

    if (
      item?.is_sold ||
      item?.is_expired ||
      ["WON", "LOST", "SOLD", "EXPIRED"].includes(status)
    ) {
      return status || "CLOSED";
    }

    return status || "OPEN";
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

  function tradeParameters(signal, analysis) {
    const rise = signal === "RISE";
    const finalScore = Number(analysis?.scores?.final || 0);
    const confidence = Number(
      analysis?.smartConfidence ??
        analysis?.confidence ??
        0
    );

    const dynamicMinimumConfidence =
      durationMode === "1T"
        ? Number(oneTickMinimumConfidence || 60)
        : durationMode === "10T"
          ? 68
          : durationMode === "15S"
            ? 72
            : Number(oneTickMinimumConfidence || 60);

    const oneTickQualified =
      allowOneTick &&
      analysis?.fastScalpReady &&
      finalScore >= Number(oneTickMinimumScore || 78) &&
      (
        analysis?.instantOneTick ||
        (
          confidence >= dynamicMinimumConfidence &&
          Number(analysis?.entryScore || 0) >= 78
        )
      );

    if (durationMode === "1T") {
      if (!oneTickQualified) {
        return {
          blocked: true,
          reason:
            "1-tick mode is waiting for a strong fast-scalp entry.",
        };
      }

      return {
        contractType: rise ? "CALL" : "PUT",
        label: rise ? "RISE" : "FALL",
        duration: 1,
        durationUnit: "t",
        fastEntry: true,
        displayDuration: "1 TICK",
      };
    }

    if (durationMode === "AUTO" && oneTickQualified) {
      return {
        contractType: rise ? "CALL" : "PUT",
        label: rise ? "RISE" : "FALL",
        duration: 1,
        durationUnit: "t",
        fastEntry: true,
        displayDuration: "1 TICK",
      };
    }

    if (durationMode === "10T") {
      return {
        contractType: rise ? "CALL" : "PUT",
        label: rise ? "RISE" : "FALL",
        duration: 10,
        durationUnit: "t",
        fastEntry: false,
        displayDuration: "10 TICKS",
      };
    }

    if (durationMode === "15S") {
      return {
        contractType: rise ? "CALL" : "PUT",
        label: rise ? "RISE" : "FALL",
        duration: 15,
        durationUnit: "s",
        fastEntry: false,
        displayDuration: "15 SECONDS",
      };
    }

    return {
      contractType: rise ? "CALL" : "PUT",
      label: rise ? "RISE" : "FALL",
      duration: mode === "15s" ? 15 : 10,
      durationUnit: mode === "15s" ? "s" : "t",
      fastEntry: false,
      displayDuration:
        mode === "15s" ? "15 SECONDS" : "10 TICKS",
    };
  }

  function stopAuto(message) {
    autoRunningRef.current = false;
    setAutoRunning(false);
    setExecutionMessage(message);
  }

  async function executeConfirmedSignal(signal, analysis) {
    if (
      executionBusyRef.current ||
      !autoRunningRef.current ||
      !analysis?.tradeNow ||
      !signal ||
      signal === "WAIT"
    ) {
      return;
    }

    if (executionRunsRef.current >= Math.max(1, Number(maxRuns) || 1)) {
      stopAuto(`Maximum runs reached: ${maxRuns}.`);
      return;
    }

    if (!connected) {
      setExecutionMessage("Waiting for Deriv feed connection.");
      return;
    }

    if (!selectedAccountId) {
      stopAuto("Choose a Demo or Real Deriv account first.");
      return;
    }

    if (selectedAccountType !== "demo" && !allowReal) {
      stopAuto(
        "Real auto execution is locked. Enable Real execution explicitly or switch to Demo."
      );
      return;
    }

    if (typeof placeTrade !== "function") {
      stopAuto("Trade execution function is unavailable.");
      return;
    }

    const signature = [
      signal,
      mode,
      symbol,
      Number(analysis?.scores?.final || 0).toFixed(0),
      Number(analysis?.confirmationsPassed || 0),
    ].join(":");

    if (lastExecutedSignalRef.current === signature) return;

    executionBusyRef.current = true;
    lastExecutedSignalRef.current = signature;

    const parameters = tradeParameters(signal, analysis);
    const safeStake = Math.max(0.35, Number(stake) || 0.35);

    if (parameters.blocked) {
      lastExecutedSignalRef.current = "";
      executionBusyRef.current = false;
      setExecutionMessage(parameters.reason);
      return;
    }

    setExecutionMessage(
      `Sending ${parameters.label} · ${parameters.displayDuration} · stake ${safeStake.toFixed(2)}.`
    );

    try {
      playSignalTone(signal);

      const result = await placeTrade({
        symbol,
        contractType: parameters.contractType,
        amount: safeStake,
        basis: "stake",
        duration: parameters.duration,
        durationUnit: parameters.durationUnit,
      });

      const contractId = String(result?.contractId || "");
      const nextRuns = executionRunsRef.current + 1;

      executionRunsRef.current = nextRuns;
      setExecutionRuns(nextRuns);

      setSessionTrades((current) => [
        {
          id: contractId || `${Date.now()}-${signal}`,
          contractId,
          time: Date.now(),
          signal,
          mode,
          duration: parameters.duration,
          durationUnit: parameters.durationUnit,
          displayDuration: parameters.displayDuration,
          fastEntry: parameters.fastEntry,
          stake: safeStake,
          confidence: Number(analysis?.confidence || 0),
          finalScore: Number(analysis?.scores?.final || 0),
          status: "OPEN",
          profit: 0,
        },
        ...current,
      ].slice(0, 30));

      setExecutionMessage(
        `${parameters.label} trade opened${
          contractId ? ` · Contract ${contractId}` : ""
        }.`
      );

      if (nextRuns >= Math.max(1, Number(maxRuns) || 1)) {
        stopAuto(`Trade opened. Maximum runs reached: ${maxRuns}.`);
      }
    } catch (error) {
      lastExecutedSignalRef.current = "";
      setExecutionMessage(
        error instanceof Error
          ? error.message
          : "Trade execution failed."
      );
    } finally {
      executionBusyRef.current = false;
    }
  }

  function toggleAutoExecution() {
    if (autoRunning) {
      stopAuto("Auto execution stopped manually.");
      return;
    }

    if (selectedAccountType !== "demo" && !allowReal) {
      setExecutionMessage(
        "Enable Real execution explicitly or switch to Demo."
      );
      return;
    }

    executionRunsRef.current = 0;
    setExecutionRuns(0);
    lastExecutedSignalRef.current = "";
    setAutoRunning(true);
    autoRunningRef.current = true;
    setExecutionMessage(
      allowOneTick
        ? "Scanning. A very strong setup may execute as a 1-tick trade."
        : "Scanning for a confirmed TRADE RISE or TRADE FALL entry."
    );
  }

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


  useEffect(() => {
    if (!autoRunning || !active.tradeNow || active.autoSkip) return;

    void executeConfirmedSignal(active.signal, active);
  }, [
    autoRunning,
    active.tradeNow,
    active.signal,
    active.confirmationsPassed,
    active.scores?.final,
    symbol,
    mode,
  ]);

  useEffect(() => {
    const contracts = Array.isArray(openContracts) ? openContracts : [];

    if (!contracts.length) return;

    setSessionTrades((current) =>
      current.map((trade) => {
        const match = contracts.find(
          (contract) =>
            contractIdOf(contract) === String(trade.contractId || "")
        );

        if (!match) return trade;

        return {
          ...trade,
          status: contractStatus(match),
          profit: profitOf(match),
          currentSpot: Number(
            match?.current_spot ??
              match?.current_spot_display_value ??
              0
          ),
          entrySpot: Number(
            match?.entry_spot ??
              match?.entry_tick ??
              0
          ),
          exitSpot: Number(
            match?.exit_tick ??
              match?.exit_spot ??
              0
          ),
        };
      })
    );

    const latestClosed = contracts.find((contract) => {
      const id = contractIdOf(contract);

      return (
        id &&
        sessionTrades.some(
          (trade) => String(trade.contractId || "") === id
        ) &&
        ["WON", "LOST", "SOLD", "EXPIRED"].includes(
          contractStatus(contract)
        )
      );
    });

    if (
      latestClosed &&
      contractStatus(latestClosed) === "LOST" &&
      stopAfterLoss &&
      autoRunningRef.current
    ) {
      stopAuto(
        `Auto stopped after loss · ${profitOf(latestClosed).toFixed(2)}.`
      );
    }
  }, [openContracts, stopAfterLoss]);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent rfPage">
        <Topbar
          title="EdgePilot V68 · Rise/Fall Pro Analysis"
          subtitle="Consensus Engine with opportunity meter, quality grade, next-tick projection and auto-skip"
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
              className={`rfSideStartButton ${
                autoRunning ? "running" : "stopped"
              }`}
              disabled={tradeBusy}
              onClick={toggleAutoExecution}
            >
              {tradeBusy
                ? "SENDING..."
                : autoRunning
                  ? "■ STOP"
                  : "▶ START"}
            </button>

            <button
              type="button"
              className={`rfSoundToggle ${soundEnabled ? "on" : "off"}`}
              onClick={() => setSoundEnabled((value) => !value)}
            >
              {soundEnabled ? "🔊 SOUND ON" : "🔇 SOUND OFF"}
            </button>

            <select
              className="rfDurationSelect"
              value={durationMode}
              disabled={autoRunning}
              onChange={(event) => setDurationMode(event.target.value)}
            >
              <option value="AUTO">AUTO DURATION</option>
              <option value="1T">1 TICK</option>
              <option value="10T">10 TICKS</option>
              <option value="15S">15 SECONDS</option>
            </select>

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


        <section className={`rfAutoPanel ${autoRunning ? "running" : "stopped"}`}>
          <div className="rfAutoPanelHead">
            <div>
              <small>RISE/FALL AUTO EXECUTION</small>
              <h2>{autoRunning ? "RUNNING" : "STOPPED"}</h2>
              <p>{executionMessage || tradeError}</p>
            </div>

            <button
              type="button"
              className={autoRunning ? "stop" : "start"}
              disabled={tradeBusy}
              onClick={toggleAutoExecution}
            >
              {tradeBusy
                ? "SENDING..."
                : autoRunning
                  ? "STOP"
                  : "START"}
            </button>
          </div>

          <div className="rfAutoControls">
            <label>
              <span>Stake</span>
              <input
                type="number"
                min="0.35"
                step="0.01"
                value={stake}
                disabled={autoRunning}
                onChange={(event) => setStake(event.target.value)}
              />
            </label>

            <label>
              <span>Maximum runs</span>
              <input
                type="number"
                min="1"
                max="50"
                value={maxRuns}
                disabled={autoRunning}
                onChange={(event) => setMaxRuns(event.target.value)}
              />
            </label>

            <div>
              <span>Contract</span>
              <strong>
                {durationMode === "1T"
                  ? "RISE/FALL · 1 TICK"
                  : durationMode === "10T"
                    ? "RISE/FALL · 10 TICKS"
                    : durationMode === "15S"
                      ? "RISE/FALL · 15 SECONDS"
                      : "RISE/FALL · AUTO"}
              </strong>
            </div>

            <div>
              <span>Session runs</span>
              <strong>{executionRuns}/{maxRuns}</strong>
            </div>

            <label>
              <span>1-tick minimum score</span>
              <input
                type="number"
                min="70"
                max="100"
                value={oneTickMinimumScore}
                disabled={autoRunning || !allowOneTick}
                onChange={(event) =>
                  setOneTickMinimumScore(event.target.value)
                }
              />
            </label>

            <label>
              <span>1-tick minimum confidence</span>
              <input
                type="number"
                min="55"
                max="100"
                value={oneTickMinimumConfidence}
                disabled={autoRunning || !allowOneTick}
                onChange={(event) =>
                  setOneTickMinimumConfidence(event.target.value)
                }
              />
            </label>
          </div>

          <div className="rfAutoChecks">
            <label>
              <input
                type="checkbox"
                checked={allowOneTick}
                disabled={autoRunning}
                onChange={(event) => setAllowOneTick(event.target.checked)}
              />
              Allow 1-tick execution only for strongest entries
            </label>

            <label>
              <input
                type="checkbox"
                checked={stopAfterLoss}
                onChange={(event) => setStopAfterLoss(event.target.checked)}
              />
              Stop automatically after one loss
            </label>

            <label className={selectedAccountType === "demo" ? "disabled" : ""}>
              <input
                type="checkbox"
                checked={allowReal}
                disabled={selectedAccountType === "demo" || autoRunning}
                onChange={(event) => setAllowReal(event.target.checked)}
              />
              I understand and enable Real-account execution
            </label>

            <span>
              Account: <strong>{String(selectedAccountType).toUpperCase()}</strong>
            </span>
          </div>
        </section>

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

        <section className="rfConsensusHero">
          <div>
            <small>AI CONSENSUS ENGINE</small>
            <h2>{active.aiDecision || "WAIT"}</h2>
            <p>
              {active.autoSkip
                ? active.skipReason || "Searching for a cleaner setup."
                : `${active.consensus?.riseVotes || 0} RISE · ${active.consensus?.fallVotes || 0} FALL · ${active.consensus?.waitVotes || 0} WAIT`}
            </p>
          </div>

          <div className="rfConsensusStats">
            <span>
              <small>Opportunity</small>
              <strong>{pct(active.opportunityScore)}</strong>
            </span>
            <span>
              <small>Consensus</small>
              <strong>
                {active.consensus?.riseVotes || 0}/{active.consensus?.total || 12} R ·{" "}
                {active.consensus?.fallVotes || 0}/{active.consensus?.total || 12} F
              </strong>
            </span>
            <span>
              <small>Quality</small>
              <strong>{active.quality || "REJECT"}</strong>
            </span>
            <span>
              <small>Entry window</small>
              <strong>{active.entryWindow?.label || "WAIT"}</strong>
            </span>
          </div>
        </section>

        <section className="rfProfessionalSummary">
          <article>
            <small>SMART CONFIDENCE</small>
            <strong>{pct(active.smartConfidence)}</strong>
            <span>Built from weighted trend, pressure, momentum and order flow.</span>
          </article>

          <article>
            <small>AI ENTRY SCORE</small>
            <strong>{pct(active.entryScore)}</strong>
            <span>{active.aiDecision || "WAIT"}</span>
          </article>

          <article>
            <small>DYNAMIC BUY LEVEL</small>
            <strong>
              {Number(active.adaptiveThresholds?.buy || 72).toFixed(0)}
            </strong>
            <span>
              {active.regime || "UNKNOWN"} regime · {pct(active.noiseRatio)} noise
            </span>
          </article>

          <article>
            <small>RISK</small>
            <strong>{active.risk || "HIGH"}</strong>
            <span>
              Instant level {Number(active.adaptiveThresholds?.instant || 88).toFixed(0)}
            </span>
          </article>
        </section>

        <section className="rfConsensusBoard">
          <div className="rfPanelHead">
            <div>
              <small>ANALYSIS VOTES</small>
              <h2>Consensus by engine</h2>
            </div>
            <span>
              {pct(active.consensus?.score)}
            </span>
          </div>

          <div className="rfVoteGrid">
            {(active.consensus?.votes || []).map((item) => (
              <article
                key={item.name}
                className={String(item.vote || "WAIT").toLowerCase()}
              >
                <small>{item.name}</small>
                <strong>{item.vote || "WAIT"}</strong>
              </article>
            ))}
          </div>
        </section>

        <section className="rfNextTickPanel">
          <div>
            <small>NEXT 5 TICKS</small>
            <h2>
              {(active.nextTicks?.ticks || []).map((tick, index) => (
                <span
                  key={`${tick}-${index}`}
                  className={String(tick).toLowerCase()}
                >
                  {tick === "RISE" ? "↑" : tick === "FALL" ? "↓" : "—"}
                </span>
              ))}
            </h2>
          </div>

          <div>
            <small>PREDICTION CONFIDENCE</small>
            <strong>{pct(active.nextTicks?.confidence)}</strong>
          </div>

          <div>
            <small>MARKET REGIME</small>
            <strong>{active.regime || "UNKNOWN"}</strong>
          </div>

          <div>
            <small>TRADE STRENGTH</small>
            <strong>
              {active.quality === "A+"
                ? "EXTREME"
                : active.quality === "A"
                  ? "STRONG"
                  : active.quality === "B"
                    ? "MEDIUM"
                    : active.quality === "C"
                      ? "WEAK"
                      : "REJECT"}
            </strong>
          </div>
        </section>

        <section className="rfAiEntryTerminal">
          <div className="rfPanelHead">
            <div>
              <small>AI ENTRY ENGINE</small>
              <h2>
                {active.aiDecision || "WAIT"}
              </h2>
            </div>

            <span
              className={
                active.instantOneTick
                  ? "instant"
                  : active.strongTrade
                    ? "strong"
                    : active.fastScalpReady
                      ? "ready"
                      : "wait"
              }
            >
              {pct(active.entryScore)}
            </span>
          </div>

          <div className="rfAiEntryGrid">
            {[
              ["Micro trend", active.weightedScores?.microTrend],
              ["Pressure", active.weightedScores?.pressure],
              ["Momentum", active.weightedScores?.momentum],
              ["EMA", active.weightedScores?.ema],
              ["Continuation", active.weightedScores?.continuation],
              ["Direction stability", active.weightedScores?.stability],
              ["Order flow", active.weightedScores?.orderFlow],
              ["EMA ribbon", active.weightedScores?.ribbon],
              ["Candle sequence", active.weightedScores?.sequence],
              ["Pullback quality", active.weightedScores?.pullback],
              ["Tick rhythm", active.weightedScores?.rhythm],
              ["Noise safety", active.weightedScores?.noise],
              ["Base entry score", active.baseEntryScore],
              ["Impulse booster", active.weightedScores?.impulseBoost],
              ["Acceleration booster", active.weightedScores?.accelerationBoost],
              ["Smart confidence", active.smartConfidence],
              ["AI final score", active.entryScore],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{Number(value || 0).toFixed(0)}</strong>
                <i>
                  <b
                    style={{
                      width: `${Math.max(
                        0,
                        Math.min(100, Number(value || 0))
                      )}%`,
                    }}
                  />
                </i>
              </div>
            ))}
          </div>

          <div className="rfEntryThresholds">
            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.prepare || 65)
                  ? "passed"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.prepare || 65).toFixed(0)}+ PREPARE
            </span>

            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.buy || 72)
                  ? "passed"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.buy || 72).toFixed(0)}+ AUTO BUY
            </span>

            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.strong || 80)
                  ? "passed"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.strong || 80).toFixed(0)}+ STRONG BUY
            </span>

            <span
              className={
                active.entryScore >=
                Number(active.adaptiveThresholds?.instant || 88)
                  ? "passed instant"
                  : ""
              }
            >
              {Number(active.adaptiveThresholds?.instant || 88).toFixed(0)}+ INSTANT 1 TICK
            </span>
          </div>

          <div className="rfMicroVotes">
            {(active.microTrend?.windows || []).map((item) => (
              <span
                key={item.size}
                className={String(item.direction).toLowerCase()}
              >
                {item.size} {item.direction === "RISE" ? "↑" : item.direction === "FALL" ? "↓" : "—"}
              </span>
            ))}
          </div>

          <div className="rfAiTelemetry">
            <span>
              Velocity <strong>{num(active.velocity, 6)}</strong>
            </span>
            <span>
              Acceleration <strong>{num(active.acceleration, 6)}</strong>
            </span>
            <span>
              Compression <strong>{pct(active.compression)}</strong>
            </span>
            <span>
              Expansion <strong>{pct(active.expansion)}</strong>
            </span>
            <span>
              Exhaustion <strong>{pct(active.exhaustion)}</strong>
            </span>
          </div>
        </section>

        <section className="rfMicroGrid">
          <article>
            <small>FAST SCALP STATUS</small>
            <strong>
              {active.fastScalpReady
                ? "1-TICK READY"
                : active.entryScore >= 70
                  ? "PREPARE"
                  : "WAIT"}
            </strong>
            <span>
              Entry uses the weighted score. Impulse and acceleration only add bonus points.
            </span>
          </article>

          <article>
            <small>TICK IMPULSE</small>
            <strong>
              {active.impulse?.direction || "FLAT"}{" "}
              {pct(active.impulse?.score)}
            </strong>
            <span>
              Acceleration {num(active.impulse?.acceleration, 6)}
            </span>
          </article>

          <article>
            <small>PERSISTENCE</small>
            <strong>{pct(active.persistence)}</strong>
            <span>Recent ticks moving consistently.</span>
          </article>

          <article>
            <small>NOISE RATIO</small>
            <strong>{pct(active.noiseRatio)}</strong>
            <span>Lower is cleaner for fast entry.</span>
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


        <section className="rfDeepAnalysisGrid">
          <article>
            <small>ORDER FLOW DELTA</small>
            <strong>
              {Number(active.flowDelta?.delta || 0).toFixed(1)}
            </strong>
            <span>
              Buy {pct(active.flowDelta?.buy)} · Sell {pct(active.flowDelta?.sell)}
            </span>
          </article>

          <article>
            <small>DIRECTION STABILITY</small>
            <strong>{pct(active.stability)}</strong>
            <span>Agreement across short, medium and long windows.</span>
          </article>

          <article>
            <small>EMA RIBBON</small>
            <strong>{active.ribbon?.state || "MIXED"}</strong>
            <span>
              3 / 5 / 8 / 13 EMA structure.
            </span>
          </article>

          <article>
            <small>CANDLE SEQUENCE</small>
            <strong>
              {active.sequence?.direction || "FLAT"}{" "}
              {pct(active.sequence?.score)}
            </strong>
            <span>Recent directional sequence.</span>
          </article>

          <article>
            <small>PULLBACK QUALITY</small>
            <strong>{pct(active.pullbackScore)}</strong>
            <span>Continuation, pressure and consistency combined.</span>
          </article>

          <article>
            <small>MEAN REVERSION</small>
            <strong>{pct(active.meanReversion)}</strong>
            <span>Higher means stronger snap-back risk.</span>
          </article>

          <article>
            <small>ATR EXPANSION</small>
            <strong>{pct(active.atrExpansion)}</strong>
            <span>Fresh move size versus recent baseline.</span>
          </article>

          <article>
            <small>TICK RHYTHM</small>
            <strong>{pct(active.rhythm)}</strong>
            <span>How consistently consecutive ticks repeat direction.</span>
          </article>
        </section>

        <section className="rfAdvancedTools">
          <article>
            <small>CONSECUTIVE TICK BIAS</small>
            <strong>
              {active.bias?.direction || "FLAT"}{" "}
              {active.bias?.count || 0}
            </strong>
            <span>Score {pct(active.bias?.score)}</span>
          </article>

          <article>
            <small>VOLATILITY STATE</small>
            <strong>{active.squeeze?.state || "NORMAL"}</strong>
            <span>
              Breakout readiness {pct(active.squeeze?.breakoutReadiness)}
            </span>
          </article>

          <article>
            <small>LIQUIDITY SWEEP</small>
            <strong>{active.liquiditySweep?.state || "NONE"}</strong>
            <span>Score {pct(active.liquiditySweep?.score)}</span>
          </article>

          <article>
            <small>MICRO REVERSAL</small>
            <strong>{active.microReversal?.direction || "NONE"}</strong>
            <span>Score {pct(active.microReversal?.score)}</span>
          </article>

          <article>
            <small>SUPPORT REACTION</small>
            <strong>{pct(active.supportReaction)}</strong>
            <span>Recent response from support.</span>
          </article>

          <article>
            <small>RESISTANCE REACTION</small>
            <strong>{pct(active.resistanceReaction)}</strong>
            <span>Recent response from resistance.</span>
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


        <section className="rfTradeViewer">
          <div className="rfPanelHead">
            <div>
              <small>TRADE VIEWER</small>
              <h2>Open and recent Rise/Fall trades</h2>
            </div>

            <span>
              {sessionTrades.length} session trade
              {sessionTrades.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="rfTradeTableWrap">
            <table className="rfTradeTable">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Contract</th>
                  <th>Duration</th>
                  <th>Stake</th>
                  <th>Status</th>
                  <th>Confidence</th>
                  <th>Score</th>
                  <th>P/L</th>
                  <th>ID</th>
                </tr>
              </thead>

              <tbody>
                {sessionTrades.map((trade) => (
                  <tr key={trade.id}>
                    <td>
                      {new Date(trade.time).toLocaleTimeString()}
                    </td>
                    <td className={signalClass(trade.signal)}>
                      {trade.signal}
                    </td>
                    <td>
                      {trade.displayDuration ||
                        (trade.mode === "15s"
                          ? "15 sec"
                          : "10 ticks")}
                    </td>
                    <td>{Number(trade.stake || 0).toFixed(2)}</td>
                    <td>{trade.status || "OPEN"}</td>
                    <td>{pct(trade.confidence)}</td>
                    <td>{Number(trade.finalScore || 0).toFixed(0)}</td>
                    <td
                      className={
                        Number(trade.profit || 0) > 0
                          ? "profit"
                          : Number(trade.profit || 0) < 0
                            ? "loss"
                            : ""
                      }
                    >
                      {Number(trade.profit || 0).toFixed(2)}
                    </td>
                    <td>{trade.contractId || "—"}</td>
                  </tr>
                ))}

                {!sessionTrades.length ? (
                  <tr>
                    <td colSpan="9" className="empty">
                      Press START. Confirmed trades will appear here.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <details className="rfRawTrades">
            <summary>
              View Deriv open-contract and transaction feed
            </summary>

            <div>
              <article>
                <h3>Open contract feed</h3>
                <pre>
                  {JSON.stringify(
                    (Array.isArray(openContracts) ? openContracts : []).slice(0, 5),
                    null,
                    2
                  )}
                </pre>
              </article>

              <article>
                <h3>Recent transactions</h3>
                <pre>
                  {JSON.stringify(
                    (Array.isArray(transactions) ? transactions : []).slice(0, 10),
                    null,
                    2
                  )}
                </pre>
              </article>
            </div>
          </details>
        </section>

        <div className="rfSafety">
          Analysis only. A high confidence score does not guarantee
          that the next price will rise or fall.
        </div>
      </main>
    </div>
  );
}
