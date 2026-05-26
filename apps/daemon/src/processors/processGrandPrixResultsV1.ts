import { GetObjectCommand } from "@aws-sdk/client-s3";
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  FileRepository,
  getMongoDb,
  GpResultRepository,
  LogRepository,
} from "@tiwi/mongodb";
import { createS3Client } from "@tiwi/storage";
import type { ProcessFileV1Payload } from "../jobs/types";

const CLAUDE_GP_RESULTS_MODEL = "claude-opus-4-7";

const GpResultsEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
});

const nullableOptionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const nullableOptionalNumber = z
  .number()
  .nullish()
  .transform((value) => value ?? undefined);
const nullableOptionalPosition = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((value) => value ?? undefined);

const GpResultExtractionSchema = z.object({
  grandPrix: z.string().min(1),
  circuit: z.string().min(1),
  country: nullableOptionalString,
  dateStart: nullableOptionalString,
  dateEnd: nullableOptionalString,
  results: z.array(
    z.object({
      position: nullableOptionalPosition,
      driver: z.string().min(1),
      team: z.string().min(1),
      car: nullableOptionalString,
      timeOrGap: nullableOptionalString,
      points: nullableOptionalNumber,
    }),
  ),
});

async function streamToBuffer(stream: any): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function responseText(response: Anthropic.Messages.Message): string {
  return response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Claude response did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildAnthropicFileBlock(params: {
  contentType: string;
  body: Buffer;
}): Record<string, unknown> {
  const data = params.body.toString("base64");
  if (params.contentType.startsWith("image/")) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: params.contentType,
        data,
      },
    };
  }
  if (params.contentType === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data,
      },
    };
  }
  throw new Error(
    `Grand Prix result extraction supports images and PDFs only, got ${params.contentType}`,
  );
}

export async function processGrandPrixResultsV1(
  payload: ProcessFileV1Payload,
): Promise<void> {
  const env = GpResultsEnvSchema.parse(process.env);

  const db = await getMongoDb();
  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const gpResultRepo = new GpResultRepository(db);

  const file = await fileRepo.getFile({
    orgId: payload.orgId,
    fileId: payload.fileId,
  });
  if (!file) {
    throw new Error(`File not found: ${payload.fileId}`);
  }

  await logRepo.appendProcessingLog({
    orgId: payload.orgId,
    fileId: payload.fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Starting Grand Prix results extraction with Claude",
    metadata: {
      contentType: file.contentType,
      model: CLAUDE_GP_RESULTS_MODEL,
      documentType: payload.documentType,
    },
  });

  const { client: s3, bucket } = createS3Client();
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }),
  );
  const body = await streamToBuffer(obj.Body);

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = anthropic.messages.stream({
    model: CLAUDE_GP_RESULTS_MODEL,
    max_tokens: 4096,
    system:
      "You extract Formula 1 Grand Prix race-result tables from uploaded PDFs or images. Return only strict JSON. Numeric points must be JSON numbers. Preserve visible names and table values exactly when possible.",
    messages: [
      {
        role: "user",
        content: [
          buildAnthropicFileBlock({
            contentType: file.contentType,
            body,
          }),
          {
            type: "text",
            text: 'Extract the Grand Prix result table. The visual format usually has a country/title header, date range, location/circuit, and rows with P, drivers, teams, cars/power unit, time, and points.\n\nReturn JSON with this exact shape:\n{\n  "grandPrix": "Australian Grand Prix",\n  "circuit": "Albert Park Circuit",\n  "country": "Australia",\n  "dateStart": "14.03",\n  "dateEnd": "16.03",\n  "results": [\n    { "position": 1, "driver": "L. Norris", "team": "McLaren", "car": "MCL39-Mercedes", "timeOrGap": "1:42:06.304", "points": 25 }\n  ]\n}\n\nInclude classified finishers, DNF, and DNS rows if visible. Use timeOrGap for full race time, gaps, DNF, DNS, or other status text.',
          },
        ] as any,
      },
    ],
  });
  const response = await stream.finalMessage();

  const parsed = GpResultExtractionSchema.parse(
    parseJsonObject(responseText(response)),
  );

  await gpResultRepo.upsertForFile({
    orgId: payload.orgId,
    fileId: payload.fileId,
    grandPrix: parsed.grandPrix,
    circuit: parsed.circuit,
    country: parsed.country,
    dateStart: parsed.dateStart,
    dateEnd: parsed.dateEnd,
    results: parsed.results,
  });

  await logRepo.appendAIExecutionLog({
    orgId: payload.orgId,
    fileId: payload.fileId,
    logId: nanoid(),
    model: CLAUDE_GP_RESULTS_MODEL,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    costUsd: 0,
    purpose: "gp_results:extract",
    metadata: {
      resultRows: parsed.results.length,
      grandPrix: parsed.grandPrix,
      circuit: parsed.circuit,
    },
  });

  await logRepo.appendProcessingLog({
    orgId: payload.orgId,
    fileId: payload.fileId,
    logId: nanoid(),
    level: "INFO",
    message: `Grand Prix results extraction complete: ${parsed.results.length} row(s)`,
    metadata: {
      grandPrix: parsed.grandPrix,
      circuit: parsed.circuit,
      country: parsed.country,
    },
  });
}
