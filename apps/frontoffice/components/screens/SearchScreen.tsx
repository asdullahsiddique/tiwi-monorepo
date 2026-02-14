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
    <div className="mx-auto w-full max-w-4xl">
      <div className="text-center">
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted-2)]">
          Search
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          Ask your archive
        </h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Semantic retrieval over embeddings with transparent citations.
        </p>
      </div>

      <div className="mt-10 rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <input
            value={props.query}
            onChange={(e) => props.onQueryChange(e.target.value)}
            placeholder="What happened in the 2024 launch meeting?"
            className="h-12 w-full bg-transparent px-3 text-sm outline-none placeholder:text-black/35"
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
        <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          {props.error}
        </div>
      ) : null}

      {props.answer ? (
        <div className="mt-10 space-y-6">
          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">Answer</div>
            <div className="mt-3 whitespace-pre-wrap text-sm text-[var(--muted)]">
              {props.answer}
            </div>
          </section>

          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">Citations</div>
            <div className="mt-3 space-y-2 text-xs">
              {(props.citations ?? []).length === 0 ? (
                <div className="text-[var(--muted)]">No citations.</div>
              ) : (
                (props.citations ?? []).map((c) => (
                  <div
                    key={`${c.fileId}:${c.chunkId}`}
                    className="rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="font-medium">
                        fileId={c.fileId} · chunkId={c.chunkId}
                      </div>
                      <div className="text-[var(--muted-2)]">
                        score={c.score}
                      </div>
                    </div>
                    <div className="mt-1 text-[var(--muted)]">{c.snippet}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
