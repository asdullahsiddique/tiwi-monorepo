import type { AIExecutionLogRecord, ProcessingLogRecord } from "@tiwi/neo4j";

export function FileViewScreen(props: {
  title: string;
  status: string;
  contentType: string;
  downloadUrl: string | null;
  summary: string | null;
  embeddingsMeta: { chunkCount: number; model?: string };
  processingLogs: ProcessingLogRecord[];
  aiLogs: AIExecutionLogRecord[];
}) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-black/60 dark:text-white/60">
              File View
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{props.title}</h1>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-black/10 px-2 py-1 dark:border-white/10">
                {props.status}
              </span>
              <span className="rounded-full border border-black/10 px-2 py-1 text-black/60 dark:border-white/10 dark:text-white/60">
                {props.contentType}
              </span>
            </div>
          </div>

          {props.downloadUrl ? (
            <a
              href={props.downloadUrl}
              className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-black/10 hover:opacity-95"
              target="_blank"
              rel="noreferrer"
            >
              Open original
            </a>
          ) : null}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">Original</div>
              <div className="mt-3 text-sm text-black/60 dark:text-white/60">
                {props.downloadUrl ? (
                  <div className="overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
                    <iframe className="h-[520px] w-full" src={props.downloadUrl} />
                  </div>
                ) : (
                  "No download URL available yet."
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">AI Summary</div>
              <div className="mt-3 whitespace-pre-wrap text-sm text-black/70 dark:text-white/70">
                {props.summary ?? "No summary yet."}
              </div>
            </section>

            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">Processing logs</div>
              <div className="mt-3 space-y-2 text-xs">
                {props.processingLogs.length === 0 ? (
                  <div className="text-black/60 dark:text-white/60">No logs yet.</div>
                ) : (
                  props.processingLogs.map((l) => (
                    <div
                      key={l.logId}
                      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="font-medium">{l.level}</div>
                        <div className="text-black/50 dark:text-white/50">{l.createdAt}</div>
                      </div>
                      <div className="mt-1 text-black/70 dark:text-white/70">{l.message}</div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">Embeddings</div>
              <div className="mt-3 text-sm text-black/70 dark:text-white/70">
                <div>
                  Chunks: <span className="font-medium">{props.embeddingsMeta.chunkCount}</span>
                </div>
                <div className="mt-1 text-black/60 dark:text-white/60">
                  Model: {props.embeddingsMeta.model ?? "—"}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">AI execution logs</div>
              <div className="mt-3 space-y-2 text-xs">
                {props.aiLogs.length === 0 ? (
                  <div className="text-black/60 dark:text-white/60">No AI logs yet.</div>
                ) : (
                  props.aiLogs.map((l) => (
                    <div
                      key={l.logId}
                      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="font-medium">{l.model}</div>
                        <div className="text-black/50 dark:text-white/50">{l.createdAt}</div>
                      </div>
                      <div className="mt-1 text-black/70 dark:text-white/70">{l.purpose}</div>
                      <div className="mt-1 text-black/60 dark:text-white/60">
                        Tokens: {l.totalTokens} · Cost: ${l.costUsd}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">Entities & relationships</div>
              <div className="mt-3 text-sm text-black/60 dark:text-white/60">
                Coming next: entity extraction + relationship graph view.
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

