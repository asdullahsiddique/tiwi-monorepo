# `@tiwi/langgraph`

This package contains the **agent orchestration layer** responsible for converting extracted media artifacts into a structured, evolving Neo4j knowledge graph.

## v1 scope
- File enrichment orchestration spec lives in `specs/file-enrichment.md`.
- The implementation returns structured entities/relationships and decision logs.\n+- Persistence is handled by the caller (daemon) to preserve strict layering and observability.

## Logging requirement
Every AI call should be recorded with:\n+- model\n+- input/output tokens\n+- total tokens\n+- cost estimate\n+- timestamp\n+- orgId\n+- fileId (if applicable)

