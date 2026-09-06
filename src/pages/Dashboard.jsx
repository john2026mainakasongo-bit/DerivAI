import { useEffect, useState } from "react";
import { completeDerivLogin } from "../auth/derivOAuth";
import { useDerivAuth } from "../auth/DerivAuthContext";
import RiseFallBot from "../components/RiseFallBot";
import TouchNoTouchBot from "../components/TouchNoTouchBot";
import "../styles/DashboardDual.css";

export default function Dashboard() {
  const auth = useDerivAuth();
  const [oauthError, setOauthError] = useState("");
  const [completingOAuth, setCompletingOAuth] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function finish() {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("code") && !url.searchParams.has("error")) return;
      try {
        setCompletingOAuth(true);
        setOauthError("");
        const session = await completeDerivLogin();
        if (!cancelled && session?.accessToken) {
          window.history.replaceState({}, document.title, window.location.pathname);
          window.location.reload();
        }
      } catch (error) {
        if (!cancelled) setOauthError(error instanceof Error ? error.message : "Unable to complete Deriv login.");
      } finally {
        if (!cancelled) setCompletingOAuth(false);
      }
    }
    void finish();
    return () => { cancelled = true; };
  }, []);

  const accountList = (auth.accounts || []).filter(
    (account) => account.displayType === "demo" || account.displayType === "real"
  );
  const selectedId = String(
    auth.selectedAccount?.id || auth.selectedAccount?.account_id || auth.selectedAccount?.loginid || ""
  );

  return (
    <main className="zentoraDashboard">
      <header className="zentoraTopbar">
        <div className="zentoraBrand">
          <div className="zentoraLogo">Z</div>
          <div>
            <strong>ZENTORA</strong>
            <span>TRADE SMARTER. GROW FASTER.</span>
          </div>
        </div>

        <div className="zentoraStatusRow">
          <span className="statusPill ok">● Deriv API Connected</span>
          <span className="statusPill ok">● Live Market Feed</span>
          <span className="statusPill ok">● Trading Ready</span>
        </div>

        <div className="zentoraAccountSwitch">
          {auth.authenticated && accountList.length > 0 ? accountList.map((account) => {
            const id = String(account.id || "");
            const selected = id === selectedId;
            return (
              <button key={id} className={selected ? "selected" : ""} onClick={() => id !== selectedId && auth.selectAccount(id)} type="button">
                <span>{account.displayType === "real" ? "REAL" : "DEMO"}</span>
                <b>{Number.isFinite(Number(account.balance)) ? `${Number(account.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${String(account.currency || "USD").toUpperCase()}` : "—"}</b>
              </button>
            );
          }) : (
            <button type="button" onClick={auth.login}>LOGIN</button>
          )}
        </div>
      </header>

      {(completingOAuth || oauthError || auth.authError) ? (
        <div className="zentoraAlert">{completingOAuth ? "Completing Deriv login. Please wait..." : `Deriv: ${oauthError || auth.authError}`}</div>
      ) : null}

      <section className="zentoraHero">
        <div>
          <span className="eyebrow">ZENTORA • DUAL STRATEGY WORKSPACE</span>
          <h1>Trading Dashboard</h1>
          <p>Two independent trading desks. One account. Separate signals, separate execution and shared protection discipline.</p>
        </div>
        <div className="heroBadge"><span>●</span> DEMO FIRST • REAL LOCKED</div>
      </section>

      <section className="deskGrid">
        <article className="deskCard riseDesk">
          <div className="deskHeader">
            <div className="deskIcon riseIcon">↕</div>
            <div><span className="deskKicker">DIRECTIONAL STRATEGY</span><h2>Rise / Fall Trading Desk</h2><p>Trend and momentum based directional entries.</p></div>
            <span className="deskReady">● READY</span>
          </div>
          <div className="deskBody"><RiseFallBot /></div>
        </article>

        <article className="deskCard touchDesk">
          <div className="deskHeader">
            <div className="deskIcon touchIcon">◎</div>
            <div><span className="deskKicker">BARRIER STRATEGY</span><h2>Touch / No Touch Trading Desk</h2><p>Barrier selection with A+ quality filtering and account protection.</p></div>
            <span className="deskReady">● READY</span>
          </div>
          <div className="deskBody"><TouchNoTouchBot /></div>
        </article>
      </section>

      <footer className="zentoraFooter">
        <span>Separate strategies • Better opportunities • Disciplined risk</span>
        <b>ZENTORA</b>
      </footer>
    </main>
  );
}
