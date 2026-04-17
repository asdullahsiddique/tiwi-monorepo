"use client";

import { api } from "@/lib/trpc";
import {
  PromptsScreen,
  type PromptDraft,
  type PromptListItem,
  type PromptPlacement,
} from "@/components/screens/PromptsScreen";

export default function PromptsClient() {
  const utils = api.useUtils();
  const listQuery = api.prompts.list.useQuery();

  const invalidate = () => {
    void utils.prompts.list.invalidate();
  };

  const createMutation = api.prompts.create.useMutation({ onSuccess: invalidate });
  const updateMutation = api.prompts.update.useMutation({ onSuccess: invalidate });
  const deleteMutation = api.prompts.delete.useMutation({ onSuccess: invalidate });

  const items: PromptListItem[] = (listQuery.data?.items ?? []).map((p) => ({
    promptId: p.promptId,
    name: p.name,
    description: p.description,
    body: p.body,
    placement: p.placement as PromptPlacement,
    updatedAt: p.updatedAt,
  }));

  const isMutating =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending;

  const error =
    listQuery.error?.message ??
    createMutation.error?.message ??
    updateMutation.error?.message ??
    deleteMutation.error?.message ??
    null;

  return (
    <PromptsScreen
      items={items}
      isLoading={listQuery.isLoading}
      isMutating={isMutating}
      error={error}
      onCreate={async (draft: PromptDraft) => {
        await createMutation.mutateAsync({
          name: draft.name,
          description: draft.description || undefined,
          body: draft.body,
          placement: draft.placement,
        });
      }}
      onUpdate={async (promptId, draft) => {
        await updateMutation.mutateAsync({
          promptId,
          name: draft.name,
          description: draft.description || null,
          body: draft.body,
          placement: draft.placement,
        });
      }}
      onDelete={async (promptId) => {
        await deleteMutation.mutateAsync({ promptId });
      }}
    />
  );
}
