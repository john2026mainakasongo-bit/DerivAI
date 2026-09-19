import BotLayout from "../components/BotLayout";
import DigitOverRecoveryBot from "../components/DigitOverRecoveryBot";

export default function DigitOverRecoveryPage() {
  return (
    <BotLayout eyebrow="DIGIT OVER / UNDER TRADING DESK">
      <section className="deskPageIntro digitIntro">
        <div>
          <span>V12 MULTI-MARKET DECISION ENGINE</span>
          <h1>Digit Over / Under Bot</h1>
          <p>
            Four live market books (Volatility 100, 75, 25 and 10) are analyzed independently.
            The scanner continuously compares OVER and UNDER setups, validates the
            live Deriv proposal, executes only when probability, payout, EV and risk
            gates pass, then settles and immediately searches all four books again.
          </p>
        </div>
        <strong>OVER / UNDER</strong>
      </section>
      <DigitOverRecoveryBot />
    </BotLayout>
  );
}
