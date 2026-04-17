"use client";

import { useState } from "react";

export type PromptPlacement = "prepend" | "append" | "post_process";

export type PromptListItem = {
  promptId: string;
  name: string;
  description: string | null;
  body: string;
  placement: PromptPlacement;
  updatedAt: string;
};

export type PromptDraft = {
  name: string;
  description: string;
  body: string;
  placement: PromptPlacement;
};

const EMPTY_DRAFT: PromptDraft = {
  name: "",
  description: "",
  body: "",
  placement: "prepend",
};

const PLACEMENT_LABELS: Record<PromptPlacement, string> = {
  prepend: "Prepend to system prompt",
  append: "Append to system prompt",
  post_process: "Post-process the answer",
};

const PLACEMENT_HINTS: Record<PromptPlacement, string> = {
  prepend:
    "Added before the default assistant instructions. Good for persona/context overrides.",
  append:
    "Added after the default assistant instructions. Good for extra rules or constraints.",
  post_process:
    "Runs as a second pass that rewrites the final answer. Good for format/tone transforms.",
};

export function PromptsScreen(props: {
  items: PromptListItem[];
  isLoading: boolean;
  error: string | null;
  isMutating: boolean;
  onCreate: (draft: PromptDraft) => Promise<void> | void;
  onUpdate: (promptId: string, draft: PromptDraft) => Promise<void> | void;
  onDelete: (promptId: string) => Promise<void> | void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(EMPTY_DRAFT);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function resetForm() {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setShowForm(false);
    setFormError(null);
  }

  function startEdit(item: PromptListItem) {
    setEditingId(item.promptId);
    setDraft({
      name: item.name,
      description: item.description ?? "",
      body: item.body,
      placement: item.placement,
    });
    setShowForm(true);
    setFormError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const trimmed: PromptDraft = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body.trim(),
    };
    if (!trimmed.name) return setFormError("Name is required.");
    if (!trimmed.body) return setFormError("Prompt body is required.");

    try {
      if (editingId) {
        await props.onUpdate(editingId, trimmed);
      } else {
        await props.onCreate(trimmed);
      }
      resetForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex items-end justify-between gap-6">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted-2)]">
            Intelligence
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Custom prompts
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
            Reusable instructions that you can attach to any research query.
            They run before, after, or on top of the default assistant.
          </p>
        </div>

        <button
          onClick={() => {
            if (showForm) {
              resetForm();
            } else {
              setDraft(EMPTY_DRAFT);
              setEditingId(null);
              setShowForm(true);
            }
          }}
          className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-black/10 hover:opacity-95"
        >
          {showForm ? "Close" : "New prompt"}
        </button>
      </div>

      {props.error ? (
        <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          {props.error}
        </div>
      ) : null}

      {showForm ? (
        <form
          onSubmit={handleSubmit}
          className="mt-6 rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur"
        >
          <div className="text-sm font-medium">
            {editingId ? "Edit prompt" : "New prompt"}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-[var(--muted-2)]">
                Name
              </span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Strict citations"
                className="h-10 rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 text-sm outline-none"
                maxLength={120}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-[var(--muted-2)]">
                Placement
              </span>
              <select
                value={draft.placement}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    placement: e.target.value as PromptPlacement,
                  })
                }
                className="h-10 rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 text-sm outline-none"
              >
                <option value="prepend">{PLACEMENT_LABELS.prepend}</option>
                <option value="append">{PLACEMENT_LABELS.append}</option>
                <option value="post_process">
                  {PLACEMENT_LABELS.post_process}
                </option>
              </select>
              <span className="text-xs text-[var(--muted-2)]">
                {PLACEMENT_HINTS[draft.placement]}
              </span>
            </label>
          </div>

          <label className="mt-4 flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--muted-2)]">
              Description (optional)
            </span>
            <input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="What is this prompt for?"
              className="h-10 rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 text-sm outline-none"
              maxLength={2000}
            />
          </label>

          <label className="mt-4 flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--muted-2)]">
              Prompt body
            </span>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="Write the instruction the model should follow..."
              rows={8}
              className="rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm outline-none"
              maxLength={20000}
            />
          </label>

          {formError ? (
            <div className="mt-3 text-sm text-red-600">{formError}</div>
          ) : null}

          <div className="mt-5 flex items-center gap-3">
            <button
              type="submit"
              disabled={props.isMutating}
              className="h-10 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-60"
            >
              {props.isMutating
                ? "Saving..."
                : editingId
                  ? "Save changes"
                  : "Create prompt"}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="h-10 rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-4 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="mt-8 rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-2 backdrop-blur">
        {props.isLoading ? (
          <div className="p-8 text-center text-sm text-[var(--muted)]">
            Loading prompts...
          </div>
        ) : props.items.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--muted)]">
            No prompts yet. Create your first one to customize research.
          </div>
        ) : (
          <ul className="divide-y divide-[color:var(--border)]">
            {props.items.map((p) => (
              <li
                key={p.promptId}
                className="flex items-start justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="rounded-full border border-[color:var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted-2)]">
                      {PLACEMENT_LABELS[p.placement]}
                    </span>
                  </div>
                  {p.description ? (
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      {p.description}
                    </div>
                  ) : null}
                  <div className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-[var(--muted-2)]">
                    {p.body}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => startEdit(p)}
                    className="rounded-lg border border-[color:var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete prompt "${p.name}"?`)) {
                        void props.onDelete(p.promptId);
                      }
                    }}
                    disabled={props.isMutating}
                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/20 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
