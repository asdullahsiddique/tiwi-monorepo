---
name: document-results-and-text
description: Use when the daemon needs to extract structured race result tables and narrative text from a PDF/image document. Converts PDF pages to images, dispatches parallel sub-agents per page range, then combines outputs into rounds.json and text.md.
---

# Document Results And Text Extraction Skill

## Agent invocation contract

The daemon invokes this skill from an isolated working directory. Assume these paths:

- `./source.pdf` - the source PDF to extract, when present.
- `./source.png`, `./source.jpg`, `./source.jpeg`, `./source.webp`, or `./source.gif` - image input, when present instead of a PDF.
- `./schema.md` - optional human-readable schema reference, if present.
- `./rounds.json` - the required structured output that this skill must write.
- `./text.md` - the required narrative markdown output that this skill must write.

Do not ask follow-up questions. When finished:

- `./rounds.json` must contain a strict JSON array of `RoundResult` objects and nothing else. Use `[]` if no result tables are present.
- `./text.md` must contain markdown text extracted from non-result-table content. Use an empty file if no narrative text is present.

## Overview

Convert a motorsport document into structured results and searchable narrative text by:

1. Splitting PDF input into individual page images with `pdftoppm`, or reading image input directly.
2. Inspecting pages to identify document structure and classify page content.
3. Dispatching parallel sub-agents; each reads a focused page range and writes JSON + markdown files.
4. Combining sub-agent JSON files into `./rounds.json` and markdown files into `./text.md`.

The structured output schema is `RoundResultSchema`, a discriminated union supporting both single-class F1-style events and multi-class Ferrari Challenge-style events.

---

## Step 1 - Prepare page images

First identify the source file:

```bash
ls ./source.*
```

If the source is an image (`source.png`, `source.jpg`, `source.jpeg`, `source.webp`, or `source.gif`), create a pages directory and copy it as page 1:

```bash
mkdir -p "./pages"
for src in ./source.*; do
  cp "$src" "./pages/page-1.png"
  break
done
```

Then skip to Step 2.

If the source is `./source.pdf`, check that `pdftoppm` is available:

```bash
which pdftoppm
```

Create an output directory and convert:

```bash
mkdir -p "./pages"
pdftoppm -png -r 150 "./source.pdf" "./pages/page"
# produces page-1.png, page-2.png, ... page-N.png
```

Use `-r 150` (150 DPI). Lower values (120) save memory but hurt accuracy on small text; higher values (200+) help if tables are very dense but slow sub-agents significantly.

After conversion, list the pages to confirm count:

```bash
ls "./pages/" | wc -l
```

---

## Step 2 - Scout pages to understand structure

Before dispatching all sub-agents, read the first 2-3 pages yourself with the Read tool (images are supported) to confirm:

- What series/championship is this?
- Single-class or multi-class?
- Column layout: does each spread have 2 or 4 category columns side by side?
- Which pages contain actual result tables?
- Which pages contain narrative text, article text, captions, reports, or other useful prose?
- Which pages are photo spreads, championship standings, entry lists, credits, ads, or blank pages?

Use this to plan page range assignments in Step 3.

Classify pages as:

- `result_table` - actual race result tables with positions/drivers/teams/times.
- `narrative` - prose, summaries, interviews, reports, captions, or other useful text that should be saved for search.
- `skip` - photo-only pages, chapter title pages with no useful text, championship standings, entry lists, credits, ads, or blank pages.

Some pages can be both `result_table` and `narrative`. In that case, extract the result table into JSON and save any surrounding non-table prose to markdown.

---

## Step 3 - Dispatch parallel sub-agents

Create an agent output directory:

```bash
mkdir -p "./agents"
```

Split pages into groups of 8-12 pages per agent. Fewer pages per agent = more accurate extraction because the agent stays focused. More pages = fewer API calls.

Good split for a 65-page almanacco:

- Agent 1: pages 4-13
- Agent 2: pages 14-24
- Agent 3: pages 25-36
- Agent 4: pages 37-48
- Agent 5: pages 49-65

Launch all agents in a single message using parallel sub-agent calls. Each sub-agent must write:

- `./agents/agent-<N>.rounds.json`
- `./agents/agent-<N>.text.md`

### Sub-agent prompt template

