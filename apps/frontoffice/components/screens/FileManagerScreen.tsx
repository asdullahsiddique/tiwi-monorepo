export type FileListItem = {
  fileId: string;
  originalName: string;
  contentType: string;
  status: string;
  createdAt: string;
};

const FILE_STATUS_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  UPLOADING: {
    bg: "bg-slate-500/10",
    text: "text-slate-600",
    border: "border-slate-500/30",
  },
  UPLOADED: {
    bg: "bg-slate-500/10",
    text: "text-slate-600",
    border: "border-slate-500/30",
  },
  QUEUED: {
    bg: "bg-amber-500/10",
    text: "text-amber-600",
    border: "border-amber-500/30",
  },
  PROCESSING: {
    bg: "bg-blue-500/10",
    text: "text-blue-600",
    border: "border-blue-500/30",
  },
  PROCESSED: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-600",
    border: "border-emerald-500/30",
  },
  FAILED: {
    bg: "bg-red-500/10",
    text: "text-red-600",
    border: "border-red-500/30",
  },
};

function getFileStatusStyle(status: string) {
  return FILE_STATUS_STYLES[status] ?? FILE_STATUS_STYLES.UPLOADING;
}

export function FileManagerScreen(props: {
  items: FileListItem[];
  isUploading: boolean;
  error?: string | null;
  onPickFiles: () => void;
  onOpenFile: (fileId: string) => void;
}) {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted-2)]">
            File Manager
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Files</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
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
        <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          {props.error}
        </div>
      ) : null}

      <div className="mt-10 overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] backdrop-blur">
        <div className="grid grid-cols-12 gap-3 border-b border-[color:var(--border)] px-5 py-3 text-xs uppercase tracking-[0.18em] text-[var(--muted-2)]">
          <div className="col-span-6">Name</div>
          <div className="col-span-3">Type</div>
          <div className="col-span-3">Status</div>
        </div>

        {props.items.length === 0 ? (
          <div className="px-5 py-10 text-sm text-[var(--muted)]">
            No files yet.
          </div>
        ) : (
          <div className="divide-y divide-[color:var(--border)]">
            {props.items.map((f) => (
              <button
                key={f.fileId}
                onClick={() => props.onOpenFile(f.fileId)}
                className="grid w-full grid-cols-12 gap-3 px-5 py-4 text-left text-sm hover:bg-black/[0.03]"
              >
                <div className="col-span-6 font-medium">{f.originalName}</div>
                <div className="col-span-3 text-[var(--muted)]">
                  {f.contentType}
                </div>
                <div className="col-span-3">
                  {(() => {
                    const style = getFileStatusStyle(f.status);
                    return (
                      <span className={`rounded-full border px-2 py-1 text-xs font-medium ${style.bg} ${style.text} ${style.border}`}>
                        {f.status}
                      </span>
                    );
                  })()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
