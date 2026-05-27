"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/lib/trpc";
import {
  AgentSearchScreen,
  type AgentChatMessage,
  type AgentConversation,
} from "@/components/screens/AgentSearchScreen";

const STORAGE_KEY = "tiwi.agentSearch.conversations.v1";

const EXAMPLE_PROMPTS = [
  "Riassumi la stagione FIA WEC 2025 di Ferrari",
  "Chi ha vinto la Qualifying Race a Macao?",
  "Cosa hanno detto i piloti dopo la 3 Ore del Nürburgring?",
  "Quanti titoli Endurance ha conquistato Ferrari nel 2025?",
];

const POLL_INTERVAL_MS = 1_500;
const MAX_HISTORY_TURNS_SENT = 12;

function uid(prefix: string): string {
  const cryptoRef =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as Crypto | undefined)
      : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return `${prefix}_${cryptoRef.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 48) return cleaned || "Untitled chat";
  return `${cleaned.slice(0, 48).trimEnd()}…`;
}

function loadConversations(): AgentConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AgentConversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is AgentConversation =>
        !!c &&
        typeof c.conversationId === "string" &&
        Array.isArray(c.messages),
    );
  } catch {
    return [];
  }
}

function saveConversations(items: AgentConversation[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore quota / private-mode errors
  }
}

function sortByRecency(conversations: AgentConversation[]): AgentConversation[] {
  return [...conversations].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

/**
 * Build the agent history payload from prior messages. We only forward
 * completed assistant messages and user messages — placeholder/failed
 * assistant messages are filtered so the agent doesn't see partial state.
 */
function buildHistoryPayload(
  messages: AgentChatMessage[],
): { role: "user" | "assistant"; content: string }[] {
  const usable = messages
    .filter((m) => {
      if (m.role === "user") return m.content.trim().length > 0;
      // Only include completed assistant replies as context.
      return (
        (m.status === undefined || m.status === "completed") &&
        m.content.trim().length > 0
      );
    })
    .map((m) => ({ role: m.role, content: m.content }));
  // Cap history to keep the prompt size reasonable.
  return usable.slice(-MAX_HISTORY_TURNS_SENT);
}

export default function AgentSearchClient() {
  const { user } = useUser();

  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);

  /**
   * The job currently being polled. We poll only one job at a time — the
   * latest one the user submitted — because the UI also locks the composer
   * while a reply is in flight.
   */
  const [activeJob, setActiveJob] = useState<{
    jobId: string;
    conversationId: string;
    placeholderMessageId: string;
  } | null>(null);

  useEffect(() => {
    const loaded = sortByRecency(loadConversations());
    setConversations(loaded);
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    saveConversations(conversations);
  }, [conversations, isHydrated]);

  const activeConversation = useMemo<AgentConversation | null>(() => {
    if (!activeId) return null;
    return conversations.find((c) => c.conversationId === activeId) ?? null;
  }, [conversations, activeId]);

  const updateConversation = useCallback(
    (
      conversationId: string,
      updater: (prev: AgentConversation) => AgentConversation,
    ) => {
      setConversations((prev) =>
        sortByRecency(
          prev.map((c) =>
            c.conversationId === conversationId ? updater(c) : c,
          ),
        ),
      );
    },
    [],
  );

  const updateAssistantMessage = useCallback(
    (
      conversationId: string,
      messageId: string,
      patch: Partial<AgentChatMessage>,
    ) => {
      updateConversation(conversationId, (prev) => ({
        ...prev,
        messages: prev.messages.map((m) =>
          m.messageId === messageId ? { ...m, ...patch } : m,
        ),
        updatedAt: new Date().toISOString(),
      }));
    },
    [updateConversation],
  );

  const submitMutation = api.agent.submitQuery.useMutation();

  // Poll the active job for status / live activity / final markdown.
  // refetchInterval returns false once the status is terminal, which stops
  // polling without re-renders piling up.
  const statusQuery = api.agent.getQueryStatus.useQuery(
    { jobId: activeJob?.jobId ?? "" },
    {
      enabled: Boolean(activeJob?.jobId),
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data) return POLL_INTERVAL_MS;
        if (data.status === "completed" || data.status === "failed") {
          return false;
        }
        return POLL_INTERVAL_MS;
      },
      refetchIntervalInBackground: true,
      // Don't keep stale results across job switches.
      gcTime: 0,
    },
  );

  // Mirror poll results into the corresponding assistant placeholder message.
  useEffect(() => {
    if (!activeJob) return;
    const data = statusQuery.data;
    if (!data) return;

    if (data.status === "running" || data.status === "queued") {
      updateAssistantMessage(
        activeJob.conversationId,
        activeJob.placeholderMessageId,
        {
          status: "running",
          currentActivity:
            data.latestActivity?.message ?? "Thinking...",
        },
      );
      return;
    }
    if (data.status === "completed") {
      updateAssistantMessage(
        activeJob.conversationId,
        activeJob.placeholderMessageId,
        {
          status: "completed",
          currentActivity: undefined,
          content:
            data.responseMarkdown?.trim() ||
            "The agent returned an empty response.",
        },
      );
      setActiveJob(null);
      return;
    }
    if (data.status === "failed") {
      updateAssistantMessage(
        activeJob.conversationId,
        activeJob.placeholderMessageId,
        {
          status: "failed",
          currentActivity: undefined,
          content:
            data.failureReason ||
            "The agent failed to produce a response. Please try again.",
        },
      );
      setActiveJob(null);
    }
  }, [statusQuery.data, activeJob, updateAssistantMessage]);

  const isResponding = activeJob !== null || submitMutation.isPending;

  // Keep a stable ref to the latest active conversation id used by the
  // in-flight reply resolver below.
  const replyOwnerRef = useRef<string | null>(null);

  const handleSubmit = useCallback(() => {
    const content = draft.trim();
    if (!content || isResponding) return;

    const now = new Date().toISOString();
    const userMessage: AgentChatMessage = {
      messageId: uid("msg"),
      role: "user",
      content,
      createdAt: now,
    };
    const assistantPlaceholder: AgentChatMessage = {
      messageId: uid("msg"),
      role: "assistant",
      content: "",
      createdAt: now,
      status: "running",
      currentActivity: "Thinking...",
    };

    let targetConversation: AgentConversation;
    let history: AgentChatMessage[];

    if (activeConversation) {
      targetConversation = {
        ...activeConversation,
        messages: [
          ...activeConversation.messages,
          userMessage,
          assistantPlaceholder,
        ],
        updatedAt: now,
      };
      history = activeConversation.messages;
      setConversations((prev) =>
        sortByRecency(
          prev.map((c) =>
            c.conversationId === targetConversation.conversationId
              ? targetConversation
              : c,
          ),
        ),
      );
    } else {
      targetConversation = {
        conversationId: uid("conv"),
        title: deriveTitle(content),
        messages: [userMessage, assistantPlaceholder],
        createdAt: now,
        updatedAt: now,
      };
      history = [];
      setConversations((prev) => sortByRecency([targetConversation, ...prev]));
      setActiveId(targetConversation.conversationId);
    }

    setDraft("");
    replyOwnerRef.current = targetConversation.conversationId;

    const historyPayload = buildHistoryPayload(history);

    submitMutation.mutate(
      {
        conversationId: targetConversation.conversationId,
        prompt: content,
        history: historyPayload,
      },
      {
        onSuccess: ({ jobId }) => {
          setActiveJob({
            jobId,
            conversationId: targetConversation.conversationId,
            placeholderMessageId: assistantPlaceholder.messageId,
          });
        },
        onError: (err) => {
          updateAssistantMessage(
            targetConversation.conversationId,
            assistantPlaceholder.messageId,
            {
              status: "failed",
              currentActivity: undefined,
              content: `Failed to submit query: ${err.message}`,
            },
          );
        },
      },
    );
  }, [
    activeConversation,
    draft,
    isResponding,
    submitMutation,
    updateAssistantMessage,
  ]);

  const handleNewChat = useCallback(() => {
    setActiveId(null);
    setDraft("");
  }, []);

  const handleSelectConversation = useCallback((conversationId: string) => {
    setActiveId(conversationId);
    setDraft("");
  }, []);

  const handleDeleteConversation = useCallback(
    (conversationId: string) => {
      setConversations((prev) =>
        prev.filter((c) => c.conversationId !== conversationId),
      );
      setActiveId((current) => (current === conversationId ? null : current));
      // If the active job belonged to that conversation, drop it.
      setActiveJob((current) =>
        current && current.conversationId === conversationId ? null : current,
      );
    },
    [],
  );

  const greetingName =
    user?.firstName ?? user?.username ?? user?.fullName ?? null;

  return (
    <AgentSearchScreen
      conversations={conversations}
      activeConversation={activeConversation}
      isResponding={isResponding}
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={handleSubmit}
      onNewChat={handleNewChat}
      onSelectConversation={handleSelectConversation}
      onDeleteConversation={handleDeleteConversation}
      greetingName={greetingName}
      examplePrompts={EXAMPLE_PROMPTS}
    />
  );
}
