import BotLayout from "../components/BotLayout";
import DigitOverRecoveryBot from "../components/DigitOverRecoveryBot";

export default function DigitOverRecoveryPage() {
  return (
    <BotLayout eyebrow="DIGIT OVER RECOVERY DESK">
      <section className="deskPageIntro digitIntro">
        <div>
          <span>NEW INDEPENDENT STRATEGY</span>
          <h1>Digit Over Recovery Bot</h1>
          <p>OVER 2 / OVER 3 digit analysis with per-market rolling 60-digit data, volatility filters and Deriv proposal validation.</p>
        </div>
        <strong>DIGIT OVER</strong>
      </section>
      <DigitOverRecoveryBot />
    </BotLayout>
  );
}
