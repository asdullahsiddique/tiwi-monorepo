export type ProcessFileV1Payload = {
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;
  contentType: string;
  originalName: string;
};

export const QUEUE_NAME = "tiwi:file-processing";
export const JOB_PROCESS_FILE_V1 = "ProcessFileV1";

