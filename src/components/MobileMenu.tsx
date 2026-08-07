"use client";

import Link from "next/link";
import { useState } from "react";
import { roleLabel } from "@/lib/rbac";

interface NavItem {
  id: string;
  href: string;
  label: string;
}

export function MobileMenu({
  name,
  role,
  active,
  nav,
}: {
  name: string;
  role: string;
  active?: string;
  nav: NavItem[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label="Menü"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-9 w-9 rounded-xl flex items-center justify-center text-slate-600 hover:bg-white/70"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {open ? (
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
          )}
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-slate-900/10"
          />
          <div className="menu-panel fixed left-3 right-3 top-16 z-40 block">
            <div className="px-3 py-2 border-b border-slate-100 mb-1">
              <div className="text-sm font-medium truncate">{name}</div>
              <div className="text-xs text-slate-500">{roleLabel(role)}</div>
            </div>
            {nav.map((n) => (
              <Link
                key={n.id}
                href={n.href}
                onClick={() => setOpen(false)}
                className={
                  "menu-item " + (active === n.id ? "bg-brand-50 text-brand-700 font-medium" : "")
                }
              >
                {n.label}
              </Link>
            ))}
            <div className="menu-divider" />
            <form action="/api/auth/logout" method="post">
              <button className="menu-item menu-item-danger w-full">Abmelden</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
