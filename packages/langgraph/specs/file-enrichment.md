---
title: File Enrichment Graph (v1)
owner: packages/langgraph
---

## Goal
Transform extracted file text into **structured entities + relationships** and evolve the org-scoped type registry without uncontrolled ontology sprawl.

## Inputs
- `orgId`
- `userId`
- `fileId`
- `text` (normalized extraction result)

## Outputs
- `entities[]`: `{ typeName, name, properties }`
- `relationships[]`: `{ from, to, relationshipType, properties }`
- `createdTypes[]`: new types inserted into Type Registry (with description, createdBy, timestamp)
- `decisionLog[]`: why a type was used/created; why an edge was created
- `aiUsageLog[]`: model, tokens in/out, cost estimate, timestamps

## Constraints
- Always check Type Registry before creating a type.
- If creating a type: include `typeName`, `description`, `createdBy`, `timestamp`.
- Log decisions for transparency.

## High-level graph steps
1. `ResolveOrCreateTypes`\n+   - suggest types required for this file\n+   - create only when necessary\n+2. `ExtractEntities`\n+   - extract entity instances, mapped to types\n+3. `ExtractRelationships`\n+   - infer relationships between extracted entities\n+4. `ReturnStructuredGraph`\n+   - return structured results + logs for persistence

