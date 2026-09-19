import BotLayout from "../components/BotLayout";
import DigitOverRecoveryBot from "../components/DigitOverRecoveryBot";

export default function DigitOverRecoveryPage() {
  return (
    <BotLayout eyebrow="DIGIT OVER / UNDER TRADING DESK">
      <section className="deskPageIntro digitIntro">
        <div>
          <span>V10 SINGLE DECISION ENGINE</span>
          <h1>Digit Over / Under Bot</h1>
          <p>
            One live decision engine compares OVER and UNDER from the same rolling
            60-digit market book, validates the Deriv proposal, executes only when
            probability, payout, EV and risk gates pass, then closes a losing signal
            and searches for a fresh setup.
          </p>
        </div>
        <strong>OVER / UNDER</strong>
      </section>
      <DigitOverRecoveryBot />
    </BotLayout>
  );
}
