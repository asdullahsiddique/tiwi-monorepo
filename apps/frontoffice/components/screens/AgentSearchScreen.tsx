"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type AgentChatMessageStatus = "running" | "completed" | "failed";

export type AgentChatMessage = {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /**
   * Lifecycle status for assistant messages. `running` shows the live
   * Claude-style activity indicator; absent or `completed` renders the
   * markdown body normally; `failed` renders the body styled as an error.
   */
  status?: AgentChatMessageStatus;
  /**
   * One-line label describing what the agent is doing right now
   * (e.g. "Reading Doppietta Ferrari nella Qualifying Race a Macao.pdf").
   * Updated on every poll while `status === "running"`.
   */
  currentActivity?: string;
};

export type AgentConversation = {
  conversationId: string;
  title: string;
  messages: AgentChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type AgentSearchScreenProps = {
  conversations: AgentConversation[];
  activeConversation: AgentConversation | null;
  isResponding: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onNewChat: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation?: (conversationId: string, nextTitle: string) => void;
  greetingName?: string | null;
  examplePrompts?: string[];
};

const HISTORY_BUCKETS: { label: string; maxAgeMs: number }[] = [
  { label: "Today", maxAgeMs: 24 * 60 * 60 * 1000 },
  { label: "Yesterday", maxAgeMs: 2 * 24 * 60 * 60 * 1000 },
  { label: "Previous 7 days", maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "Previous 30 days", maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
];

function bucketLabel(updatedAt: string): string {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  for (const bucket of HISTORY_BUCKETS) {
    if (ageMs <= bucket.maxAgeMs) return bucket.label;
  }
  return "Older";
}

function groupByBucket(conversations: AgentConversation[]) {
  const groups = new Map<string, AgentConversation[]>();
  const order: string[] = [];
  for (const c of conversations) {
    const label = bucketLabel(c.updatedAt);
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(c);
  }
  return order.map((label) => ({ label, items: groups.get(label)! }));
}

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function MarkdownBody(props: { value: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="my-3 leading-7">{children}</p>,
        ul: ({ children }) => (
          <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>
        ),
        code: ({ children }) => (
          <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--foreground)]">
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="my-4 overflow-x-auto rounded-xl border border-[color:var(--border)] bg-[var(--surface-2)] p-4 text-xs text-[var(--foreground)]">
            {children}
          </pre>
        ),
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {children}
          </a>
        ),
      }}
    >
      {props.value}
    </ReactMarkdown>
  );
}

function AutoGrowTextarea(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  minRows?: number;
  maxRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const minRows = props.minRows ?? 1;
  const maxRows = props.maxRows ?? 8;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || "24");
    const maxHeight = lineHeight * maxRows;
    const minHeight = lineHeight * minRows;
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [props.value, minRows, maxRows]);

  return (
    <textarea
      ref={ref}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      rows={minRows}
      className="block w-full resize-none bg-transparent text-[15px] leading-6 outline-none placeholder:text-[var(--muted-2)]"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (!props.disabled && props.value.trim().length > 0)
            props.onSubmit();
        }
      }}
    />
  );
}

