/**
 * Get entity types formatted for AI prompts.
 */
export function formatTypesForPrompt(
  types: Array<{ typeName: string; description: string }>,
): string {
  return types.map((t) => `- ${t.typeName}: ${t.description}`).join("\n");
}
