import BotLayout from "../components/BotLayout";
import TouchNoTouchBot from "../components/TouchNoTouchBot";
import "../styles/TouchNoTouchLayoutFix.css";

export default function TouchNoTouchPage() {
  return (
    <div className="touchDeskViewport">
      <BotLayout eyebrow="TOUCH / NO TOUCH TRADING DESK">
        <section className="deskPageIntro touchIntro">
          <div>
            <span>DEDICATED DESK</span>
            <h1>Touch / No Touch Bot</h1>
            <p>
              Barrier contracts only. This desk owns its proposal checks,
              entry timing and execution flow.
            </p>
          </div>
          <strong>TOUCH / NO TOUCH</strong>
        </section>
        <TouchNoTouchBot />
      </BotLayout>
    </div>
  );
}
