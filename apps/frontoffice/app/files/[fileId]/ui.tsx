"use client";

import { api } from "@/lib/trpc";
import { FileViewScreen } from "@/components/screens/FileViewScreen";

export default function FileViewClient(props: { fileId: string }) {
  const view = api.files.getView.useQuery({ fileId: props.fileId }, { refetchInterval: 2_000 });

  const file = (view.data as any)?.file;
  const title = file?.originalName ?? props.fileId;

  return (
    <FileViewScreen
      title={title}
      status={file?.status ?? "—"}
      contentType={file?.contentType ?? "—"}
      downloadUrl={(view.data as any)?.downloadUrl ?? null}
      summary={(view.data as any)?.summary ?? null}
      embeddingsMeta={(view.data as any)?.embeddingsMeta ?? { chunkCount: 0 }}
      processingLogs={(view.data as any)?.processingLogs ?? []}
      aiLogs={(view.data as any)?.aiLogs ?? []}
    />
  );
}

