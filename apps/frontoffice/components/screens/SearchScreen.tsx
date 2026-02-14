export type SearchCitation = {
  fileId: string;
  chunkId: string;
  score: number;
  snippet: string;
};

export function SearchScreen(props: {
  query: string;
  isSearching: boolean;
  answer?: string | null;
  citations?: SearchCitation[];
  error?: string | null;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
}) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-20">
        <div className="text-center">
          <div className="text-xs uppercase tracking-[0.2em] text-black/60 dark:text-white/60">
            Search
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">Ask your archive</h1>
          <p className="mt-2 text-sm text-black/70 dark:text-white/70">
            Semantic retrieval over embeddings with transparent citations.
          </p>
        </div>

        <div className="mt-10 rounded-2xl border border-black/10 bg-white/70 p-3 backdrop-blur dark:border-white/10 dark:bg-black/40">
          <div className="flex items-center gap-3">
            <input
              value={props.query}
              onChange={(e) => props.onQueryChange(e.target.value)}
              placeholder="What happened in the 2024 launch meeting?"
              className="h-12 w-full bg-transparent px-3 text-sm outline-none placeholder:text-black/40 dark:placeholder:text-white/40"
              onKeyDown={(e) => {
                if (e.key === "Enter") props.onSearch();
              }}
            />
            <button
              onClick={props.onSearch}
              disabled={props.isSearching || !props.query.trim()}
              className="h-12 rounded-xl bg-[var(--accent)] px-5 text-sm font-medium text-white disabled:opacity-60"
            >
              {props.isSearching ? "Searching..." : "Search"}
            </button>
          </div>
        </div>

        {props.error ? (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            {props.error}
          </div>
        ) : null}

        {props.answer ? (
          <div className="mt-10 space-y-6">
            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">Answer</div>
              <div className="mt-3 whitespace-pre-wrap text-sm text-black/70 dark:text-white/70">
                {props.answer}
              </div>
            </section>

            <section className="rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
              <div className="text-sm font-medium">Citations</div>
              <div className="mt-3 space-y-2 text-xs">
                {(props.citations ?? []).length === 0 ? (
                  <div className="text-black/60 dark:text-white/60">No citations.</div>
                ) : (
                  (props.citations ?? []).map((c) => (
                    <div
                      key={`${c.fileId}:${c.chunkId}`}
                      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="font-medium">
                          fileId={c.fileId} · chunkId={c.chunkId}
                        </div>
                        <div className="text-black/50 dark:text-white/50">score={c.score}</div>
                      </div>
                      <div className="mt-1 text-black/70 dark:text-white/70">{c.snippet}</div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

