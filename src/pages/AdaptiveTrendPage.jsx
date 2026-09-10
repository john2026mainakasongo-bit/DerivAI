import BotLayout from "../components/BotLayout";
import AdaptiveTrendBot from "../components/AdaptiveTrendBot";

export default function AdaptiveTrendPage() {
  return <BotLayout eyebrow="ADAPTIVE TREND TRADING DESK">
    <section className="deskPageIntro adaptiveIntro">
      <div><span>NEW INDEPENDENT STRATEGY</span>
        <h1>Adaptive Trend Bot</h1>
        <p>Trend + momentum + pullback entries with an independent risk engine. Separate from Touch / No Touch.</p>
      </div>
      <strong>ADAPTIVE TREND</strong>
    </section>
    <AdaptiveTrendBot />
  </BotLayout>;
}
