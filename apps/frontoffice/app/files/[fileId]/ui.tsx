"use client";

import { useRef } from "react";
import { api } from "@/lib/trpc";
import { FileViewScreen } from "@/components/screens/FileViewScreen";

const TERMINAL_STATUSES = ["PROCESSED", "FAILED"];

export default function FileViewClient(props: { fileId: string }) {
  const file = useRef<any>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const view = api.files.getView.useQuery(
    { fileId: props.fileId },
    {
      refetchInterval: (query) => {
        // Stop polling once file reaches a terminal status
        const status = (query.state.data as any)?.file?.status;
        if (status && TERMINAL_STATUSES.includes(status)) {
          return false;
        }
        return 3_000; // Poll every 3s while processing
      },
    }
  );

  const reprocessMutation = api.files.reprocess.useMutation({
    onSuccess: () => {
      // Reset URL refs so they get fresh ones after reprocessing
      downloadUrlRef.current = null;
      previewUrlRef.current = null;
      // Refetch to get updated status
      view.refetch();
    },
  });

  // Update refs only when we have new data
  if (view.data) {
    file.current = (view.data as any).file;
    // Only update URLs if we don't have them yet (prevents iframe flicker)
    if (!downloadUrlRef.current && (view.data as any).downloadUrl) {
      downloadUrlRef.current = (view.data as any).downloadUrl;
    }
    if (!previewUrlRef.current && (view.data as any).previewUrl) {
      previewUrlRef.current = (view.data as any).previewUrl;
    }
  }

  const currentFile = file.current;
  const title = currentFile?.originalName ?? props.fileId;

  const handleReprocess = () => {
    reprocessMutation.mutate({ fileId: props.fileId });
  };

  if (view.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="h-8 w-64 animate-pulse rounded bg-[var(--muted-2)]/20" />
        <div className="h-4 w-32 animate-pulse rounded bg-[var(--muted-2)]/20" />
        <div className="h-64 animate-pulse rounded-2xl bg-[var(--muted-2)]/20" />
        <div className="h-32 animate-pulse rounded-2xl bg-[var(--muted-2)]/20" />
      </div>
    );
  }

  return (
    <FileViewScreen
      title={title}
      status={currentFile?.status ?? "—"}
      contentType={currentFile?.contentType ?? "—"}
      downloadUrl={downloadUrlRef.current}
      previewUrl={previewUrlRef.current}
      summary={(view.data as any)?.summary ?? null}
      embeddingsMeta={(view.data as any)?.embeddingsMeta ?? { chunkCount: 0 }}
      processingLogs={(view.data as any)?.processingLogs ?? []}
      aiLogs={(view.data as any)?.aiLogs ?? []}
      f1Entities={(view.data as any)?.f1Entities ?? []}
      onReprocess={handleReprocess}
      isReprocessing={reprocessMutation.isPending}
    />
  );
}