```text
You are a document extractor. Read each page image listed below carefully and extract:
1. structured race result tables into JSON
2. narrative/non-result-table text into markdown

Pages to process: ./pages/page-N.png through ./pages/page-M.png
Rounds output path: ./agents/agent-<N>.rounds.json
Text output path: ./agents/agent-<N>.text.md

Page handling rules:
- Actual race result tables (with Pos / Driver / Team / Time columns) go into the JSON output.
- On result-table pages, also preserve useful non-table context in markdown: round title, venue, dates, captions, and short surrounding prose.
- Narrative pages go into markdown. Preserve headings, paragraph order, bullet lists, and normal tables as GitHub-flavored markdown.
- SKIP photo-only pages, ads, credits, blank pages, entry lists, and championship points standings tables unless they contain useful narrative prose.
- If no race result tables are present in your page range, write [] to the rounds output.
- If no narrative text is present in your page range, write an empty text file.

For each round found, write a JSON object matching one of these structures:

For MULTI-CLASS events (Ferrari Challenge style):
{
  "type": "multi-class",
  "championship": "<series name>",
  "grandPrix": "<venue>",
  "circuit": "<circuit name>",
  "country": "<country or null>",
  "dateStart": "<YYYY-MM-DD or null>",
  "dateEnd": "<YYYY-MM-DD or null>",
  "round": <number or null>,
  "totalRounds": <number or null>,
  "categories": [
    {
      "name": "<TROFEO PIRELLI | TROFEO PIRELLI AM | COPPA SHELL | COPPA SHELL AM | TROFEO PIRELLI MID>",
      "races": [
        {
          "raceNumber": <1 or 2>,
          "polePosition": { "driver": "<name or null>", "team": "<name or null>", "time": "<time or null>" },
          "fastestLap": { "driver": "<name or null>", "team": "<name or null>", "time": "<time or null>" },
          "results": [
            { "position": <number or string or null>, "driver": "<name>", "team": "<name>", "car": null, "timeOrGap": "<time or null>", "points": null }
          ]
        }
      ]
    }
  ]
}

For SINGLE-CLASS events (F1 style):
{
  "type": "single",
  "grandPrix": "<race name>",
  "circuit": "<circuit name>",
  "country": "<country or null>",
  "dateStart": "<YYYY-MM-DD or null>",
  "dateEnd": "<YYYY-MM-DD or null>",
  "polePosition": { "driver": "<name or null>", "team": "<name or null>", "time": "<time or null>" },
  "fastestLap": { "driver": "<name or null>", "team": "<name or null>", "time": "<time or null>" },
  "results": [
    { "position": <number or null>, "driver": "<name>", "team": "<team>", "car": "<car or null>", "timeOrGap": "<time or null>", "points": <number or null> }
  ]
}

IMPORTANT accuracy rules:
- Read driver names and team names character by character; do not guess abbreviations.
- Time format: use dots for milliseconds (1:44.607), never colons (1:44:607).
- If a value is illegible, use null; do not invent data.
- Output one JSON object per round (not per race). A round contains all categories and races for that venue.
- Use null for unknown optional values; do not use em dashes or placeholder strings.
- If pole position or fastest lap is absent for a race, use "polePosition": null or "fastestLap": null.
- Write only a JSON array to the rounds output path: [ {...}, {...} ].
- Write only markdown text to the text output path. Do not include JSON in text.md.
- Do not add notes after the JSON. If you need to record skipped pages, create ./agents/agent-<N>-notes.txt separately.
```

---

## Step 4 - Collect sub-agent outputs

Each sub-agent writes a JSON array of round objects to `./agents/agent-<N>.rounds.json` and markdown to `./agents/agent-<N>.text.md`. After all agents complete:

1. Parse each `./agents/agent-*.rounds.json` file.
2. Concatenate into a single array.
3. Sort by: `championship` (or empty string), `round` (or 999), then `dateStart`.
4. Write the final JSON array to `./rounds.json`.
5. Concatenate `./agents/agent-*.text.md` in page order.
6. Write the final markdown to `./text.md`.

### Combining into final outputs

```python
import json, glob

results = []
for path in sorted(glob.glob("./agents/agent-*.rounds.json")):
    with open(path) as f:
        data = json.load(f)
        if not isinstance(data, list):
            raise ValueError(f"{path} did not contain a JSON array")
        results.extend(data)

results.sort(key=lambda r: (
    r.get("championship", r.get("grandPrix", "")),
    r.get("round") or 999,
    r.get("dateStart") or "",
))

with open("./rounds.json", "w") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

texts = []
for path in sorted(glob.glob("./agents/agent-*.text.md")):
    text = open(path).read().strip()
    if text:
        texts.append(text)

with open("./text.md", "w") as f:
    f.write("\n\n".join(texts).strip())
```

---

## Step 5 - Validate final output shape

Before stopping, ensure `./rounds.json` and `./text.md` exist. `rounds.json` must be valid JSON and a top-level array. Each item must match exactly one of the schemas below. `text.md` may be empty, but the file must exist.

Allowed `category.name` values:

- `TROFEO PIRELLI`
- `TROFEO PIRELLI AM`
- `COPPA SHELL`
- `COPPA SHELL AM`
- `TROFEO PIRELLI MID`

Optional fields may be `null` when absent or illegible. For `polePosition` and `fastestLap`, use either `null` when the whole fact is absent, or an object with nullable `driver`, `team`, and `time` fields when any detail is known.

Final check:

```bash
python -m json.tool ./rounds.json >/dev/null
test -f ./text.md
python - <<'PY'
import json
data = json.load(open("./rounds.json"))
assert isinstance(data, list), "rounds.json must be a JSON array"
for idx, item in enumerate(data):
    assert item.get("type") in ("single", "multi-class"), f"item {idx} missing valid type"
print(f"validated {len(data)} round(s)")
PY
```

If validation fails, fix the JSON before stopping.

---

## Known accuracy limitations

- Small text at 150 DPI: team names and lap times in tightly-set tables can be misread. Common errors: `Grid Fray Racing` instead of `Emil Frey Racing`, colons instead of dots in time strings (`1:44:607` should be `1:44.607`).
- Two-column spreads: many almanaccos print 2 rounds per physical page spread. Each sub-agent must be told to treat left and right halves as independent rounds.
- Overflow rows: when a driver's team name wraps to the next line in the PDF, the sub-agent may associate it with the wrong driver. If accuracy is critical, ask the sub-agent to cross-check row counts against the position numbers.
- Photo and standings pages: must be skipped unless they contain useful narrative text. Always sanity-check that the round count in the output matches the expected number of rounds for the series.

## Fallback: text extraction

If vision accuracy is insufficient, try `pdftotext -layout` first:

```bash
pdftotext -layout "./source.pdf" extracted_layout.txt
```

Then use the extracted layout as an additional reference when creating `text.md` or correcting table values. This is faster and more accurate for well-structured PDFs but fails on multi-column layouts where categories are printed side by side.
