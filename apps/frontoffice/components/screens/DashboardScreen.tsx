export function DashboardScreen(props: { onUploadClick: () => void }) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-5xl px-6 py-14">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-black/60 dark:text-white/60">
              Media Intelligence Platform
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dashboard</h1>
            <p className="mt-2 max-w-xl text-sm text-black/70 dark:text-white/70">
              Upload content, watch it become a knowledge graph, and query it with transparency.
            </p>
          </div>

          <button
            onClick={props.onUploadClick}
            className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-black/10 hover:opacity-95"
          >
            Upload files
          </button>
        </div>

        <div className="mt-10 rounded-2xl border border-black/10 bg-white/70 p-6 backdrop-blur dark:border-white/10 dark:bg-black/40">
          <div className="text-sm font-medium">No files yet</div>
          <div className="mt-1 text-sm text-black/60 dark:text-white/60">
            Start by uploading a PDF, image, audio, or video file.
          </div>
        </div>
      </div>
    </div>
  );
}

