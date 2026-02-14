# Media Intelligence Platform -- Agent Context & Architectural Rationale

**Companion Document to Technical Specification v1**\
**Generated:** 2026-02-14T12:04:19.730422 UTC

------------------------------------------------------------------------

# 1. Purpose of This Document

This document explains the reasoning, philosophy, architectural
decisions, and behavioral expectations behind the Media Intelligence
Platform.

It is meant to guide an implementation agent or engineering team in
understanding not just *what* to build, but *why* it is structured this
way.

------------------------------------------------------------------------

# 2. Vision

This platform is not a traditional RAG system.

It is a **graph-native, agent-driven intelligence platform** designed
for Ferrari-grade archival analysis.

Core idea:

> Files are not stored for retrieval.\
> Files are transformed into evolving knowledge graphs.

The graph is the source of truth.\
LangGraph agents are the orchestrators.\
Neo4j is the structural memory.

------------------------------------------------------------------------

# 3. Design Philosophy

## 3.1 Graph-First

Most RAG systems: - Store embeddings - Retrieve top-k chunks - Inject
into prompt

This system: - Builds structured nodes - Connects relationships -
Enriches dynamically - Allows agents to reason over graph topology

Retrieval is hybrid: - Embeddings + graph traversal - Semantic +
structural context

------------------------------------------------------------------------

## 3.2 Agent Autonomy with Constraints

LangGraph agents must:

-   Decide what entities exist
-   Decide which node types to use
-   Decide when to create new types
-   Connect information intelligently

However, autonomy is bounded by:

-   A Type Registry
-   Mandatory type descriptions
-   Logging
-   Observability

The system must prevent chaotic ontology sprawl while allowing
evolution.

------------------------------------------------------------------------

# 4. Why LangGraph

LangGraph is used because:

-   We need multi-step reasoning
-   We need tool-based Neo4j querying
-   We need conditional logic
-   We need iterative graph enrichment

Single-shot prompts are insufficient.

LangGraph enables:

-   Deterministic workflows
-   Tool-calling agents
-   State machines
-   Re-entrant graph-building loops

------------------------------------------------------------------------

# 5. Why Neo4j

Neo4j is selected because:

-   The domain is inherently relational
-   Graph traversal is central
-   Dynamic schemas are required
-   Node types must evolve

This system depends on: - Type registry - Relationship integrity -
Cypher flexibility

------------------------------------------------------------------------

# 6. Infrastructure Philosophy

Everything must run via:

docker compose up

This ensures:

-   Local reproducibility
-   Agent-friendly execution
-   Deterministic development
-   No hidden cloud dependencies during development

External APIs are limited to OpenAI for:

-   GPT reasoning
-   Whisper transcription
-   Vision processing
-   Embeddings

All model usage must be configurable and logged.

------------------------------------------------------------------------

# 7. Observability & Cost Control

Every AI call must log:

-   Model name
-   Tokens in
-   Tokens out
-   Total tokens
-   Cost estimate
-   File reference
-   Organization reference
-   Timestamp

This enables:

-   Cost dashboards
-   Audit trails
-   Performance analysis
-   Budget governance

AI is treated as a billable infrastructure dependency.

------------------------------------------------------------------------

# 8. File View Philosophy

The file view is critical.

It must show:

1.  The original file (viewer/player)
2.  Extracted summary
3.  Structured entities
4.  Relationships created
5.  Embeddings stored
6.  Processing logs

The user must see:

> What the AI understood\
> What the graph contains\
> What the system did

Transparency builds trust.

------------------------------------------------------------------------

# 9. Monorepo & Layering Rationale

Strict separation is mandatory:

tRPC: - Entry only - No domain logic

Services: - Business rules - Orchestration

Repositories: - All Neo4j Cypher - No leakage

Shared package: - Prevents type drift - Single source of truth

This structure ensures:

-   Scalability
-   Replaceable layers
-   Testability
-   Clean mental model

------------------------------------------------------------------------

# 10. Organizational Isolation

The system is multi-tenant.

All data is scoped by:

-   Organization
-   User

Storage, graph nodes, embeddings, logs --- all must respect org
boundaries.

No cross-organization visibility.

------------------------------------------------------------------------

# 11. Long-Term Evolution

Future capabilities may include:

-   Role-based permissions
-   Cross-user sharing
-   Advanced ontology management
-   Cost dashboards
-   Real-time graph visualization
-   Cross-event pattern detection

However, v1 focuses on:

-   Upload
-   Process
-   Build graph
-   Query graph
-   Log AI usage

------------------------------------------------------------------------

# 12. Core Architectural Principles

1.  Graph is primary memory
2.  Agents build structure
3.  Embeddings enable semantics
4.  Transparency is mandatory
5.  Logging is first-class
6.  Types are controlled but extensible
7.  Everything is reproducible locally
8.  Ferrari-level UX quality

------------------------------------------------------------------------

# 13. Final Guidance for Implementation Agent

When implementing:

-   Do not shortcut the layering rules.
-   Do not embed business logic inside tRPC.
-   Do not allow uncontrolled node type creation.
-   Always log AI usage.
-   Always store embeddings.
-   Always check Type Registry before creating new types.
-   Keep everything documented in markdown.

The success of this platform depends on architectural discipline.

------------------------------------------------------------------------

END OF DOCUMENT
