"use client";

import { useRef } from "react";
import { api } from "@/lib/trpc";
import { FileViewScreen } from "@/components/screens/FileViewScreen";

const TERMINAL_STATUSES = ["PROCESSED", "FAILED"];

export default function FileViewClient(props: { fileId: string }) {
  const file = useRef<any>(null);
  const downloadUrlRef = useRef<string | null>(null);

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
      // Reset download URL ref so it gets a fresh one after reprocessing
      downloadUrlRef.current = null;
      // Refetch to get updated status
      view.refetch();
    },
  });

  // Update refs only when we have new data
  if (view.data) {
    file.current = (view.data as any).file;
    // Only update download URL if we don't have one yet (prevents iframe flicker)
    if (!downloadUrlRef.current && (view.data as any).downloadUrl) {
      downloadUrlRef.current = (view.data as any).downloadUrl;
    }
  }

  const currentFile = file.current;
  const title = currentFile?.originalName ?? props.fileId;

  const handleReprocess = () => {
    reprocessMutation.mutate({ fileId: props.fileId });
  };

  return (
    <FileViewScreen
      title={title}
      status={currentFile?.status ?? "—"}
      contentType={currentFile?.contentType ?? "—"}
      downloadUrl={downloadUrlRef.current}
      summary={(view.data as any)?.summary ?? null}
      embeddingsMeta={(view.data as any)?.embeddingsMeta ?? { chunkCount: 0 }}
      processingLogs={(view.data as any)?.processingLogs ?? []}
      aiLogs={(view.data as any)?.aiLogs ?? []}
      onReprocess={handleReprocess}
      isReprocessing={reprocessMutation.isPending}
    />
  );
}

