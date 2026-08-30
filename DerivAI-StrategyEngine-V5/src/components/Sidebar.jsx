import { NavLink } from "react-router-dom";

export default function Sidebar() {
  return (
    <aside className="sidebar strategyOnlySidebar">
      <div className="brand">
        <div className="brandMark">E</div>
        <div>
          <strong>EdgePilot</strong>
          <small>Strategy Engine</small>
        </div>
      </div>

      <nav className="sidebarNav">
        <section className="navGroup">
          <span className="navGroupLabel">Workspace</span>
          <NavLink
            to="/dashboard"
            className={({ isActive }) =>
              isActive ? "navLink active" : "navLink"
            }
          >
            <span className="navIcon">⌂</span>
            <span className="navText">Strategy Engine</span>
          </NavLink>
        </section>
      </nav>

      <div className="sidebarFooter">
        <span className="statusDot" />
        Live strategy workspace
      </div>
    </aside>
  );
}
