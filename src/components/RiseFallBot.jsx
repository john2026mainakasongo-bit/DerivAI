import { useEffect, useMemo, useRef, useState } from "react";
import useDerivTicks from "../hooks/useDerivTicks";
import { useDerivAuth } from "../auth/DerivAuthContext";
import { analyzeRiseFall } from "../analysis/riseFallEngine";
import { createRiskManager } from "../bot/riskManager";
import "../styles/RiseFallBot.css";

const pct = (value) => `${Number(value || 0).toFixed(1)}%`;
const money = (value) => Number(value || 0).toFixed(2);

const idOf = (value) =>
  String(
    value?.contract_id ||
      value?.contractId ||
      value?.id ||
      value?.buy?.contract_id ||
      value?.proposal_open_contract?.contract_id ||
      ""
  );

const profitOf = (value) => {
  const direct = Number(
    value?.profit ?? value?.profit_loss ?? value?.pnl
  );

  if (Number.isFinite(direct)) return direct;

  return (
    Number(value?.sell_price || value?.payout || 0) -
    Number(value?.buy_price || value?.purchase_price || 0)
  );
};

const settled = (value) =>
  Boolean(
    value?.is_sold ||
      value?.is_expired ||
      ["won", "lost", "sold", "expired", "settled"].includes(
        String(value?.status || value?.contract_status || "").toLowerCase()
      )
  );

