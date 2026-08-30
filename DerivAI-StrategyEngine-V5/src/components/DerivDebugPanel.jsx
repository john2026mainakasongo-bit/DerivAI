import { useMemo, useState } from "react";

function JsonBlock({ value }) {
  return (
    <pre className="debugJson">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function DerivDebugPanel({
  inspection,
  debugLog = [],
  status,
  statusDetail,
}) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState("summary");

  const recentMessages = useMemo(
    () => debugLog.slice(-20).reverse(),
    [debugLog]
  );

  return (
    <section className="debugPanel">
      <div className="debugPanelTop">
        <div>
          <small>DIAGNOSTICS</small>
          <h2>Deriv API Debug</h2>
          <p>
            Shows the exact symbol fields and raw WebSocket responses received.
          </p>
        </div>

        <button
          type="button"
          className="debugToggle"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide Debug" : "Open Debug"}
        </button>
      </div>

      {open ? (
        <>
          <div className="debugTabs">
            {["summary", "symbols", "messages", "raw"].map((item) => (
              <button
                type="button"
                key={item}
                className={tab === item ? "active" : ""}
                onClick={() => setTab(item)}
              >
                {item}
              </button>
            ))}
          </div>

          {tab === "summary" ? (
            <div className="debugSummary">
              <div>
                <span>Status</span>
                <strong>{status}</strong>
              </div>
              <div>
                <span>Error detail</span>
                <strong>{statusDetail || "None"}</strong>
              </div>
              <div>
                <span>Brief count</span>
                <strong>{inspection?.briefCount ?? "—"}</strong>
              </div>
              <div>
                <span>Full count</span>
                <strong>{inspection?.fullCount ?? "—"}</strong>
              </div>
              <div>
                <span>Volatility detected</span>
                <strong>
                  {inspection?.volatilityMarkets?.length ?? "—"}
                </strong>
              </div>
              <div>
                <span>Detected response fields</span>
                <strong>
                  {inspection?.detectedFields?.join(", ") || "—"}
                </strong>
              </div>
            </div>
          ) : null}

          {tab === "symbols" ? (
            <div className="debugTableWrap">
              <table className="debugTable">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Label</th>
                    <th>Symbol</th>
                    <th>Pip</th>
                    <th>Market</th>
                    <th>Submarket</th>
                  </tr>
                </thead>
                <tbody>
                  {(inspection?.allMarkets || []).map((market, index) => (
                    <tr key={`${market.id}-${index}`}>
                      <td>{index + 1}</td>
                      <td>{market.label}</td>
                      <td>{market.id}</td>
                      <td>{market.pip}</td>
                      <td>{market.marketDisplayName || market.market}</td>
                      <td>{market.submarketDisplayName || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {tab === "messages" ? (
            <div className="debugMessages">
              {recentMessages.map((event, index) => (
                <article key={`${event.time}-${index}`}>
                  <header>
                    <strong>{event.direction}</strong>
                    <span>{event.msgType}</span>
                    <time>{event.time}</time>
                  </header>
                  <JsonBlock value={event.payload} />
                </article>
              ))}
            </div>
          ) : null}

          {tab === "raw" ? (
            <JsonBlock
              value={{
                inspection,
                recentMessages,
              }}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
