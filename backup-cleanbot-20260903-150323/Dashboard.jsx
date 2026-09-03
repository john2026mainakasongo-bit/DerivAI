import { useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";
import { completeDerivLogin } from "../auth/derivOAuth";
import RiseFallBot from "../components/RiseFallBot";

export default function Dashboard() {
  const [oauthError, setOauthError] = useState("");
  const [completingOAuth, setCompletingOAuth] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function finish() {
      const u = new URL(window.location.href);

      if (
        !u.searchParams.has("code") &&
        !u.searchParams.has("error")
      ) {
        return;
      }

      try {
        setCompletingOAuth(true);
        setOauthError("");

        const s = await completeDerivLogin();

        if (!cancelled && s?.accessToken) {
          window.history.replaceState(
            {},
            document.title,
            window.location.pathname
          );

          window.location.reload();
        }
      } catch (e) {
        if (!cancelled) {
          setOauthError(
            e instanceof Error
              ? e.message
              : "Unable to complete Deriv login."
          );
        }
      } finally {
        if (!cancelled) {
          setCompletingOAuth(false);
        }
      }
    }

    void finish();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="appShell">
      <Sidebar />

      <main className="mainContent">
        <Topbar
          title="DerivAI"
          subtitle="Compact Rise/Fall trading engine"
        />

        {completingOAuth ? (
          <div className="connectionError">
            Completing Deriv login. Please wait...
          </div>
        ) : null}

        {oauthError ? (
          <div className="connectionError">
            Deriv login failed: {oauthError}
          </div>
        ) : null}

        <RiseFallBot />
      </main>
    </div>
  );
}
