import { NavLink } from "react-router-dom";

const links = [
  ["/dashboard", "Dashboard", "▣"],
  ["/analysis", "Analysis", "⌁"],
  ["/rise-fall-analysis", "Pulse Rise/Fall", "↗"],
  ["/bot", "Auto Bot", "⚡"],
  ["/settings", "Settings", "⚙"],
];

export default function Sidebar() {
  return <aside className="sidebar zentoraSidebar"><div className="brand"><div className="brandMark zentoraMark">Z</div><div><strong>ZENTORA</strong><small>TRADE SMARTER</small></div></div><nav className="sidebarNav"><span className="navGroupLabel">WORKSPACE</span>{links.map(([to,label,icon])=><NavLink key={to} to={to} className={({isActive})=>isActive?"navLink active":"navLink"}><span className="navIcon">{icon}</span><span className="navText">{label}</span></NavLink>)}</nav><div className="sidebarPromo"><b>DISCIPLINE</b><span>TODAY</span><span>FREEDOM</span><span>TOMORROW</span></div><div className="sidebarFooter"><span className="statusDot"/>Deriv trading terminal</div></aside>;
}
