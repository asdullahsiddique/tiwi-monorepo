import type { DocumentType } from "@tiwi/mongodb";

export type ProcessFileV1Payload = {
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;
  contentType: string;
  originalName: string;
  documentType?: DocumentType;
};
