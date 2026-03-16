"use client";

import { api } from "@/lib/trpc";
import { SchemaScreen } from "@/components/screens/SchemaScreen";

export default function SchemaClient() {
  const utils = api.useUtils();

  const typesQuery = api.schema.listTypes.useQuery();

  const invalidate = () => utils.schema.listTypes.invalidate();

  const createMutation = api.schema.createType.useMutation({ onSuccess: invalidate });
  const updateMutation = api.schema.updateType.useMutation({ onSuccess: invalidate });
  const deleteMutation = api.schema.deleteType.useMutation({ onSuccess: invalidate });
  const confirmMutation = api.schema.confirmDraftType.useMutation({ onSuccess: invalidate });
  const dismissMutation = api.schema.dismissDraftType.useMutation({ onSuccess: invalidate });

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    confirmMutation.isPending ||
    dismissMutation.isPending;

  return (
    <SchemaScreen
      types={typesQuery.data?.types ?? []}
      isLoading={typesQuery.isLoading}
      onCreate={(data) => createMutation.mutate(data)}
      onUpdate={(typeName, data) => updateMutation.mutate({ typeName, ...data })}
      onDelete={(typeName) => deleteMutation.mutate({ typeName })}
      onConfirm={(typeName) => confirmMutation.mutate({ typeName })}
      onDismiss={(typeName) => dismissMutation.mutate({ typeName })}
      isPending={isPending}
    />
  );
}
