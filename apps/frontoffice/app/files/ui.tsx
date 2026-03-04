"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/trpc";
import {
  FileManagerScreen,
  type FileListItem,
} from "@/components/screens/FileManagerScreen";

export default function FilesClient() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const utils = api.useUtils();
  const listQuery = api.files.list.useQuery({ limit: 50, offset: 0 });
  const requestUploadMutation = api.files.requestUpload.useMutation();
  const commitUploadMutation = api.files.commitUpload.useMutation();

  const isUploading =
    requestUploadMutation.isPending || commitUploadMutation.isPending;

  const items: FileListItem[] = useMemo(() => {
    const raw = listQuery.data?.items ?? [];
    return raw.map((f: any) => ({
      fileId: f.fileId,
      originalName: f.originalName,
      contentType: f.contentType,
      status: f.status,
      createdAt: f.createdAt,
    }));
  }, [listQuery.data]);

  async function uploadOne(file: File) {
    setError(null);
    const req = await requestUploadMutation.mutateAsync({
      originalName: file.name,
      contentType: file.type || "application/octet-stream",
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
            e.target.value = "";
          }
        }}
      />

      <FileManagerScreen
        items={items}
        isLoading={listQuery.isLoading}
        isUploading={isUploading}
        error={error ?? listQuery.error?.message ?? null}
        onPickFiles={() => fileInputRef.current?.click()}
        onOpenFile={(fileId) => router.push(`/files/${fileId}`)}
      />
    </>
  );
}
