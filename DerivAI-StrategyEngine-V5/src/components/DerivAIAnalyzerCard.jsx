import { useMemo } from "react";
import "./DerivAIAnalyzerCard.css";

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, Number(n) || 0));

function buildThresholds(history = []) {
  const digits = history
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 9);

  const recent = digits.slice(-60);
  const source = recent.length ? recent : digits;
  const total = source.length || 1;

  const over = Array.from({ length: 9 }, (_, barrier) => {
    const hits = source.filter((d) => d > barrier).length;
    return {
      label: `OVER ${barrier}`,
      score: (hits / total) * 100,
    };
  });

  const under = Array.from({ length: 9 }, (_, i) => {
    const barrier = i + 1;
    const hits = source.filter((d) => d < barrier).length;
    return {
      label: `UNDER ${barrier}`,
      score: (hits / total) * 100,
    };
  });

  const even = source.filter((d) => d % 2 === 0).length / total * 100;
  const odd = 100 - even;

  return [
    ...over,
    ...under,
    { label: "EVEN", score: even },
    { label: "ODD", score: odd },
  ].sort((a, b) => b.score - a.score);
}

export default function DerivAIAnalyzerCard({ data }) {
  const {
    connected,
    market,
    lastDigit,
    digitHistory = [],
    currentPrice,
  } = data || {};

  const ranked = useMemo(
    () => buildThresholds(digitHistory),
    [digitHistory]
  );

  const best = ranked[0] || { label: "WAIT", score: 0 };
  const enoughData = digitHistory.length >= 30;
  const confidence = clamp(best.score);
  const valid = Boolean(
    connected &&
    enoughData &&
    confidence >= 76
  );

  const lastTen = digitHistory.slice(-10);

  const displayPrice =
    Number.isFinite(Number(currentPrice))
      ? Number(currentPrice).toFixed(
          market?.decimals ?? 2
        )
      : "—";

  return (
    <section
      className={
        valid
          ? "derivAnalyzerCard valid"
          : "derivAnalyzerCard"
      }
    >
      <div className="derivAnalyzerCardTop">
        <div>
          <small>AI MARKET ANALYZER</small>
          <h3>
            {market?.label || "Deriv Market"}
          </h3>
        </div>

        <div
          className={
            connected
              ? "derivAnalyzerLive on"
              : "derivAnalyzerLive"
          }
        >
          <span />
          {connected ? "LIVE" : "OFFLINE"}
        </div>
      </div>

      <div className="derivAnalyzerMain">
        <div className="derivAnalyzerSignal">
          <small>BEST SETUP</small>
          <strong>
            {enoughData ? best.label : "LEARNING"}
          </strong>
          <span>{confidence.toFixed(1)}%</span>
        </div>

        <div
          className={
            valid
              ? "derivAnalyzerDigit blink"
              : "derivAnalyzerDigit"
          }
        >
          {lastDigit ?? "—"}
        </div>

        <div className="derivAnalyzerStatus">
          <small>ENTRY</small>
          <strong>
            {valid
              ? "VALID"
              : enoughData
                ? "WAIT"
                : "COLLECTING"}
          </strong>
          <span>{displayPrice}</span>
        </div>
      </div>

      <div className="derivAnalyzerDigits">
        {lastTen.length ? (
          lastTen.map((digit, index) => (
            <span
              key={`${index}-${digit}`}
              className={
                index === lastTen.length - 1
                  ? "active"
                  : ""
              }
            >
              {digit}
            </span>
          ))
        ) : (
          <em>Waiting for live ticks...</em>
        )}
      </div>

      <div className="derivAnalyzerMini">
        {ranked.slice(0, 4).map((item, index) => (
          <div
            key={item.label}
            className={index === 0 ? "best" : ""}
          >
            <span>{item.label}</span>
            <b>{item.score.toFixed(0)}%</b>
          </div>
        ))}
      </div>

      <p className="derivAnalyzerNote">
        Green blink appears only after enough live samples
        and the current setup clears the entry filter.
      </p>
    </section>
  );
}
