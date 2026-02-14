export function DashboardScreen(props: { onUploadClick: () => void }) {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted-2)]">
            Media Intelligence
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Dashboard
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
            Upload content, watch it become a knowledge graph, and query it with
            transparency.
          </p>
        </div>

        <button
          onClick={props.onUploadClick}
          className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-black/10 hover:opacity-95"
        >
          Upload files
        </button>
      </div>

      <div className="mt-10 rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
        <div className="text-sm font-medium">No files yet</div>
        <div className="mt-1 text-sm text-[var(--muted-2)]">
          Start by uploading a PDF, image, audio, or video file.
        </div>
      </div>
    </div>
  );
}
