"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/trpc";
import {
  SearchScreen,
  type SearchPromptOption,
} from "@/components/screens/SearchScreen";

export default function SearchClient() {
  const [query, setQuery] = useState("");
  const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);

  const utils = api.useUtils();

  const searchMutation = api.search.semantic.useMutation({
    onSuccess: () => {
      utils.search.history.invalidate();
    },
  });

  const historyQuery = api.search.history.useQuery();
  const promptsQuery = api.prompts.list.useQuery();

  const deleteMutation = api.search.deleteSearch.useMutation({
    onSuccess: () => {
      utils.search.history.invalidate();
    },
  });

  const clearMutation = api.search.clearHistory.useMutation({
    onSuccess: () => {
      utils.search.history.invalidate();
    },
  });

  const availablePrompts: SearchPromptOption[] = useMemo(
    () =>
      (promptsQuery.data?.items ?? []).map((p) => ({
        promptId: p.promptId,
        name: p.name,
        placement: p.placement as SearchPromptOption["placement"],
      })),
    [promptsQuery.data],
  );

  const handleSearch = () => {
    if (query.trim()) {
      searchMutation.mutate({
        query,
        promptIds: selectedPromptIds.length > 0 ? selectedPromptIds : undefined,
      });
    }
  };

  const handleSelectFromHistory = (historicQuery: string) => {
    setQuery(historicQuery);
    searchMutation.mutate({
      query: historicQuery,
      promptIds: selectedPromptIds.length > 0 ? selectedPromptIds : undefined,
    });
  };

  const handleTogglePrompt = (promptId: string) => {
    setSelectedPromptIds((prev) =>
      prev.includes(promptId)
        ? prev.filter((id) => id !== promptId)
        : [...prev, promptId],
    );
  };

  return (
    <SearchScreen
      query={query}
      isSearching={searchMutation.isPending}
      answer={searchMutation.data?.answer ?? null}
      citations={searchMutation.data?.citations ?? []}
      error={searchMutation.error?.message ?? null}
      onQueryChange={setQuery}
      onSearch={handleSearch}
      history={historyQuery.data ?? []}
      isLoadingHistory={historyQuery.isLoading}
      onSelectHistory={handleSelectFromHistory}
      onDeleteHistory={(searchId) => deleteMutation.mutate({ searchId })}
      onClearHistory={() => clearMutation.mutate()}
      isDeletingHistory={deleteMutation.isPending}
      availablePrompts={availablePrompts}
      selectedPromptIds={selectedPromptIds}
      onTogglePrompt={handleTogglePrompt}
    />
  );
}
