import { useEffect, useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import StrategyLab from "../components/StrategyLab";
import useDerivTicks from "../hooks/useDerivTicks";
import { completeDerivLogin } from "../auth/derivOAuth";

export default function Dashboard() {
  const [oauthError, setOauthError] = useState("");
  const [completingOAuth, setCompletingOAuth] = useState(false);
  const deriv = useDerivTicks();

  const {
    markets,
    market,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    connect,
    disconnect,
    changeSymbol,
  } = deriv;

  useEffect(() => {
    let cancelled = false;

    async function finishOAuthLogin() {
      const currentUrl = new URL(window.location.href);
      const hasCode = currentUrl.searchParams.has("code");
      const hasOAuthError = currentUrl.searchParams.has("error");

      if (!hasCode && !hasOAuthError) return;

      try {
        setCompletingOAuth(true);
        setOauthError("");
        const session = await completeDerivLogin();

        if (cancelled) return;
        if (session?.accessToken) window.location.reload();
      } catch (error) {
        if (!cancelled) {
          setOauthError(
            error instanceof Error
              ? error.message
              : "Unable to complete Deriv login."
          );
        }
      } finally {
        if (!cancelled) setCompletingOAuth(false);
      }
    }

    finishOAuthLogin();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="appShell strategyOnlyApp">
      <Sidebar />

      <main className="mainContent strategyOnlyMain">
        <Topbar
          title="Deriv Strategy Engine"
          subtitle="Live calibrated signals, validation and walk-forward testing"
          connected={connected}
          connecting={loadingMarket || completingOAuth}
          onConnect={connect}
          onDisconnect={disconnect}
        />

        {completingOAuth ? (
          <div className="connectionError">Completing Deriv login. Please wait...</div>
        ) : null}

        {oauthError ? (
          <div className="connectionError">Deriv login failed: {oauthError}</div>
        ) : null}

        <section className="toolbar strategyToolbar">
          <MarketSelector
            markets={markets}
            value={symbol}
            disabled={loadingMarket || completingOAuth}
            onChange={changeSymbol}
          />

          <div className={connected ? "liveBadge connected" : "liveBadge"}>
            ● {connected ? "DERIV LIVE" : status}
          </div>

          <div className="strategyMarketInfo">
            {market?.label || symbol}
          </div>
        </section>

        {statusDetail ? (
          <div className="connectionError">{statusDetail}</div>
        ) : null}

        <StrategyLab data={deriv} />
      </main>
    </div>
  );
}
