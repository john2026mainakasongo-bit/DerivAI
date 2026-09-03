import { useState } from "react";

import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import MarketSelector from "../components/MarketSelector";
import useDerivTicks from "../hooks/useDerivTicks";

export default function Dashboard() {
  const deriv = useDerivTicks();

  const {
    markets,
    symbol,
    status,
    statusDetail,
    connected,
    loadingMarket,
    connect,
    disconnect,
    changeSymbol,
  } = deriv;

  const [message, setMessage] = useState("");

  return (
    <div className="cleanShell">
      <Sidebar />

      <main className="cleanMain">
        <Topbar
          title="DerivAI"
          subtitle="Clean trading engine workspace"
          connected={connected}
          connecting={loadingMarket}
          onConnect={async () => {
            try {
              await connect();
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Unable to connect to Deriv."
              );
            }
          }}
          onDisconnect={disconnect}
        />

        <section className="connectionPanel">
          <div>
            <span className="eyebrow">DERIV CONNECTION</span>
            <h1>{connected ? "Connected" : "Ready to connect"}</h1>
            <p>
              {statusDetail ||
                (connected
                  ? "Live Deriv feed is active."
                  : "Connect your Deriv account before building the new trading engine.")}
            </p>
          </div>

          <div className="connectionControls">
            <MarketSelector
              markets={markets}
              value={symbol}
              disabled={loadingMarket}
              onChange={changeSymbol}
            />

            <span
              className={
                connected
                  ? "connectionBadge online"
                  : "connectionBadge"
              }
            >
              {connected ? "DERIV LIVE" : status}
            </span>
          </div>
        </section>

        {message ? (
          <div className="connectionMessage">
            {message}
          </div>
        ) : null}

        <section className="newProjectPanel">
          <span className="eyebrow">NEW PROJECT</span>
          <h2>Trading Engine Ready</h2>
          <p>
            This workspace is intentionally clean.
            The new bot will be built here from scratch.
          </p>
        </section>
      </main>
    </div>
  );
}
