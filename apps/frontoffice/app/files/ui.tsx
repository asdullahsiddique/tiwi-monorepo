"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc";
import {
  FileManagerScreen,
  type FileListItem,
} from "@/components/screens/FileManagerScreen";

type DocumentType = "interview" | "grand_prix_result";

const DOCUMENT_TYPE_OPTIONS: Array<{
  value: DocumentType;
  label: string;
  description: string;
}> = [
  {
    value: "interview",
    label: "Interview",
    description: "Process as a standard media/document upload.",
  },
  {
    value: "grand_prix_result",
    label: "Grand Prix results",
    description: "Extract the visible race result table with Claude.",
  },
];

export default function FilesClient() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTypePickerOpen, setIsTypePickerOpen] = useState(false);
  const [selectedDocumentType, setSelectedDocumentType] =
    useState<DocumentType | null>(null);

  const utils = api.useUtils();
  const listQuery = api.files.list.useQuery({ limit: 50, offset: 0 });
  const requestUploadMutation = api.files.requestUpload.useMutation();
  const commitUploadMutation = api.files.commitUpload.useMutation();

  const isUploading =
    requestUploadMutation.isPending || commitUploadMutation.isPending;

  const items: FileListItem[] = useMemo(() => {
    const raw = listQuery.data?.items ?? [];
    return raw.map((f) => ({
      fileId: f.fileId,
      originalName: f.originalName,
      contentType: f.contentType,
      documentType: f.documentType,
      status: f.status,
      createdAt: f.createdAt,
    }));
  }, [listQuery.data]);

  async function uploadOne(file: File) {
    if (!selectedDocumentType) {
      setError("Choose a file type before uploading.");
      return;
    }

    setError(null);
    const req = await requestUploadMutation.mutateAsync({
      originalName: file.name,
      contentType: file.type || "application/octet-stream",
      documentType: selectedDocumentType,
    });

    const putRes = await fetch(req.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

    await commitUploadMutation.mutateAsync({
      fileId: req.fileId,
      objectKey: req.objectKey,
      originalName: file.name,
      contentType: file.type || "application/octet-stream",
      documentType: selectedDocumentType,
      sizeBytes: file.size,
    });

    void utils.files.list.invalidate();
    router.push(`/files/${req.fileId}`);
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            await uploadOne(file);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Upload failed");
          } finally {
            setSelectedDocumentType(null);
            e.target.value = "";
          }
        }}
      />

      {isTypePickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-[color:var(--border)] bg-[var(--background)] p-6 shadow-xl">
            <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted-2)]">
              Upload type
            </div>
            <h2 className="mt-2 text-2xl font-semibold">
              What are you uploading?
            </h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              This controls which AI processing pipeline runs after upload.
            </p>

            <div className="mt-6 space-y-3">
              {DOCUMENT_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    setSelectedDocumentType(option.value);
                    setIsTypePickerOpen(false);
                    window.setTimeout(() => fileInputRef.current?.click(), 0);
                  }}
                  className="w-full rounded-xl border border-[color:var(--border)] bg-[var(--surface)] p-4 text-left transition hover:bg-[var(--surface-2)]"
                >
                  <div className="font-medium">{option.label}</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    {option.description}
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={() => {
                setSelectedDocumentType(null);
                setIsTypePickerOpen(false);
              }}
              className="mt-5 rounded-full border border-[color:var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <FileManagerScreen
        items={items}
        isLoading={listQuery.isLoading}
        isUploading={isUploading}
        error={error ?? listQuery.error?.message ?? null}
        onPickFiles={() => setIsTypePickerOpen(true)}
        onOpenFile={(fileId) => router.push(`/files/${fileId}`)}
      />
    </>
  );
}
