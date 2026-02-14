export type SearchCitation = {
  fileId: string;
  chunkId: string;
  score: number;
  snippet: string;
};

export type SearchHistoryItem = {
  searchId: string;
  query: string;
  answer: string | null;
  citationCount: number;
  createdAt: string;
};

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function SearchScreen(props: {
  query: string;
  isSearching: boolean;
  answer?: string | null;
  citations?: SearchCitation[];
  error?: string | null;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  // History props
  history?: SearchHistoryItem[];
  isLoadingHistory?: boolean;
  onSelectHistory?: (query: string) => void;
  onDeleteHistory?: (searchId: string) => void;
  onClearHistory?: () => void;
  isDeletingHistory?: boolean;
}) {
  const hasAnswer = Boolean(props.answer);
  const hasHistory = (props.history ?? []).length > 0;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main search area */}
        <div className="lg:col-span-2">
          <div className="text-center lg:text-left">
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

          <div className="mt-8 rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-3 backdrop-blur">
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

          {hasAnswer ? (
            <div className="mt-8 space-y-6">
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
                            score={c.score.toFixed(3)}
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

        {/* Search history sidebar */}
        <div className="lg:col-span-1">
          <div className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-5 backdrop-blur">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Recent Searches</div>
              {hasHistory && props.onClearHistory && (
                <button
                  onClick={props.onClearHistory}
                  disabled={props.isDeletingHistory}
                  className="text-xs text-[var(--muted)] hover:text-red-500 transition-colors disabled:opacity-50"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="mt-4 space-y-2">
              {props.isLoadingHistory ? (
                <div className="py-8 text-center text-sm text-[var(--muted)]">
                  Loading...
                </div>
              ) : !hasHistory ? (
                <div className="py-8 text-center text-sm text-[var(--muted)]">
                  No search history yet.
                  <br />
                  <span className="text-xs text-[var(--muted-2)]">
                    Your searches will appear here.
                  </span>
                </div>
              ) : (
                (props.history ?? []).map((item) => (
                  <div
                    key={item.searchId}
                    className="group relative rounded-xl border border-[color:var(--border)] bg-[var(--surface-2)] p-3 transition-colors hover:bg-[var(--surface-3)]"
                  >
                    <button
                      onClick={() => props.onSelectHistory?.(item.query)}
                      className="w-full text-left"
                    >
                      <div className="text-sm font-medium text-[var(--foreground)] line-clamp-2">
                        {item.query}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-xs text-[var(--muted-2)]">
                        <span>{formatRelativeTime(item.createdAt)}</span>
                        <span>·</span>
                        <span>{item.citationCount} citations</span>
                      </div>
                      {item.answer && (
                        <div className="mt-2 text-xs text-[var(--muted)] line-clamp-2">
                          {item.answer}
                        </div>
                      )}
                    </button>

                    {/* Delete button */}
                    {props.onDeleteHistory && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDeleteHistory?.(item.searchId);
                        }}
                        disabled={props.isDeletingHistory}
                        className="absolute top-2 right-2 rounded-lg p-1.5 text-[var(--muted-2)] opacity-0 transition-all hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100 disabled:opacity-50"
                        title="Delete this search"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
