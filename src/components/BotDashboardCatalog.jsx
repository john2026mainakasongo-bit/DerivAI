import { Link } from "react-router-dom";
import "../styles/BotDashboardCatalog.css";

const bots = [
  {
    tag: "AUTO",
    title: "MetaBinary Auto Bot",
    text: "Multi-contract automated analysis and execution.",
    path: "/bot",
  },
  {
    tag: "TARGET",
    title: "Target 10 Bot",
    text: "Target-based automated trading session.",
    path: "/target-10-bot",
  },
  {
    tag: "ONE SHOT",
    title: "Differs One Shot",
    text: "Focused digit differs scanner and execution.",
    path: "/differs-one-shot",
  },
  {
    tag: "ANALYSIS",
    title: "Rise/Fall Analysis",
    text: "Professional Rise/Fall market analysis center.",
    path: "/rise-fall-analysis",
  },
  {
    tag: "ANALYSIS",
    title: "Over/Under Analysis",
    text: "Over/Under digit analysis and manual execution.",
    path: "/over-under-analysis",
  },
];

export default function BotDashboardCatalog() {
  return (
    <section className="botDashboardCatalog">
      <header className="botDashboardHeader">
        <div>
          <small>BOT COMMAND CENTER</small>
          <h2>MetaBinary Bots</h2>
        </div>

        <span>{bots.length} tools</span>
      </header>

      <div className="botDashboardGrid">
        {bots.map((bot) => (
          <Link
            key={bot.path}
            to={bot.path}
            className="botDashboardCard"
          >
            <div>
              <small>{bot.tag}</small>
              <strong>{bot.title}</strong>
              <p>{bot.text}</p>
            </div>

            <span>OPEN</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
