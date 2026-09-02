import { useEffect, useMemo, useState } from "react";

export default function PulseRiseCore({ data }) {
  const {
    connected,
    market,
    symbol,
    currentPrice,
    prices,
    lastDigit,
  } = data || {};

  const [running, setRunning] = useState(false);
  const [autoExecute, setAutoExecute] = useState(false);

  const analysis = useMemo(() => {
    const values = Array.isArray(prices) ? prices.slice(-30) : [];

    if (values.length < 5) {
      return {
        direction: "WAIT",
        rise: 50,
        fall: 50,
        confidence: 0,
        score: 0,
        votes: "0/0",
      };
    }

    let riseVotes = 0;
    let fallVotes = 0;

    for (let i = 1; i < values.length; i += 1) {
      if (values[i] > values[i - 1]) riseVotes += 1;
      if (values[i] < values[i - 1]) fallVotes += 1;
    }

    const total = riseVotes + fallVotes || 1;
    const rise = (riseVotes / total) * 100;
    const fall = (fallVotes / total) * 100;
    const confidence = Math.max(rise, fall);
    const direction =
      confidence >= 60
        ? rise > fall
          ? "RISE"
          : "FALL"
        : "WAIT";

    return {
      direction,
      rise,
      fall,
      confidence,
      score: Math.round(confidence),
      votes: `${Math.max(riseVotes, fallVotes)}/${total}`,
    };
  }, [prices]);

  useEffect(() => {
    if (!running) return undefined;

    const timer = window.setInterval(() => {
      // Continuous signal refresh is driven by the live Dashboard feed.
      // Trade execution remains intentionally disabled until verified.
    }, 1000);

    return () => window.clearInterval(timer);
  }, [running]);

  const price =
    Number.isFinite(currentPrice)
      ? currentPrice.toFixed(market?.decimals ?? 2)
      : "—";

  return (
    <section className="pulseRiseCore">
      <div className="pulseRiseHeader">
        <div>
          <span className="pulseRiseEyebrow">PULSERISE CORE</span>
          <h2>Continuous Rise/Fall Bot</h2>
          <p>
            {symbol || market?.label || "No market selected"} ·{" "}
            {connected ? "LIVE" : "OFFLINE"}
          </p>
        </div>

        <div className="pulseRiseActions">
          <button
            type="button"
            className={running ? "danger" : "primary"}
            onClick={() => setRunning((value) => !value)}
          >
            {running ? "STOP BOT" : "START BOT"}
          </button>

          <label className="pulseRiseSwitch">
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(event) =>
                setAutoExecute(event.target.checked)
              }
            />
            <span>Auto Execute</span>
          </label>
        </div>
      </div>

      <div className="pulseRiseGrid">
        <div className="pulseRiseCard signal">
          <span>Signal</span>
          <strong className={analysis.direction.toLowerCase()}>
            {analysis.direction}
          </strong>
        </div>

        <div className="pulseRiseCard">
          <span>Rise</span>
          <strong>{analysis.rise.toFixed(1)}%</strong>
        </div>

        <div className="pulseRiseCard">
          <span>Fall</span>
          <strong>{analysis.fall.toFixed(1)}%</strong>
        </div>

        <div className="pulseRiseCard">
          <span>Confidence</span>
          <strong>{analysis.confidence.toFixed(1)}%</strong>
        </div>

        <div className="pulseRiseCard">
          <span>Score</span>
          <strong>{analysis.score}</strong>
        </div>

        <div className="pulseRiseCard">
          <span>Votes</span>
          <strong>{analysis.votes}</strong>
        </div>

        <div className="pulseRiseCard">
          <span>Price</span>
          <strong>{price}</strong>
        </div>

        <div className="pulseRiseCard">
          <span>Last digit</span>
          <strong>{lastDigit ?? "—"}</strong>
        </div>
      </div>

      <div className="pulseRiseFooter">
        <span>
          Status: <b>{running ? "SCANNING" : "READY"}</b>
        </span>
        <span>
          Execution:{" "}
          <b>{autoExecute ? "ARMED" : "SIGNAL ONLY"}</b>
        </span>
        <span>
          Duration: <b>15 SEC</b>
        </span>
      </div>
    </section>
  );
}
