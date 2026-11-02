import AppHeader from "./AppHeader";
import AccountBar from "./AccountBar";

export default function BotLayout({ children, eyebrow }) {
  return (
    <div className="appShell">
      <AppHeader eyebrow={eyebrow} />
      <main className="appMain">
        <AccountBar />
        {children}
      </main>
    </div>
  );
}
