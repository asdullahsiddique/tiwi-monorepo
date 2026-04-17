export type ParsedTable = {
  headers: string[];
  rows: string[][];
};

/**
 * Parses GitHub-flavoured markdown tables from extracted document text.
 * Used by result-tier extractors (race results, pit stops) because those are
 * the dominant structured data sources in F1 documents.
 */
export function parseMarkdownTables(text: string): ParsedTable[] {
  // Header row | separator (---) | 1+ data rows
  const re = /^\|(.+)\|\s*\n\|[-:\s|]+\|\s*\n((?:\|.+\|\s*\n?)+)/gm;
  const tables: ParsedTable[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const headers = m[1]!
      .split("|")
      .map((h) => h.trim())
      .filter(Boolean);
    const rows = m[2]!
      .trim()
      .split("\n")
      .map((r) =>
        r
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean),
      );
    // Only keep tables with ≥2 cols, ≥1 row, ≤100 rows
    if (headers.length >= 2 && rows.length >= 1 && rows.length <= 100) {
      tables.push({ headers, rows });
    }
  }
  return tables.slice(0, 15); // cap per document
}

/**
 * Render a parsed table back to plain markdown so it can be appended to an
 * extraction prompt without losing structure.
 */
export function renderTable(table: ParsedTable): string {
  const head = `| ${table.headers.join(" | ")} |`;
  const sep = `|${table.headers.map(() => " --- ").join("|")}|`;
  const body = table.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
}
