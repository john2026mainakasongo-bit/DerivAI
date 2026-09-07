import { NavLink } from "react-router-dom";

export default function AppHeader({ eyebrow = "DERIVAI TRADING DESK" }) {
  return (
    <header className="appHeader">
      <NavLink to="/dashboard" className="appBrand">
        <span className="appBrandMark">DA</span>
        <span>
          <strong>DerivAI</strong>
          <small>{eyebrow}</small>
        </span>
      </NavLink>

      <nav className="appNav">
        <NavLink
          to="/dashboard"
          end
          className={({ isActive }) =>
            `appNavLink${isActive ? " active" : ""}`
          }
        >
          Dashboard
        </NavLink>
        <NavLink
          to="/rise-fall"
          className={({ isActive }) =>
            `appNavLink rise${isActive ? " active" : ""}`
          }
        >
          Rise / Fall
        </NavLink>
        <NavLink
          to="/touch-no-touch"
          className={({ isActive }) =>
            `appNavLink touch${isActive ? " active" : ""}`
          }
        >
          Touch / No Touch
        </NavLink>
      </nav>
    </header>
  );
}
