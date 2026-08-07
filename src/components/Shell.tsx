import Link from "next/link";
import { Logo } from "./Logo";
import { MobileMenu } from "./MobileMenu";
import { roleLabel } from "@/lib/rbac";
import type { SessionPayload } from "@/lib/session";

const NAV = [
  { id: "dashboard", href: "/dashboard", label: "Dashboard" },
  { id: "campaigns", href: "/campaigns", label: "Kampagnen" },
  { id: "contacts", href: "/contacts", label: "Kontakte" },
  { id: "senders", href: "/senders", label: "Absender" },
  { id: "settings", href: "/settings", label: "Einstellungen" },
];

export function Shell({
  session,
  active,
  children,
}: {
  session: SessionPayload;
  active?: string;
  children: React.ReactNode;
}) {
  const initials = session.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="topbar sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-6">
          <MobileMenu name={session.name} role={session.role} active={active} nav={NAV} />

          <Link href="/dashboard" className="flex items-center gap-2 shrink-0">
            <Logo className="h-7" />
          </Link>

          <nav className="hidden md:flex items-center gap-1 flex-1 nav-scroll overflow-x-auto">
            {NAV.map((n) => (
              <Link
                key={n.id}
                href={n.href}
                className={
                  "px-3 py-1.5 rounded-full text-sm font-medium transition whitespace-nowrap " +
                  (active === n.id
                    ? "bg-white/80 text-brand-700 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_4px_14px_-6px_rgba(0,126,128,0.35)] border border-white/60"
                    : "text-slate-600 hover:text-slate-900 hover:bg-white/60")
                }
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex-1 md:hidden" />

          <details className="menu shrink-0 hidden md:block">
            <summary className="list-none cursor-pointer flex items-center gap-2 rounded-full hover:bg-brand-50 pl-2 pr-1 py-1">
              <span className="hidden lg:block text-sm text-slate-700 max-w-[140px] truncate">
                {session.name}
              </span>
              <span className="h-9 w-9 rounded-full bg-brand-500 text-white text-xs font-semibold flex items-center justify-center shadow-sm">
                {initials}
              </span>
            </summary>
            <div className="menu-panel">
              <div className="px-3 py-2 border-b border-slate-100 mb-1">
                <div className="text-sm font-medium truncate">{session.name}</div>
                <div className="text-xs text-slate-500">{roleLabel(session.role)}</div>
              </div>
              <Link href="/settings" className="menu-item">
                Einstellungen
              </Link>
              <div className="menu-divider" />
              <form action="/api/auth/logout" method="post">
                <button className="menu-item menu-item-danger w-full">Abmelden</button>
              </form>
            </div>
          </details>
        </div>
      </header>

      <main className="flex-1">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</div>
      </main>

      <footer className="text-center text-xs text-slate-400 py-6 px-4">
        Mailing — Drip-Versand über Hostinger
      </footer>
    </div>
  );
}
