"use client";

import { useState } from "react";
import { api } from "@/lib/trpc";
import { SearchScreen } from "@/components/screens/SearchScreen";

export default function SearchClient() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);

  const search = api.search.semantic.useQuery(
    { query: submitted ?? "" },
    { enabled: Boolean(submitted && submitted.trim().length > 0) },
  );

  return (
    <SearchScreen
      query={query}
      isSearching={search.isFetching}
      answer={(search.data as any)?.answer ?? null}
      citations={(search.data as any)?.citations ?? []}
      error={search.error?.message ?? null}
      onQueryChange={setQuery}
      onSearch={() => setSubmitted(query)}
    />
  );
}

