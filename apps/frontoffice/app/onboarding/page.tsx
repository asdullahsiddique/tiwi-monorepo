"use client";

import { useEffect, useMemo, useState } from "react";
import { useOrganization, useOrganizationList, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { createRandomOrgName } from "@tiwi/shared";

export default function OnboardingPage() {
  const router = useRouter();
  const { isLoaded: userLoaded, user } = useUser();
  const { isLoaded: orgLoaded, organization } = useOrganization();
  const {
    isLoaded: orgListLoaded,
    createOrganization,
    setActive,
  } = useOrganizationList();

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "idle" | "creating_org" | "setting_active" | "redirecting"
  >("idle");

  const orgName = useMemo(() => createRandomOrgName(), []);

  useEffect(() => {
    if (!userLoaded || !orgLoaded || !orgListLoaded) return;
    if (!user) return;

    // If an active org already exists, we can proceed.
    if (organization) {
      router.replace("/dashboard");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setStatus("creating_org");
        const created = await createOrganization({ name: orgName });
        if (cancelled) return;

        setStatus("setting_active");
        await setActive?.({ organization: created });
        if (cancelled) return;

        setStatus("redirecting");
        router.replace("/dashboard");
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Failed to create organization",
        );
        setStatus("idle");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    userLoaded,
    orgLoaded,
    orgListLoaded,
    user,
    organization,
    createOrganization,
    setActive,
    router,
    orgName,
  ]);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
        <div className="text-sm uppercase tracking-[0.2em] text-[var(--muted-2)]">
          Initializing
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Setting up your workspace
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Creating your organization and preparing the dashboard.
        </p>

        <div className="mt-6 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-[var(--muted-2)]">Organization</span>
            <span className="font-medium">{orgName}</span>
          </div>
          <div className="mt-3 text-[var(--muted-2)]">
            Status: <span className="text-[var(--foreground)]">{status}</span>
          </div>
          {error ? (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-700">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
