import { NavLink } from "react-router-dom";

const links = [
  { to: "/dashboard", label: "Dashboard", icon: "⌂" },
  { to: "/analysis", label: "Analysis", icon: "◉" },
  {
    to: "/rise-fall-analysis",
    label: "Rise/Fall",
    icon: "↗",
  },
  {
    to: "/over-under-learning-bot",
    label: "O/U Learning Bot",
    icon: "OU",
  },
  {
    to: "/rapid-edge-ai",
    label: "RapidEdge AI",
    icon: "RE",
  },
  {
    to: "/gemini-x-engine",
    label: "GeminiX Engine",
    icon: "GX",
  },
  {
    to: "/over-under-analysis",
    label: "Over/Under",
    icon: "↕",
  },
  { to: "/bot", label: "Auto Bot", icon: "⚡" },
  {
    to: "/differs-one-shot",
    label: "Differs 1 Run",
    icon: "1",
  },
  {
    to: "/target-10-bot",
    label: "Target 10",
    icon: "◎",
  },
  {
    to: "/fresh-edge-ai",
    label: "FreshEdge AI",
    icon: "F",
  },
  {
    to: "/settings",
    label: "Settings",
    icon: "⚙",
  },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brandMark">E</div>

        <div>
          <strong>EdgePilot</strong>
          <small>Trading Assistant</small>
        </div>
      </div>

      <nav>
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              isActive ? "navLink active" : "navLink"
            }
          >
            <span>{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </nav>

      <div className="sidebarFooter">
        <span className="statusDot" />
        Demo environment
      </div>
    </aside>
  );
}