function Composer(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  isResponding: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const canSubmit = props.value.trim().length > 0 && !props.isResponding;
  return (
    <div className="rounded-3xl border border-[color:var(--border)] bg-[var(--surface)] p-3 shadow-[0_8px_30px_-12px_rgba(17,24,39,0.18)] backdrop-blur transition-shadow focus-within:shadow-[0_12px_40px_-12px_rgba(17,24,39,0.28)]">
      <div className="px-3 pt-2">
        <AutoGrowTextarea
          value={props.value}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          placeholder={props.placeholder ?? "Ask the agent anything…"}
          disabled={props.isResponding}
          autoFocus={props.autoFocus}
          minRows={1}
          maxRows={10}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 px-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled
            title="File attachments (coming soon)"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--muted-2)] hover:bg-black/[0.04] hover:text-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg
              className="h-[18px] w-[18px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
          <span className="hidden text-[11px] text-[var(--muted-2)] sm:inline">
            Shift + Enter for newline
          </span>
        </div>
        <button
          type="button"
          onClick={props.onSubmit}
          disabled={!canSubmit}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-sm font-medium text-white shadow-sm shadow-black/10 transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:bg-[var(--muted-2)] disabled:opacity-60"
        >
          {props.isResponding ? (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-white/90" />
              Thinking
            </>
          ) : (
            <>
              Send
              <svg
                className="h-[14px] w-[14px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.4}
                  d="M5 12h14m0 0l-5-5m5 5l-5 5"
                />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function HistoryRail(props: {
  conversations: AgentConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}) {
  const grouped = useMemo(
    () => groupByBucket(props.conversations),
    [props.conversations],
  );
  return (
    <div className="flex h-full flex-col">
      <div className="px-2 pb-3">
        <button
          onClick={props.onNewChat}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-[color:var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-white"
        >
          <span className="flex items-center gap-2">
            <svg
              className="h-4 w-4 text-[var(--muted)]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New chat
          </span>
          <span className="hidden text-[10px] uppercase tracking-[0.18em] text-[var(--muted-2)] sm:inline">
            ⌘N
          </span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        {props.conversations.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-[var(--muted-2)]">
            No conversations yet.
            <br />
            Start asking the agent to build history.
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map((group) => (
              <div key={group.label}>
                <div className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--muted-2)]">
                  {group.label}
                </div>
                <ul className="space-y-0.5">
                  {group.items.map((conv) => {
                    const isActive = conv.conversationId === props.activeId;
                    return (
                      <li key={conv.conversationId}>
                        <div
                          className={`group relative flex items-center rounded-lg pr-1 transition-colors ${
                            isActive
                              ? "bg-[var(--accent)]/10"
                              : "hover:bg-black/[0.04]"
                          }`}
                        >
                          <button
                            onClick={() => props.onSelect(conv.conversationId)}
                            className="flex-1 truncate px-3 py-2 text-left text-[13px]"
                            title={conv.title}
                          >
                            <span
                              className={`truncate ${
                                isActive
                                  ? "text-[var(--accent)]"
                                  : "text-[var(--foreground)]"
                              }`}
                            >
                              {conv.title || "Untitled chat"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onDelete(conv.conversationId);
                            }}
                            title="Delete conversation"
                            className="invisible ml-1 rounded-md p-1 text-[var(--muted-2)] transition-colors hover:bg-red-500/10 hover:text-red-500 group-hover:visible"
                          >
                            <svg
                              className="h-3.5 w-3.5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.8}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState(props: {
  greetingName?: string | null;
  examplePrompts?: string[];
  onPick: (prompt: string) => void;
  composer: React.ReactNode;
}) {
  const greeting = timeOfDayGreeting();
  const name = props.greetingName?.trim() || null;
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="w-full max-w-2xl">
        <div className="text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[var(--surface)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            Agent Search
          </div>
          <h1 className="text-[34px] font-semibold leading-tight tracking-tight text-[var(--foreground)]">
            {greeting}
            {name ? `, ${name}` : ""}.
          </h1>
          <p className="mt-2 text-[15px] text-[var(--muted)]">
            What would you like to research in your archive today?
          </p>
        </div>

        <div className="mt-8">{props.composer}</div>

        {(props.examplePrompts ?? []).length > 0 ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {props.examplePrompts!.map((prompt) => (
              <button
                key={prompt}
                onClick={() => props.onPick(prompt)}
                className="rounded-full border border-[color:var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-[13px] text-[var(--muted)] transition-colors hover:bg-white hover:text-[var(--foreground)]"
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-10 text-center text-[11px] text-[var(--muted-2)]">
          The agent backend is being wired up. Conversations are saved locally
          on this device for now.
        </div>
      </div>
    </div>
  );
}

function AgentActivityLine(props: { label: string }) {
  // Whenever `label` changes we remount the inner span (via key) so the
  // CSS animation re-runs, producing a Claude-style cross-fade. The dot
  // is a steady pulse to convey "still working".
  return (
    <div className="flex items-center gap-2 py-2 text-[13px] text-[var(--muted)]">
      <span aria-hidden className="relative inline-flex h-2 w-2 flex-shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)] opacity-60" />
        <span className="relative h-2 w-2 rounded-full bg-[var(--accent)]" />
      </span>
      <span key={props.label} className="agent-activity-line italic">
        {props.label}
      </span>
    </div>
  );
}

function MessageBubble(props: { message: AgentChatMessage }) {
  if (props.message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-[var(--foreground)] px-4 py-2.5 text-[15px] leading-7 text-white shadow-sm shadow-black/10">
          <div className="whitespace-pre-wrap">{props.message.content}</div>
        </div>
      </div>
    );
  }
  const isRunning = props.message.status === "running";
  const isFailed = props.message.status === "failed";
  const hasContent = props.message.content.trim().length > 0;
  const activityLabel = props.message.currentActivity?.trim() || "Thinking...";
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[12px] font-semibold text-white">
        T
      </div>
      <div className="min-w-0 flex-1 text-[15px] text-[var(--foreground)]">
        {isRunning && !hasContent ? (
          <AgentActivityLine label={activityLabel} />
        ) : isFailed ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[13px] text-red-600">
            {hasContent
              ? props.message.content
              : "The agent failed to produce a response."}
          </div>
        ) : hasContent ? (
          <MarkdownBody value={props.message.content} />
        ) : (
          <div className="flex items-center gap-1.5 py-2 text-[var(--muted)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--muted)] [animation-delay:-200ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--muted)] [animation-delay:-100ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--muted)]" />
          </div>
        )}
      </div>
    </div>
  );
}

function Conversation(props: {
  conversation: AgentConversation;
  isResponding: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [props.conversation.messages, props.isResponding]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-4">
      <div className="mx-auto w-full max-w-3xl space-y-6 py-8">
        {props.conversation.messages.map((m) => (
          <MessageBubble key={m.messageId} message={m} />
        ))}
        {props.isResponding &&
        props.conversation.messages[props.conversation.messages.length - 1]
          ?.role === "user" ? (
          <MessageBubble
            message={{
              messageId: "thinking",
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export function AgentSearchScreen(props: AgentSearchScreenProps) {
  const [historyOpenMobile, setHistoryOpenMobile] = useState(false);

  const hasActive =
    props.activeConversation !== null &&
    props.activeConversation.messages.length > 0;

  const composer = (
    <Composer
      value={props.draft}
      onChange={props.onDraftChange}
      onSubmit={props.onSubmit}
      isResponding={props.isResponding}
      autoFocus={!hasActive}
      placeholder={
        hasActive ? "Reply to the agent…" : "Ask the agent anything…"
      }
    />
  );

  return (
    <div className="-mx-6 -my-10 flex h-[calc(100dvh-104px)] md:h-[100dvh]">
      {/* History rail (desktop) */}
      <aside className="hidden w-[280px] flex-shrink-0 border-r border-[color:var(--border)] bg-[var(--surface-2)]/40 px-3 py-6 backdrop-blur lg:block">
        <HistoryRail
          conversations={props.conversations}
          activeId={props.activeConversation?.conversationId ?? null}
          onSelect={props.onSelectConversation}
          onDelete={props.onDeleteConversation}
          onNewChat={props.onNewChat}
        />
      </aside>

      {/* Main column */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between border-b border-[color:var(--border)] bg-[var(--background)]/80 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setHistoryOpenMobile((v) => !v)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-black/[0.04] hover:text-[var(--foreground)] lg:hidden"
              title="History"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M4 6h16M4 12h16M4 18h10"
                />
              </svg>
            </button>
            <div className="min-w-0 truncate text-sm font-medium text-[var(--foreground)]">
              {hasActive
                ? props.activeConversation?.title || "Untitled chat"
                : "Agent Search"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={props.onNewChat}
              className="hidden items-center gap-1.5 rounded-full border border-[color:var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:bg-white hover:text-[var(--foreground)] sm:inline-flex"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              New chat
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="relative min-h-0 flex-1">
          {hasActive && props.activeConversation ? (
            <Conversation
              conversation={props.activeConversation}
              isResponding={props.isResponding}
            />
          ) : (
            <EmptyState
              greetingName={props.greetingName}
              examplePrompts={props.examplePrompts}
              onPick={(p) => {
                props.onDraftChange(p);
              }}
              composer={composer}
            />
          )}
        </div>

        {/* Sticky composer when active */}
        {hasActive ? (
          <div className="border-t border-[color:var(--border)] bg-gradient-to-b from-transparent to-[var(--background)] px-4 py-4 md:px-6">
            <div className="mx-auto w-full max-w-3xl">
              {composer}
              <div className="mt-2 text-center text-[11px] text-[var(--muted-2)]"></div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Mobile history drawer */}
      {historyOpenMobile ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setHistoryOpenMobile(false)}
          />
          <aside className="absolute left-0 top-0 h-full w-[300px] border-r border-[color:var(--border)] bg-[var(--background)] px-3 py-6 shadow-xl">
            <HistoryRail
              conversations={props.conversations}
              activeId={props.activeConversation?.conversationId ?? null}
              onSelect={(id) => {
                props.onSelectConversation(id);
                setHistoryOpenMobile(false);
              }}
              onDelete={props.onDeleteConversation}
              onNewChat={() => {
                props.onNewChat();
                setHistoryOpenMobile(false);
              }}
            />
          </aside>
        </div>
      ) : null}
    </div>
  );
}
