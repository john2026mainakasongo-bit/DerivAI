import Sidebar from "../components/Sidebar";
import Topbar from "../components/Topbar";

export default function Analysis() {
  return (
    <div className="appShell">
      <Sidebar />
      <main className="mainContent">
        <Topbar
          title="Owner Analysis"
          subtitle="Validated market statistics and entry timing"
        />

        <section className="emptyPage">
          <h2>Analysis Engine</h2>
          <p>
            Hapa tutaweka analysisEngine, backtestEngine na entryTimingEngine
            kutoka MetaBinary.
          </p>
        </section>
      </main>
    </div>
  );
}
