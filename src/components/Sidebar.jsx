import { NavLink } from "react-router-dom";

const links = [
  { to: "/dashboard", label: "Dashboard", icon: "âŒ‚" },
  { to: "/analysis", label: "Analysis", icon: "â—‰" },
  {
    to: "/rise-fall-analysis",
    label: "Rise/Fall",
    icon: "â†—",
  },
  { to: "/over-under-learning-bot", label: "O/U Learning Bot", icon: "OU" },
  { to: "/rapid-edge-ai", label: "RapidEdge AI", icon: "OU" },
  { to: "/over-under-analysis", label: "Over/Under", icon: "Ã¢â€ â€¢" },
  { to: "/bot", label: "Auto Bot", icon: "âš¡" },
{ to: "/differs-one-shot", label: "Differs 1 Run", icon: "1" },
  { to: "/target-10-bot", label: "Target 10", icon: "â—Ž" },
  { to: "/settings", label: "Settings", icon: "âš™" },
  {
    to: "/fresh-edge-ai",
    label: "FreshEdge AI",
    icon: "F",
  },];

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


