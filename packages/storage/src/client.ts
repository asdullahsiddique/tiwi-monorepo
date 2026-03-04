import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getStorageEnv } from "./env";

export function createS3Client(env: NodeJS.ProcessEnv = process.env): {
  client: S3Client;
  bucket: string;
} {
  const cfg = getStorageEnv(env);
  const client = new S3Client({
    region: cfg.S3_REGION,
    ...(cfg.S3_ENDPOINT && { endpoint: cfg.S3_ENDPOINT }),
    ...(cfg.S3_ACCESS_KEY_ID &&
      cfg.S3_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: cfg.S3_ACCESS_KEY_ID,
          secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
        },
      }),
    ...(cfg.S3_FORCE_PATH_STYLE && { forcePathStyle: cfg.S3_FORCE_PATH_STYLE }),
  });
  return { client, bucket: cfg.S3_BUCKET };
}

export async function createPresignedPutUrl(params: {
  objectKey: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const { client, bucket } = createS3Client();
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: params.objectKey,
    ContentType: params.contentType,
  });
  return getSignedUrl(client, cmd, { expiresIn: params.expiresInSeconds ?? 60 * 10 });
}

export async function createPresignedGetUrl(params: {
  objectKey: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const { client, bucket } = createS3Client();
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: params.objectKey,
  });
  return getSignedUrl(client, cmd, { expiresIn: params.expiresInSeconds ?? 60 * 10 });
}

export async function getObjectContent(params: {
  objectKey: string;
}): Promise<Buffer | null> {
  const { client, bucket } = createS3Client();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: params.objectKey,
    })
  );

  if (!response.Body) return null;

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

