import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

export default function Settings() {
  return (
    <div className="appShell">
      <Sidebar />
      <main className="mainContent">
        <Topbar
          title="Settings"
          subtitle="Connection, account and interface settings"
        />

        <section className="emptyPage">
          <h2>Connection Settings</h2>
          <p>Deriv App ID na authorization settings zitawekwa hapa.</p>
        </section>
      </main>
    </div>
  );
}