export default function RiseFallBot() {
  const auth = useDerivAuth();
  const {
    markets = [],
    market = null,
    symbol = "",
    status = "DISCONNECTED",
    statusDetail = "",
    connected = false,
    authenticatedFeed = false,
    selectedAccountType = "demo",
    selectedAccount = null,
    prices = [],
    currentPrice = null,
    openContracts = [],
    tradeBusy = false,
    tradeError = "",
    connect,
    disconnect,
    changeSymbol,
    placeTrade,
  } = useDerivTicks();

  const selectedBalance = Number(selectedAccount?.balance);
  const selectedCurrency = selectedAccount?.currency || "USD";
  const balanceText = Number.isFinite(selectedBalance)
    ? `${selectedCurrency} ${selectedBalance.toFixed(2)}`
    : "—";

  const [running, setRunning] = useState(false);
  const [stake, setStake] = useState(0.35);
  const [duration, setDuration] = useState(5);
  const [message, setMessage] = useState("Scanner ready.");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [allowReal, setAllowReal] = useState(false);

  const riskRef = useRef(createRiskManager());
  const busyRef = useRef(false);
  const processedRef = useRef(new Set());
  const lastAutoSignalRef = useRef("");
  const lastAutoAttemptRef = useRef(0);

  const analysis = useMemo(
    () =>
      analyzeRiseFall(prices, {
        minimumSamples: 60,
        minimumConfidence: 68,
      }),
    [prices]
  );

  const risk = riskRef.current.snapshot();

  useEffect(() => {
    for (const contract of openContracts) {
      if (!settled(contract)) continue;

      const id = idOf(contract);
      if (!id || processedRef.current.has(id)) continue;

      processedRef.current.add(id);
      riskRef.current.onResult(id, profitOf(contract));
    }
  }, [openContracts]);

  const execute = async (source = "manual") => {
    if (busyRef.current) return;

    if (!connected) {
      setMessage("Connect the Deriv feed first.");
      return;
    }

    if (!authenticatedFeed) {
      setMessage("Authenticated trading feed is not ready.");
      return;
    }

    if (analysis.signal === "WAIT" || !analysis.ready) {
      setMessage("No qualified Rise/Fall signal.");
      return;
    }

    if (
      String(selectedAccountType).toLowerCase() === "real" &&
      !allowReal
    ) {
      setMessage("REAL ACCOUNT LOCKED.");
      return;
    }

    const gate = riskRef.current.canTrade();

    if (!gate.ok) {
      setMessage(gate.reason);
      return;
    }

    busyRef.current = true;
    setMessage(
      `${source === "auto" ? "Auto" : "Manual"}: executing ${analysis.signal} ${analysis.confidence}%...`
    );

    try {
      const result = await placeTrade({
        contractType: analysis.contractType,
        amount: Number(stake),
        basis: "stake",
        duration: Number(duration),
        durationUnit: "t",
        symbol,
      });

      const id = idOf(result);
      riskRef.current.onEntry(id);

      setMessage(
        `${analysis.signal} opened${id ? ` #${id}` : ""}. Waiting for result...`
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Trade failed."
      );
    } finally {
      busyRef.current = false;
    }
  };

  // START BOT = scanning + automatic execution.
  // One automatic entry is allowed per fresh signal direction, with a short
  // retry guard so one unchanged tick signal cannot spam purchases.
  useEffect(() => {
    if (!running || !analysis.ready || analysis.signal === "WAIT") {
      return;
    }

    if (!authenticatedFeed) {
      setMessage("Bot waiting for authenticated trading feed.");
      return;
    }

    const now = Date.now();
    const signalKey = `${symbol}:${analysis.signal}`;

    if (
      signalKey === lastAutoSignalRef.current &&
      now - lastAutoAttemptRef.current < 3000
    ) {
      return;
    }

    if (signalKey === lastAutoSignalRef.current) {
      return;
    }

    lastAutoSignalRef.current = signalKey;
    lastAutoAttemptRef.current = now;

    void execute("auto");
  }, [
    analysis,
    authenticatedFeed,
    running,
    symbol,
  ]);

  const toggle = () => {
    if (running) {
      setRunning(false);
      setMessage("Bot stopped.");
      lastAutoSignalRef.current = "";
      return;
    }

    riskRef.current.reset();
    processedRef.current.clear();
    lastAutoSignalRef.current = "";
    lastAutoAttemptRef.current = 0;
    setRunning(true);
    setMessage("Bot scanning live ticks and waiting for a qualified signal.");
  };

  const winRate =
    risk.wins + risk.losses
      ? (risk.wins / (risk.wins + risk.losses)) * 100
      : 0;

  const price = Number.isFinite(currentPrice)
    ? currentPrice.toFixed(market?.decimals ?? 3)
    : "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â";

  const real =
    String(selectedAccountType).toLowerCase() === "real";

  const connectionLabel = !connected
    ? status
    : authenticatedFeed
      ? "LIVE ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ TRADING"
      : "LIVE ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ FEED ONLY";

  return (
    <section className="rfBot">
      <div className="rfBotTop">
        <div>
          <small>DERIV ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ RISE / FALL ENGINE</small>
          <h1>Pulse Rise/Fall</h1>
          <p>Momentum + trend + volatility filter</p>
        </div>

        <div className="rfConnection">
          <span className={authenticatedFeed ? "rfDot live" : "rfDot"} />
          {connectionLabel}
        </div>
      </div>

      <div className="rfAccountBalance">
        <div>
          <small>ACCOUNT</small>
          <strong>
            {selectedAccountType === "demo"
              ? "DEMO"
              : selectedAccountType === "real"
                ? "REAL"
                : "NOT SELECTED"}
          </strong>
          {selectedAccount?.id ? (
            <span>{String(selectedAccount.id)}</span>
          ) : null}
        </div>
        <div>
          <small>BALANCE</small>
          <strong>{balanceText}</strong>
          <span>
            {auth.balanceStatus === "live"
              ? "LIVE BALANCE"
              : auth.balanceStatus === "connecting"
                ? "CONNECTINGÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦"
                : "BALANCE OFFLINE"}
          </span>
        </div>
      </div>

      <div className="rfControls">
        <select
          value={symbol}
          disabled={!connected}
          onChange={(event) => void changeSymbol(event.target.value)}
        >
          {markets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>

        <button onClick={() => (connected ? disconnect() : connect())}>
          {connected ? "Disconnect" : "Connect"}
        </button>

        <button
          className={running ? "danger" : "primary"}
          onClick={toggle}
        >
          {running ? "STOP BOT" : "START BOT"}
        </button>
      </div>

      <div className="rfMain">
        <div className="rfSignal">
          <div className="rfSignalHeader">
            <div>
              <small>{market?.label || symbol || "MARKET"}</small>
              <strong>{price}</strong>
            </div>

            <div
              className={
                "rfSignalDirection " +
                (analysis.signal === "RISE"
                  ? "rise"
                  : analysis.signal === "FALL"
                    ? "fall"
                    : "")
              }
            >
              {analysis.signal}
            </div>
          </div>

          <div className="rfMeter">
            <div
              className="rfMeterFill"
              style={{
                width: `${Math.max(2, analysis.confidence || 0)}%`,
              }}
            />
          </div>

          <div className="rfProb">
            <span>
              <b>RISE</b>{" "}
              {analysis.signal === "RISE"
                ? pct(analysis.confidence)
                : "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â"}
            </span>

            <span>
              <b>FALL</b>{" "}
              {analysis.signal === "FALL"
                ? pct(analysis.confidence)
                : "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â"}
            </span>
          </div>

          <div className="rfConfidence">
            <small>MODEL CONFIDENCE</small>
            <strong>
              {analysis.ready ? pct(analysis.confidence) : "WAIT"}
            </strong>
          </div>

          <p className="rfReason">{analysis.reason}</p>

          <button
            className="rfTradeButton"
            disabled={tradeBusy || !authenticatedFeed || !analysis.ready || analysis.signal === "WAIT"}
            onClick={() => void execute("manual")}
          >
            {tradeBusy ? "EXECUTING..." : `TRADE ${analysis.signal}`}
          </button>
        </div>

        <div className="rfSide">
          <div className="rfGrid">
            <Metric label="TREND" value={analysis.trend || "WAIT"} />
            <Metric
              label="MOMENTUM"
              value={analysis.momentum || "WAIT"}
            />
            <Metric
              label="VOLATILITY"
              value={analysis.volatility || "WAIT"}
            />
            <Metric
              label="AGREEMENT"
              value={analysis.ready ? `${analysis.agreement}/4` : "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â"}
            />
          </div>

          <div className="rfStats">
            <span>
              <small>Session P/L</small>
              <b>{money(risk.sessionPnl)}</b>
            </span>

            <span>
              <small>Win rate</small>
              <b>{pct(winRate)}</b>
            </span>

            <span>
              <small>Trades</small>
              <b>{risk.trades}/10</b>
            </span>

            <span>
              <small>Stake</small>
              <b>${Number(stake).toFixed(2)}</b>
            </span>
          </div>
        </div>
      </div>

      <div className="rfBottom">
        <label>
          Stake{" "}
          <input
            type="number"
            min="0.35"
            step="0.01"
            value={stake}
            onChange={(event) =>
              setStake(
                Math.max(0.35, Number(event.target.value) || 0.35)
              )
            }
          />
        </label>

        <label>
          Ticks{" "}
          <select
            value={duration}
            onChange={(event) =>
              setDuration(Number(event.target.value))
            }
          >
            {[1, 2, 3, 5, 8, 10].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="rfToggle">
          <input
            type="checkbox"
            checked={allowReal}
            onChange={(event) => setAllowReal(event.target.checked)}
            disabled={!real}
          />
          ALLOW REAL
        </label>

        <button
          className="rfSettings"
          onClick={() => setSettingsOpen((value) => !value)}
        >
          {settingsOpen ? "HIDE" : "RISK"}
        </button>
      </div>

      {settingsOpen ? (
        <div className="rfRiskPanel">
          <span>
            Max session loss <b>$3.00</b>
          </span>
          <span>
            Max trades <b>10</b>
          </span>
          <span>
            Max open <b>1</b>
          </span>
          <span>
            2 losses <b>60s pause</b>
          </span>
          <span>
            Stake <b>FIXED</b>
          </span>
        </div>
      ) : null}

      <div className="rfStatus">
        <span>{running ? "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â SCANNING" : "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹ READY"}</span>
        <span>{message}</span>
      </div>

      {(statusDetail || tradeError) && (
        <div className="rfError">
          {tradeError || statusDetail}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rfMetric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

