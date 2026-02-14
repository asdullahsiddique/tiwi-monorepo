"use client";

import { createContext, useContext, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

type NavItem = { href: string; label: string; section: string };

const SidebarContext = createContext<{
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
}>({ collapsed: false, setCollapsed: () => {} });

function NavLink(props: { href: string; label: string; collapsed: boolean; isActive: boolean }) {
  return (
    <Link
      href={props.href}
      className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
        props.isActive
          ? "bg-[var(--accent)]/10 text-[var(--accent)]"
          : "text-[var(--muted)] hover:bg-black/[0.04] hover:text-[var(--foreground)]"
      }`}
    >
      <span className={`font-medium tracking-tight ${props.collapsed ? "sr-only" : ""}`}>
        {props.label}
      </span>
    </Link>
  );
}

function Sidebar(props: { nav: NavItem[]; sections: string[] }) {
  const { collapsed, setCollapsed } = useContext(SidebarContext);
  const pathname = usePathname();

  return (
    <aside
      className={`fixed left-0 top-0 z-40 h-screen border-r border-[color:var(--border)] bg-[var(--surface)] backdrop-blur transition-all duration-300 ${
        collapsed ? "w-[72px]" : "w-[280px]"
      } hidden md:block`}
    >
      <div className="flex h-full flex-col px-4 py-6">
        {/* Header */}
        <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="h-9 w-9 flex-shrink-0 rounded-xl bg-[var(--accent)] shadow-[0_0_0_1px_rgba(17,24,39,0.10)]" />
            {!collapsed && (
              <div>
                <div className="text-sm font-semibold tracking-tight">Tiwi</div>
                <div className="text-xs text-[var(--muted-2)]">Media Intelligence</div>
              </div>
            )}
          </Link>
          {!collapsed && <UserButton afterSignOutUrl="/" />}
        </div>

        {/* Navigation */}
        <div className="mt-8 flex-1 space-y-6 overflow-y-auto">
          {props.sections.map((section) => (
            <div key={section}>
              {!collapsed && (
                <div className="px-3 text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted-2)]">
                  {section}
                </div>
              )}
              <div className={`${collapsed ? "" : "mt-2"} space-y-1`}>
                {props.nav
                  .filter((n) => n.section === section)
                  .map((n) => (
                    <NavLink
                      key={n.href}
                      href={n.href}
                      label={n.label}
                      collapsed={collapsed}
                      isActive={pathname === n.href || pathname.startsWith(n.href + "/")}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>

        {/* Collapse Toggle */}
        <div className="mt-auto border-t border-[color:var(--border)] pt-4">
          {collapsed && (
            <div className="mb-4 flex justify-center">
              <UserButton afterSignOutUrl="/" />
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--foreground)] ${
              collapsed ? "justify-center" : ""
            }`}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg
              className={`h-5 w-5 transition-transform duration-300 ${collapsed ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
              />
            </svg>
            {!collapsed && <span className="font-medium">Collapse</span>}
          </button>
        </div>
      </div>
    </aside>
  );
}

function MobileNav(props: { nav: NavItem[] }) {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile Header */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-[color:var(--border)] bg-[var(--surface)] px-4 py-3 backdrop-blur md:hidden">
        <Link href="/dashboard" className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-xl bg-[var(--accent)] shadow-[0_0_0_1px_rgba(17,24,39,0.10)]" />
          <div className="text-sm font-semibold tracking-tight">Tiwi</div>
        </Link>
        <UserButton afterSignOutUrl="/" />
      </div>

      {/* Mobile Navigation */}
      <div className="sticky top-[57px] z-20 flex gap-1 overflow-x-auto border-b border-[color:var(--border)] bg-[var(--surface)] px-4 py-2 backdrop-blur md:hidden">
        {props.nav.map((n) => {
          const isActive = pathname === n.href || pathname.startsWith(n.href + "/");
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex-shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {n.label}
            </Link>
          );
        })}
      </div>
    </>
  );
}

export function AppShell(props: {
  nav: NavItem[];
  sections: string[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <SidebarContext.Provider value={{ collapsed, setCollapsed }}>
      <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(900px_circle_at_20%_-10%,rgba(208,24,43,0.10),transparent_60%),radial-gradient(800px_circle_at_80%_0%,rgba(17,24,39,0.06),transparent_60%)]" />

        <Sidebar nav={props.nav} sections={props.sections} />
        <MobileNav nav={props.nav} />

        <main
          className={`relative transition-all duration-300 ${
            collapsed ? "md:ml-[72px]" : "md:ml-[280px]"
          }`}
        >
          <div className="px-6 py-10">{props.children}</div>
        </main>
      </div>
    </SidebarContext.Provider>
  );
}
