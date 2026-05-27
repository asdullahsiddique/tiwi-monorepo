"use client";

import { api } from "@/lib/trpc";
import { FileViewScreen } from "@/components/screens/FileViewScreen";

const TERMINAL_STATUSES = ["PROCESSED", "FAILED"];

export default function FileViewClient(props: { fileId: string }) {
  const view = api.files.getView.useQuery(
    { fileId: props.fileId },
    {
      refetchInterval: (query) => {
        // Stop polling once file reaches a terminal status
        const status = (
          query.state.data as { file?: { status?: string } } | undefined
        )?.file?.status;
        if (status && TERMINAL_STATUSES.includes(status)) {
          return false;
        }
        return 3_000; // Poll every 3s while processing
      },
    }
  );

  const reprocessMutation = api.files.reprocess.useMutation({
    onSuccess: () => {
      // Refetch to get updated status
      view.refetch();
    },
  });

  const currentFile = view.data?.file;
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
      downloadUrl={view.data?.downloadUrl ?? null}
      previewUrl={view.data?.previewUrl ?? null}
      summary={view.data?.summary ?? null}
      embeddingsMeta={view.data?.embeddingsMeta ?? { chunkCount: 0 }}
      processingLogs={view.data?.processingLogs ?? []}
      aiLogs={view.data?.aiLogs ?? []}
      f1Entities={view.data?.f1Entities ?? []}
      gpRounds={view.data?.gpRounds ?? []}
      onReprocess={handleReprocess}
      isReprocessing={reprocessMutation.isPending}
    />
  );
}

