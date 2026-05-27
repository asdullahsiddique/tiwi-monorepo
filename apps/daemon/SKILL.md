---
name: pdf-race-results
description: Use when the user wants to extract race result tables from a PDF almanacco or results book. Converts PDF pages to images, dispatches parallel sub-agents per page range to read tables visually, then combines all outputs into a single structured JSON or markdown file following the RoundResultSchema.
---

# PDF Race Results Extraction Skill

## Agent invocation contract

The daemon invokes this skill from an isolated working directory. Assume these
paths:

- `./source.pdf` — the source PDF to extract.
- `./schema.md` — optional human-readable schema reference, if present.
- `./rounds.json` — the required final output that this skill must write.

Do not ask follow-up questions. Do not write markdown as the final result. When
finished, `./rounds.json` must contain a strict JSON array of `RoundResult`
objects and nothing else.

## Overview

Convert a motorsport results PDF into structured data by:

1. Splitting the PDF into individual page images with `pdftoppm`.
2. Inspecting the first result pages to identify the document structure.
3. Dispatching parallel sub-agents; each reads a focused page range and writes
   a JSON file.
4. Combining all sub-agent JSON files into `./rounds.json`.

The output schema is `RoundResultSchema`, a discriminated union supporting both
single-class F1-style events and multi-class Ferrari Challenge-style events.

---

## Step 1 — Convert PDF to images

Check that `pdftoppm` is available:

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

## Step 2 — Scout page 1–3 to understand structure

Before dispatching all sub-agents, read the first 2–3 result pages yourself with the Read tool (images are supported) to confirm:
- What series/championship is this?
- Single-class or multi-class?
- Column layout: does each spread have 2 or 4 category columns side by side?
- Which pages are photo spreads, championship standings, or entry lists (not result tables)?

Use this to plan page range assignments in Step 3.

---

## Step 3 — Dispatch parallel sub-agents

Create an agent output directory:

```bash
mkdir -p "./agents"
```

Split pages into groups of 8–12 pages per agent. Fewer pages per agent = more
accurate extraction because the agent stays focused. More pages = fewer API
calls.

**Good split for a 65-page almanacco:**
- Agent 1: pages 4–13
- Agent 2: pages 14–24
- Agent 3: pages 25–36
- Agent 4: pages 37–48
- Agent 5: pages 49–65

Launch all agents **in a single message** using parallel sub-agent calls. Each
sub-agent must write one JSON file named `./agents/agent-<N>.json`.

### Sub-agent prompt template

```
You are a race results extractor. Read each page image listed below carefully and extract all race result tables you find.

Pages to process: ./pages/page-N.png through ./pages/page-M.png
Output path: ./agents/agent-<N>.json

SKIP pages that are: photo spreads, chapter title pages, championship points standings tables, entry lists, or credits pages. Only extract actual race result tables (with Pos / Driver / Team / Time columns).

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
    { "position": <number or null>, "driver": "<name>", "team": "<name>", "car": "<car or null>", "timeOrGap": "<time or null>", "points": <number or null> }
  ]
}

IMPORTANT accuracy rules:
- Read driver names and team names character by character — do not guess abbreviations
- Time format: use dots for milliseconds (1:44.607), never colons (1:44:607)
- If a value is illegible, use null — do not invent data
- Output one JSON object per round (not per race). A round contains all categories and races for that venue.
- Use null for unknown optional values; do not use em dashes or placeholder strings.
- If pole position or fastest lap is absent for a race, use `"polePosition": null` or `"fastestLap": null`.
- Write only a JSON array to the output path: [ {...}, {...} ]
- Do not add notes after the JSON. If you need to record skipped pages, create ./agents/agent-<N>-notes.txt separately.
```

---

## Step 4 — Collect sub-agent outputs

Each sub-agent writes a JSON array of round objects to `./agents/agent-<N>.json`.
After all agents complete:

1. Parse each `./agents/agent-*.json` file.
2. Concatenate into a single array.
3. Sort by: `championship` (or empty string), `round` (or 999), then `dateStart`.
4. Write the final JSON array to `./rounds.json`.

### Combining into `rounds.json`

```python
import json, glob, re

results = []
for path in sorted(glob.glob("./agents/agent-*.json")):
    if path.endswith("-notes.txt"):
        continue
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
```

---

## Step 5 — Validate final output shape

Before stopping, ensure `./rounds.json` exists and is valid JSON. It must be a
top-level array. Each item must match exactly one of the schemas below.

### Single-class round

```json
{
  "type": "single",
  "grandPrix": "Australian Grand Prix",
  "circuit": "Albert Park Circuit",
  "country": "Australia",
  "dateStart": "2025-03-14",
  "dateEnd": "2025-03-16",
  "polePosition": { "driver": "L. Norris", "team": "McLaren", "time": "1:15.096" },
  "fastestLap": { "driver": "L. Norris", "team": "McLaren", "time": "1:22.167" },
  "results": [
    { "position": 1, "driver": "L. Norris", "team": "McLaren", "car": "MCL39-Mercedes", "timeOrGap": "1:42:06.304", "points": 25 }
  ]
}
```

### Multi-class round

```json
{
  "type": "multi-class",
  "championship": "Ferrari Challenge Europe",
  "grandPrix": "Monza",
  "circuit": "Autodromo Nazionale Monza",
  "country": "Italy",
  "dateStart": "2025-03-27",
  "dateEnd": "2025-03-30",
  "round": 1,
  "totalRounds": 8,
  "categories": [
    {
      "name": "TROFEO PIRELLI",
      "races": [
        {
          "raceNumber": 1,
          "polePosition": { "driver": "Hauger", "team": "Ineos - Reparto Corse RAW", "time": "1:44.607" },
          "fastestLap": { "driver": "Hauger", "team": "Ineos - Reparto Corse RAW", "time": "1:44.607" },
          "results": [
            { "position": 1, "driver": "Calautti", "team": "Rossocorsa", "car": null, "timeOrGap": null, "points": null }
          ]
        }
      ]
    }
  ]
}
```

Allowed `category.name` values:

- `TROFEO PIRELLI`
- `TROFEO PIRELLI AM`
- `COPPA SHELL`
- `COPPA SHELL AM`
- `TROFEO PIRELLI MID`

Optional fields may be `null` when absent or illegible. For `polePosition` and
`fastestLap`, use either `null` when the whole fact is absent, or an object with
nullable `driver`, `team`, and `time` fields when any detail is known.

Final check:

```bash
python -m json.tool ./rounds.json >/dev/null
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

- **Small text at 150 DPI**: team names and lap times in tightly-set tables can be misread. Common errors: `Grid Fray Racing` instead of `Emil Frey Racing`, colons instead of dots in time strings (`1:44:607` → should be `1:44.607`).
- **Two-column spreads**: many almanaccos print 2 rounds per physical page spread. Each sub-agent must be told to treat left and right halves as independent rounds.
- **Overflow rows**: when a driver's team name wraps to the next line in the PDF, the sub-agent may associate it with the wrong driver. If accuracy is critical, ask the sub-agent to cross-check row counts against the position numbers.
- **Photo and standings pages**: must be skipped. The sub-agent prompt tells agents to skip them, but always sanity-check that the round count in the output matches the expected number of rounds for the series.

## Fallback: text extraction

If vision accuracy is insufficient, try `pdftotext -layout` first:

```bash
pdftotext -layout "<pdf_path>" extracted_layout.txt
```

Then use a Python parser to extract tables from the fixed-width columns. This is faster and more accurate for well-structured PDFs but fails on multi-column layouts where categories are printed side by side.
