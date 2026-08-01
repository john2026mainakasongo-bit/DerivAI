import { NavLink } from "react-router-dom";

const links = [
  { to: "/dashboard", label: "Dashboard", icon: "⌂" },
  { to: "/analysis", label: "Analysis", icon: "◉" },
  { to: "/bot", label: "Auto Bot", icon: "⚡" },
  { to: "/settings", label: "Settings", icon: "⚙" },
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
            className={({ isActive }) => isActive ? "navLink active" : "navLink"}
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
