export function buildObjectKey(params: {
  orgId: string;
  userId: string;
  folder?: string;
  fileId: string;
  ext?: string;
}): string {
  const folder = params.folder ? params.folder.replace(/^\/+|\/+$/g, "") : "";
  const ext = params.ext ? params.ext.replace(/^\./, "") : "";
  const parts = [
    `org/${params.orgId}`,
    `user/${params.userId}`,
    ...(folder ? [folder] : []),
    `${params.fileId}${ext ? `.${ext}` : ""}`,
  ];
  return parts.join("/");
}

