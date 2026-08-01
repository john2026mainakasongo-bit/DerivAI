
import { useDerivAuth } from "../auth/DerivAuthContext";

export default function Topbar({
  title,
  subtitle,
  connected = false,
  connecting = false,
  onConnect,
  onDisconnect,
}) {
  const auth = useDerivAuth();

  return (
    <header className="topbar">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>

      <div className="topbarActions">
        <div className={connected ? "connection connected" : "connection"}>
          <span className="statusDot" />
          {connected ? "Deriv live feed" : "Feed disconnected"}
        </div>

        <button
          type="button"
          className={connected ? "connectButton disconnect" : "connectButton"}
          disabled={connecting}
          onClick={connected ? onDisconnect : onConnect}
        >
          {connecting
            ? "Connecting..."
            : connected
            ? "Disconnect feed"
            : "Connect feed"}
        </button>

        {auth.authenticated ? (
          <>
            <button type="button" className="derivAccountButton">
              <span className="statusDot" />
              {auth.selectedAccount?.label || "Deriv account"}
            </button>

            <button
              type="button"
              className="derivLogoutButton"
              onClick={auth.logout}
            >
              Log out
            </button>
          </>
        ) : (
          <button
            type="button"
            className="derivLoginButton"
            disabled={auth.loading}
            onClick={auth.login}
          >
            {auth.loading ? "Signing in..." : "Log in with Deriv"}
          </button>
        )}

        {auth.authError ? (
          <div className="derivAuthInlineError">{auth.authError}</div>
        ) : null}
      </div>
    </header>
  );
}
