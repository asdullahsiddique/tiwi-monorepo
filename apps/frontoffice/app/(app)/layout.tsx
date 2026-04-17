import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";

type NavItem = { href: string; label: string; section: string };

const nav: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", section: "Workspace" },
  { href: "/files", label: "Files", section: "Workspace" },
  { href: "/search", label: "Search", section: "Intelligence" },
  { href: "/prompts", label: "Prompts", section: "Intelligence" },
];

const sections = ["Workspace", "Intelligence"] as const;

export default async function AppLayout(props: { children: React.ReactNode }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");

  return (
    <AppShell nav={nav} sections={[...sections]}>
      {props.children}
    </AppShell>
  );
}
