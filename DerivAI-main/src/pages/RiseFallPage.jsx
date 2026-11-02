import BotLayout from "../components/BotLayout";
import RiseFallBot from "../components/RiseFallBot";

export default function RiseFallPage() {
  return (
    <BotLayout eyebrow="RISE / FALL TRADING DESK">
      <section className="deskPageIntro riseIntro">
        <div>
          <span>DEDICATED DESK</span>
          <h1>Rise / Fall Bot</h1>
          <p>
            Directional trading only. Touch / No Touch logic is not part of
            this desk.
          </p>
        </div>
        <strong>RISE / FALL</strong>
      </section>
      <RiseFallBot />
    </BotLayout>
  );
}
