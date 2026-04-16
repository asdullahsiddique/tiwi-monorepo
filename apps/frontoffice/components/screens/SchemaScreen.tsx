"use client";

import { useState } from "react";
import type { TypeRegistryRecord } from "@tiwi/mongodb";

type SchemaScreenProps = {
  types: TypeRegistryRecord[];
  isLoading: boolean;
  onCreate: (data: { typeName: string; description: string; properties: string[] }) => void;
  onUpdate: (typeName: string, data: { description?: string; properties?: string[] }) => void;
  onDelete: (typeName: string) => void;
  onConfirm: (typeName: string) => void;
  onDismiss: (typeName: string) => void;
  isPending: boolean;
};

type AddTypeFormData = {
  typeName: string;
  description: string;
  propertiesRaw: string;
};

const emptyForm: AddTypeFormData = { typeName: "", description: "", propertiesRaw: "" };

function parseProperties(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function PropertyChips({ properties }: { properties: string[] }) {
  if (properties.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {properties.map((p) => (
        <span
          key={p}
          className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted)]"
        >
          {p}
        </span>
      ))}
    </div>
  );
}

function TypeForm(props: {
  initial?: AddTypeFormData;
  isNew?: boolean;
  isPending: boolean;
  onSubmit: (data: AddTypeFormData) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<AddTypeFormData>(props.initial ?? emptyForm);

  return (
    <div className="rounded-xl border border-[color:var(--border)] bg-[var(--surface-2)] p-4">
      <div className="space-y-3">
        {props.isNew && (
          <div>
            <label className="block text-xs font-medium text-[var(--muted)] mb-1">Type name</label>
            <input
              type="text"
              placeholder="e.g. Investor"
              value={form.typeName}
              onChange={(e) => setForm({ ...form, typeName: e.target.value })}
              className="w-full rounded-lg border border-[color:var(--border)] bg-[var(--background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
            />
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-[var(--muted)] mb-1">Description</label>
          <input
            type="text"
            placeholder="What this type represents"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full rounded-lg border border-[color:var(--border)] bg-[var(--background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--muted)] mb-1">
            Expected properties <span className="text-[var(--muted-2)]">(comma-separated)</span>
          </label>
          <input
            type="text"
            placeholder="e.g. name, fund, amount"
            value={form.propertiesRaw}
            onChange={(e) => setForm({ ...form, propertiesRaw: e.target.value })}
            className="w-full rounded-lg border border-[color:var(--border)] bg-[var(--background)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40"
          />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => props.onSubmit(form)}
            disabled={props.isPending || !form.description.trim() || (props.isNew && !form.typeName.trim())}
            className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {props.isPending ? "Saving…" : props.isNew ? "Add Type" : "Save"}
          </button>
          <button
            onClick={props.onCancel}
            className="rounded-full border border-[color:var(--border)] bg-[var(--surface-3)] px-4 py-1.5 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function SchemaScreen(props: SchemaScreenProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTypeName, setEditingTypeName] = useState<string | null>(null);

  const drafts = props.types.filter((t) => t.status === "draft");
  const active = props.types.filter((t) => t.status === "active");

  const handleCreate = (form: AddTypeFormData) => {
    props.onCreate({
      typeName: form.typeName.trim(),
      description: form.description.trim(),
      properties: parseProperties(form.propertiesRaw),
    });
    setShowAddForm(false);
  };

  const handleUpdate = (typeName: string, form: AddTypeFormData) => {
    props.onUpdate(typeName, {
      description: form.description.trim(),
      properties: parseProperties(form.propertiesRaw),
    });
    setEditingTypeName(null);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted-2)]">Intelligence</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Schema</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Define entity types for AI extraction. Active types are used in the extraction prompt; draft
          types are AI-discovered and await your review.
        </p>
      </div>

      {/* Draft Types */}
      <section className="mb-8 rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
        <div className="flex items-center gap-2 mb-4">
          <div className="text-sm font-medium">Draft Types</div>
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600">
            {drafts.length}
          </span>
        </div>

        {props.isLoading ? (
          <div className="space-y-2">
            <div className="h-14 animate-pulse rounded-xl bg-[var(--muted-2)]/10" />
            <div className="h-14 animate-pulse rounded-xl bg-[var(--muted-2)]/10" />
          </div>
        ) : drafts.length === 0 ? (
          <div className="text-sm text-[var(--muted)]">No draft types pending review.</div>
        ) : (
          <div className="space-y-2">
            {drafts.map((t) => (
              <div
                key={t.typeName}
                className="rounded-xl border border-dashed border-amber-300 bg-amber-50/40 px-4 py-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--foreground)]">{t.typeName}</span>
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600">
                        AI draft
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--muted)]">{t.description}</div>
                    <PropertyChips properties={t.properties} />
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => props.onConfirm(t.typeName)}
                      disabled={props.isPending}
                      className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/25 disabled:opacity-40"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => props.onDismiss(t.typeName)}
                      disabled={props.isPending}
                      className="rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-500/20 disabled:opacity-40"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Active Schema */}
      <section className="rounded-2xl border border-[color:var(--border)] bg-[var(--surface)] p-6 backdrop-blur">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium">Active Schema</div>
          {!showAddForm && (
            <button
              onClick={() => setShowAddForm(true)}
              className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              + Add Type
            </button>
          )}
        </div>

        {showAddForm && (
          <div className="mb-4">
            <TypeForm
              isNew
              isPending={props.isPending}
              onSubmit={handleCreate}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        )}

        {props.isLoading ? (
          <div className="space-y-2">
            <div className="h-14 animate-pulse rounded-xl bg-[var(--muted-2)]/10" />
            <div className="h-14 animate-pulse rounded-xl bg-[var(--muted-2)]/10" />
            <div className="h-14 animate-pulse rounded-xl bg-[var(--muted-2)]/10" />
          </div>
        ) : active.length === 0 && !showAddForm ? (
          <div className="text-sm text-[var(--muted)]">
            No active types yet. Add your first type to enable schema-driven extraction.
          </div>
        ) : (
          <div className="space-y-2">
            {active.map((t) => (
              <div key={t.typeName}>
                {editingTypeName === t.typeName ? (
                  <TypeForm
                    initial={{
                      typeName: t.typeName,
                      description: t.description,
                      propertiesRaw: t.properties.join(", "),
                    }}
                    isPending={props.isPending}
                    onSubmit={(form) => handleUpdate(t.typeName, form)}
                    onCancel={() => setEditingTypeName(null)}
                  />
                ) : (
                  <div className="rounded-xl border border-[color:var(--border)] bg-[var(--surface-2)] px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--foreground)]">{t.typeName}</div>
                        <div className="mt-0.5 text-xs text-[var(--muted)]">{t.description}</div>
                        <PropertyChips properties={t.properties} />
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => setEditingTypeName(t.typeName)}
                          className="rounded-full border border-[color:var(--border)] bg-[var(--surface-3)] px-3 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)]"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => props.onDelete(t.typeName)}
                          disabled={props.isPending}
                          className="rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-500/20 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
