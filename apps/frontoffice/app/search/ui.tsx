"use client";

import { useState } from "react";
import { api } from "@/lib/trpc";
import { SearchScreen } from "@/components/screens/SearchScreen";

export default function SearchClient() {
  const [query, setQuery] = useState("");

  const utils = api.useUtils();

  // Search mutation (saves to history)
  const searchMutation = api.search.semantic.useMutation({
    onSuccess: () => {
      // Refetch history after new search
      utils.search.history.invalidate();
    },
  });

  // Search history
  const historyQuery = api.search.history.useQuery();

  // Delete search mutation
  const deleteMutation = api.search.deleteSearch.useMutation({
    onSuccess: () => {
      utils.search.history.invalidate();
    },
  });

  // Clear all history mutation
  const clearMutation = api.search.clearHistory.useMutation({
    onSuccess: () => {
      utils.search.history.invalidate();
    },
  });

  const handleSearch = () => {
    if (query.trim()) {
      searchMutation.mutate({ query });
    }
  };

  const handleSelectFromHistory = (historicQuery: string) => {
    setQuery(historicQuery);
    searchMutation.mutate({ query: historicQuery });
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
    />
  );
}

