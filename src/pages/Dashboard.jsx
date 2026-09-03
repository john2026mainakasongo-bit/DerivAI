import { useEffect, useState } from "react";
import { completeDerivLogin } from "../auth/derivOAuth";
import RiseFallBot from "../components/RiseFallBot";

export default function Dashboard() {
  const [oauthError, setOauthError] = useState("");
  const [completingOAuth, setCompletingOAuth] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function finish() {
      const url = new URL(window.location.href);

      if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
        return;
      }

      try {
        setCompletingOAuth(true);
        setOauthError("");

        const session = await completeDerivLogin();

        if (!cancelled && session?.accessToken) {
          window.history.replaceState({}, document.title, window.location.pathname);
          window.location.reload();
        }
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

    void finish();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="cleanBotPage">
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
  );
}
