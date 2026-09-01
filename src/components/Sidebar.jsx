import { NavLink } from "react-router-dom";

const groups = [
  {
    label: "Workspace",
    links: [
      { to: "/dashboard", label: "Dashboard", icon: "⌂" },
      { to: "/analysis", label: "Analysis", icon: "◉" },
      { to: "/deriv-ai-analyzer", label: "Deriv AI Analyzer", icon: "AI" },
    ],
  },
  {
    label: "Market tools",
    links: [
      { to: "/rise-fall-analysis", label: "Rise / Fall", icon: "↗" },
      { to: "/over-under-analysis", label: "Over / Under", icon: "↕" },
      { to: "/over-under-learning-bot", label: "O/U Learning", icon: "OU" },
    ],
  },
  {
    label: "Automation",
    links: [
      { to: "/rapid-edge-ai", label: "RapidEdge AI", icon: "RE" },
      { to: "/final-analysis-bot", label: "Final Analysis", icon: "FA" },
      { to: "/gemini-x-engine", label: "GeminiX Engine", icon: "GX" },
      { to: "/bot", label: "Auto Bot", icon: "⚡" },
      { to: "/differs-one-shot", label: "Differs 1 Run", icon: "1" },
      { to: "/target-10-bot", label: "Target 10", icon: "◎" },
      { to: "/fresh-edge-ai", label: "FreshEdge AI", icon: "F" },
    ],
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

      <nav className="sidebarNav">
        {groups.map((group) => (
          <section className="navGroup" key={group.label}>
            <span className="navGroupLabel">{group.label}</span>
            {group.links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  isActive ? "navLink active" : "navLink"
                }
              >
                <span className="navIcon">{link.icon}</span>
                <span className="navText">{link.label}</span>
              </NavLink>
            ))}
          </section>
        ))}

        <section className="navGroup navGroupSettings">
          <span className="navGroupLabel">System</span>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              isActive ? "navLink active" : "navLink"
            }
          >
            <span className="navIcon">⚙</span>
            <span className="navText">Settings</span>
          </NavLink>
        </section>
      </nav>

      <div className="sidebarFooter">
        <span className="statusDot" />
        Demo environment
      </div>
    </aside>
  );
}
