export type FileListItem = {
  fileId: string;
  originalName: string;
  contentType: string;
  status: string;
  createdAt: string;
};

export function FileManagerScreen(props: {
  items: FileListItem[];
  isUploading: boolean;
  error?: string | null;
  onPickFiles: () => void;
  onOpenFile: (fileId: string) => void;
}) {
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto max-w-5xl px-6 py-14">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-black/60 dark:text-white/60">
              File Manager
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Files</h1>
            <p className="mt-2 text-sm text-black/70 dark:text-white/70">
              Upload files and track processing status.
            </p>
          </div>

          <button
            onClick={props.onPickFiles}
            disabled={props.isUploading}
            className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-black/10 hover:opacity-95 disabled:opacity-60"
          >
            {props.isUploading ? "Uploading..." : "Upload"}
          </button>
        </div>

        {props.error ? (
          <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
            {props.error}
          </div>
        ) : null}

        <div className="mt-10 overflow-hidden rounded-2xl border border-black/10 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-black/40">
          <div className="grid grid-cols-12 gap-3 border-b border-black/10 px-5 py-3 text-xs uppercase tracking-[0.18em] text-black/60 dark:border-white/10 dark:text-white/60">
            <div className="col-span-6">Name</div>
            <div className="col-span-3">Type</div>
            <div className="col-span-3">Status</div>
          </div>

          {props.items.length === 0 ? (
            <div className="px-5 py-10 text-sm text-black/60 dark:text-white/60">
              No files yet.
            </div>
          ) : (
            <div className="divide-y divide-black/10 dark:divide-white/10">
              {props.items.map((f) => (
                <button
                  key={f.fileId}
                  onClick={() => props.onOpenFile(f.fileId)}
                  className="grid w-full grid-cols-12 gap-3 px-5 py-4 text-left text-sm hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                >
                  <div className="col-span-6 font-medium">{f.originalName}</div>
                  <div className="col-span-3 text-black/60 dark:text-white/60">{f.contentType}</div>
                  <div className="col-span-3">
                    <span className="rounded-full border border-black/10 px-2 py-1 text-xs dark:border-white/10">
                      {f.status}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

