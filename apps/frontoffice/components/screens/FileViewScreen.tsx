"use client";

import { useMemo, useState } from "react";
import type { AIExecutionLogRecord, ProcessingLogRecord } from "@tiwi/neo4j";
import { EntityGraph } from "../EntityGraph";

type AILogSummary = {
  purpose: string;
  count: number;
  totalTokens: number;
  totalCost: number;
  model: string;
  logs: AIExecutionLogRecord[];
};

function summarizeAILogs(logs: AIExecutionLogRecord[]): AILogSummary[] {
  const grouped = new Map<string, AILogSummary>();

  for (const log of logs) {
    const key = `${log.purpose}:${log.model}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
      existing.totalTokens += log.totalTokens;
      existing.totalCost += log.costUsd;
      existing.logs.push(log);
    } else {
      grouped.set(key, {
        purpose: log.purpose,
        count: 1,
        totalTokens: log.totalTokens,
        totalCost: log.costUsd,
        model: log.model,
        logs: [log],
      });
    }
  }

  return Array.from(grouped.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

const LOG_LEVEL_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  DEBUG: {
    bg: "bg-slate-500/10",
    text: "text-slate-600",
    border: "border-slate-500/30",
  },
  INFO: {
    bg: "bg-blue-500/10",
    text: "text-blue-600",
    border: "border-blue-500/30",
  },
  WARN: {
    bg: "bg-amber-500/10",
    text: "text-amber-600",
    border: "border-amber-500/30",
  },
  ERROR: {
    bg: "bg-red-500/10",
    text: "text-red-600",
    border: "border-red-500/30",
  },
};

function getLogLevelStyle(level: string) {
  return LOG_LEVEL_STYLES[level] ?? LOG_LEVEL_STYLES.INFO;
}

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

function ProcessingLogDetailModal(props: {
  log: ProcessingLogRecord;
  onClose: () => void;
}) {
  const style = getLogLevelStyle(props.log.level);
  const metadata = props.log.metadata as Record<string, unknown> | undefined;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[var(--background)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[color:var(--border)] px-6 py-4">
          <div className="flex items-center gap-3">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text} ${style.border} border`}>
              {props.log.level}
            </span>
            <span className="text-xs text-[var(--muted-2)]">{props.log.createdAt}</span>
          </div>
          <button
            onClick={props.onClose}
            className="rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--surface-2)]"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-6">
          <div className="text-sm font-medium">{props.log.message}</div>
          
          {typeof metadata?.error !== "undefined" && metadata?.error !== null && (
            <div className="mt-4">
              <div className="text-xs font-medium text-[var(--muted-2)] uppercase tracking-wider">Error</div>
              <div className="mt-2 rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-700 font-mono">
                {String(metadata.error)}
              </div>
            </div>
          )}
          
          {typeof metadata?.stack !== "undefined" && metadata?.stack !== null && (
            <div className="mt-4">
              <div className="text-xs font-medium text-[var(--muted-2)] uppercase tracking-wider">Stack trace</div>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs font-mono text-[var(--muted)] whitespace-pre-wrap">
                {String(metadata.stack)}
              </pre>
            </div>
          )}
          
          {metadata && Object.keys(metadata).filter(k => k !== 'error' && k !== 'stack').length > 0 && (
            <div className="mt-4">
              <div className="text-xs font-medium text-[var(--muted-2)] uppercase tracking-wider">Metadata</div>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--surface-2)] p-3 text-xs font-mono text-[var(--muted)]">
                {JSON.stringify(
                  Object.fromEntries(
                    Object.entries(metadata).filter(([k]) => k !== 'error' && k !== 'stack')
                  ),
                  null,
                  2
                )}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AILogsModal(props: {
  summary: AILogSummary;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-[color:var(--border)] bg-[var(--background)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[color:var(--border)] px-6 py-4">
          <div>
            <div className="font-medium">{props.summary.purpose}</div>
            <div className="mt-1 text-xs text-[var(--muted)]">
              {props.summary.count} calls · {props.summary.totalTokens.toLocaleString()} tokens · ${props.summary.totalCost.toFixed(4)}
            </div>
          </div>
          <button
            onClick={props.onClose}
            className="rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--surface-2)]"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-6">
          <div className="space-y-2 text-xs">
            {props.summary.logs.map((l) => (
              <div
                key={l.logId}
                className="rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="font-medium">{l.model}</div>
                  <div className="text-[var(--muted-2)]">{l.createdAt}</div>
                </div>
                <div className="mt-1 text-[var(--muted-2)]">
                  Tokens: {l.totalTokens.toLocaleString()} · Cost: ${l.costUsd.toFixed(6)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export type FileViewEntity = {
  entityId: string;
  typeName: string;
  name: string;
  properties: Record<string, unknown>;
};

export type FileViewRelationship = {
  relationshipId: string;
  fromTypeName: string;
  fromName: string;
  toTypeName: string;
  toName: string;
  relationshipType: string;
  properties: Record<string, unknown>;
};

// Tailwind color classes for deterministic entity type colors
const TAILWIND_COLOR_CLASSES = [
  { bg: "bg-blue-500/10", text: "text-blue-600", border: "border-blue-500/30" },
  { bg: "bg-emerald-500/10", text: "text-emerald-600", border: "border-emerald-500/30" },
  { bg: "bg-amber-500/10", text: "text-amber-600", border: "border-amber-500/30" },
  { bg: "bg-red-500/10", text: "text-red-600", border: "border-red-500/30" },
  { bg: "bg-violet-500/10", text: "text-violet-600", border: "border-violet-500/30" },
  { bg: "bg-pink-500/10", text: "text-pink-600", border: "border-pink-500/30" },
  { bg: "bg-cyan-500/10", text: "text-cyan-600", border: "border-cyan-500/30" },
  { bg: "bg-orange-500/10", text: "text-orange-600", border: "border-orange-500/30" },
  { bg: "bg-indigo-500/10", text: "text-indigo-600", border: "border-indigo-500/30" },
  { bg: "bg-teal-500/10", text: "text-teal-600", border: "border-teal-500/30" },
  { bg: "bg-lime-500/10", text: "text-lime-600", border: "border-lime-500/30" },
  { bg: "bg-purple-500/10", text: "text-purple-600", border: "border-purple-500/30" },
  { bg: "bg-green-500/10", text: "text-green-600", border: "border-green-500/30" },
  { bg: "bg-yellow-500/10", text: "text-yellow-600", border: "border-yellow-500/30" },
  { bg: "bg-sky-500/10", text: "text-sky-600", border: "border-sky-500/30" },
  { bg: "bg-fuchsia-500/10", text: "text-fuchsia-600", border: "border-fuchsia-500/30" },
  { bg: "bg-rose-500/10", text: "text-rose-600", border: "border-rose-500/30" },
  { bg: "bg-slate-500/10", text: "text-slate-600", border: "border-slate-500/30" },
];

/**
 * Simple hash function for strings.
 * Returns a consistent number for the same input string.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

/**
 * Get deterministic color classes for an entity type.
 * Same type name will always produce the same color.
 */
function getEntityTypeColor(typeName: string) {
  const hash = hashString(typeName);
  const index = hash % TAILWIND_COLOR_CLASSES.length;
  return TAILWIND_COLOR_CLASSES[index];
}

export function FileViewScreen(props: {
  title: string;
  status: string;
  contentType: string;
  downloadUrl: string | null;
  summary: string | null;
  embeddingsMeta: { chunkCount: number; model?: string };
  processingLogs: ProcessingLogRecord[];
  aiLogs: AIExecutionLogRecord[];
  entities: FileViewEntity[];
  relationships: FileViewRelationship[];
  onReprocess?: () => void;
  isReprocessing?: boolean;
}) {
  const [selectedAILogSummary, setSelectedAILogSummary] = useState<AILogSummary | null>(null);
  const [selectedProcessingLog, setSelectedProcessingLog] = useState<ProcessingLogRecord | null>(null);
  
  const aiLogSummaries = useMemo(() => summarizeAILogs(props.aiLogs), [props.aiLogs]);
  const totalAICost = useMemo(
    () => props.aiLogs.reduce((sum, l) => sum + l.costUsd, 0),
    [props.aiLogs]
  );
  const totalAITokens = useMemo(
    () => props.aiLogs.reduce((sum, l) => sum + l.totalTokens, 0),
    [props.aiLogs]
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted-2)]">
            File View
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {props.title}
          </h1>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {(() => {
              const statusStyle = getFileStatusStyle(props.status);
              return (
                <span className={`rounded-full border px-2 py-1 font-medium ${statusStyle.bg} ${statusStyle.text} ${statusStyle.border}`}>
                  {props.status}
                </span>
              );
            })()}
            <span className="rounded-full border border-[color:var(--border)] bg-[var(--surface-2)] px-2 py-1 text-[var(--muted)]">
              {props.contentType}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {props.onReprocess && (
            <button
              onClick={props.onReprocess}
              disabled={props.isReprocessing || props.status === "PROCESSING" || props.status === "QUEUED"}
              className="flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[var(--surface-2)] px-4 py-2.5 text-sm font-medium text-[var(--foreground)] shadow-sm hover:bg-[var(--surface-3)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg
                className={`h-4 w-4 ${props.isReprocessing ? "animate-spin" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              {props.isReprocessing ? "Reprocessing..." : "Reprocess"}
            </button>
          )}
          {props.downloadUrl && (
            <a
              href={props.downloadUrl}
              className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-black/10 hover:opacity-95"
              target="_blank"
              rel="noreferrer"
            >
              Open original
            </a>
          )}
        </div>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">Original</div>
            <div className="mt-3 text-sm text-[var(--muted)]">
              {props.downloadUrl ? (
                <div className="overflow-hidden rounded-xl border border-[color:var(--border)] bg-white">
                  <iframe
                    className="h-[520px] w-full"
                    src={props.downloadUrl}
                  />
                </div>
              ) : (
                "No download URL available yet."
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">AI Summary</div>
            <div className="mt-3 whitespace-pre-wrap text-sm text-[var(--muted)]">
              {props.summary ?? "No summary yet."}
            </div>
          </section>

          {/* Knowledge Graph Visualization */}
          {(props.entities.length > 0 || props.relationships.length > 0) && (
            <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
              <div className="flex items-center justify-between mb-4">
                <div className="text-sm font-medium">Knowledge Graph</div>
                <div className="text-xs text-[var(--muted)]">
                  {props.entities.length} entities · {props.relationships.length} relationships
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 overflow-hidden shadow-inner">
                <EntityGraph
                  entities={props.entities}
                  relationships={props.relationships}
                  height={500}
                />
              </div>
            </section>
          )}

          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">Processing logs</div>
            <div className="mt-3 space-y-2 text-xs">
              {props.processingLogs.length === 0 ? (
                <div className="text-[var(--muted)]">No logs yet.</div>
              ) : (
                props.processingLogs.map((l) => {
                  const style = getLogLevelStyle(l.level);
                  const hasDetails = l.level === "ERROR" || l.metadata;
                  const metadata = l.metadata as Record<string, unknown> | undefined;
                  const errorMessage = metadata?.error ? String(metadata.error) : null;
                  
                  return (
                    <button
                      key={l.logId}
                      onClick={() => hasDetails && setSelectedProcessingLog(l)}
                      disabled={!hasDetails}
                      className={`w-full rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left transition-colors ${
                        hasDetails ? "cursor-pointer hover:bg-[var(--surface-3)]" : "cursor-default"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${style.bg} ${style.text} ${style.border}`}>
                            {l.level}
                          </span>
                          <span className="font-medium text-[var(--foreground)] truncate">
                            {l.level === "ERROR" && errorMessage 
                              ? errorMessage.slice(0, 50) + (errorMessage.length > 50 ? "..." : "")
                              : l.message}
                          </span>
                        </div>
                        {hasDetails && (
                          <svg className="h-4 w-4 flex-shrink-0 text-[var(--muted-2)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        )}
                      </div>
                      <div className="mt-1 text-[var(--muted-2)]">
                        {new Date(l.createdAt).toLocaleString()}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {selectedProcessingLog && (
            <ProcessingLogDetailModal
              log={selectedProcessingLog}
              onClose={() => setSelectedProcessingLog(null)}
            />
          )}
        </div>

        <div className="space-y-6">
          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">Embeddings</div>
            <div className="mt-3 text-sm text-[var(--muted)]">
              <div>
                Chunks:{" "}
                <span className="font-medium">
                  {props.embeddingsMeta.chunkCount}
                </span>
              </div>
              <div className="mt-1 text-[var(--muted-2)]">
                Model: {props.embeddingsMeta.model ?? "—"}
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">AI execution logs</div>
            {props.aiLogs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--muted)]">
                <span>{props.aiLogs.length} calls</span>
                <span>{totalAITokens.toLocaleString()} tokens</span>
                <span>${totalAICost.toFixed(4)} total</span>
              </div>
            )}
            <div className="mt-3 space-y-2 text-xs">
              {aiLogSummaries.length === 0 ? (
                <div className="text-[var(--muted)]">No AI logs yet.</div>
              ) : (
                aiLogSummaries.map((s) => (
                  <button
                    key={`${s.purpose}:${s.model}`}
                    onClick={() => setSelectedAILogSummary(s)}
                    className="w-full rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left transition-colors hover:bg-[var(--surface-3)]"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="font-medium">{s.purpose}</div>
                      <div className="text-[var(--muted-2)]">{s.count}x</div>
                    </div>
                    <div className="mt-1 text-[var(--muted)]">{s.model}</div>
                    <div className="mt-1 text-[var(--muted-2)]">
                      {s.totalTokens.toLocaleString()} tokens · ${s.totalCost.toFixed(4)}
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          {selectedAILogSummary && (
            <AILogsModal
              summary={selectedAILogSummary}
              onClose={() => setSelectedAILogSummary(null)}
            />
          )}

          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">Extracted Entities</div>
            <div className="mt-3">
              {props.entities.length === 0 ? (
                <div className="text-sm text-[var(--muted)]">No entities extracted yet.</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {props.entities.map((e) => {
                    const color = getEntityTypeColor(e.typeName);
                    return (
                      <div
                        key={e.entityId}
                        className={`rounded-lg border px-3 py-2 ${color.bg} ${color.border}`}
                      >
                        <div className={`text-xs font-medium ${color.text}`}>
                          {e.typeName}
                        </div>
                        <div className="mt-0.5 text-sm font-medium text-[var(--foreground)]">
                          {e.name}
                        </div>
                        {Object.keys(e.properties).length > 0 && (
                          <div className="mt-1 text-xs text-[var(--muted-2)]">
                            {Object.entries(e.properties)
                              .slice(0, 2)
                              .map(([k, v]) => `${k}: ${String(v)}`)
                              .join(", ")}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
            <div className="text-sm font-medium">Relationships</div>
            <div className="mt-3">
              {props.relationships.length === 0 ? (
                <div className="text-sm text-[var(--muted)]">No relationships extracted yet.</div>
              ) : (
                <div className="space-y-2">
                  {props.relationships.map((r) => {
                    const fromColor = getEntityTypeColor(r.fromTypeName);
                    const toColor = getEntityTypeColor(r.toTypeName);
                    return (
                      <div
                        key={r.relationshipId}
                        className="rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 py-2"
                      >
                        <div className="flex items-center gap-2 text-sm flex-wrap">
                          <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${fromColor.bg} ${fromColor.text} ${fromColor.border}`}>
                            {r.fromTypeName}
                          </span>
                          <span className="font-medium text-[var(--foreground)]">{r.fromName}</span>
                          <svg className="h-4 w-4 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                          <span className="rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                            {r.relationshipType}
                          </span>
                          <svg className="h-4 w-4 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                          <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${toColor.bg} ${toColor.text} ${toColor.border}`}>
                            {r.toTypeName}
                          </span>
                          <span className="font-medium text-[var(--foreground)]">{r.toName}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
