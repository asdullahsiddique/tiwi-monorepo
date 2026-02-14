"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc";
import { DashboardScreen } from "@/components/screens/DashboardScreen";

export default function DashboardClient() {
  const router = useRouter();
  const ensureMirror = api.org.ensureGraphMirror.useMutation();

  useEffect(() => {
    // Best-effort; if this fails we still want the UI to render.
    ensureMirror.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DashboardScreen
      onUploadClick={() => {
        router.push("/files");
      }}
    />
  );
}

