import { Link } from "react-router-dom";
import "./BotDashboardCatalog.css";

const bots = [
  {
    name: "Target 10 Bot",
    route: "/target-10-bot",
    mode: "Demo + Real",
    description:
      "Staged growth strategy with no martingale, one open trade and stop after one loss.",
    status: "ACTIVE",
  },
  {
    name: "Fast Digit Row Engine",
    route: "/bot",
    mode: "Auto Bot",
    description:
      "Digit-row analysis for Over/Under, Even/Odd and Differs contract ranking.",
    status: "ACTIVE",
  },
  {
    name: "Over/Under Quick Trader",
    route: "/over-under-analysis",
    mode: "Manual + Auto",
    description:
      "Dedicated Over and Under buttons with live probability, transition and digit flow.",
    status: "ACTIVE",
  },
];

export default function BotDashboardCatalog() {
  return (
    <section className="botDashboardCatalog">
      <div className="botDashboardHeader">
        <div>
          <small>MY BOTS</small>
          <h2>Trading bots</h2>
        </div>
        <span>{bots.length} bots</span>
      </div>

      <div className="botDashboardGrid">
        {bots.map((bot) => (
          <Link key={bot.route} to={bot.route} className="botDashboardCard">
            <div>
              <small>{bot.mode}</small>
              <strong>{bot.name}</strong>
              <p>{bot.description}</p>
            </div>
            <span>{bot.status}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
