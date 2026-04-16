# Media Intelligence Platform -- Full Technical Specification

**Version:** v1 Draft\
**Generated:** 2026-02-14T12:01:52.493163 UTC

------------------------------------------------------------------------

# 1. Product Overview

The Media Intelligence Platform is a multi-tenant, agentic, graph-based
RAG system built for Ferrari-class archival intelligence.

It ingests multimedia content, builds a dynamic knowledge graph in Neo4j
using LangGraph-based agents, and enables semantic, proximity-based
retrieval.

------------------------------------------------------------------------

# 2. Architecture Overview

## 2.1 Monorepo Structure

TypeScript monorepo:

-   apps/frontoffice → Next.js UI (Clerk auth, GPT-style interface)
-   apps/api → tRPC entrypoint (no business logic)
-   apps/daemon → background processor (queue consumer + LangGraph
    runner)
-   packages/shared → shared schemas & types
-   packages/langgraph → agent orchestration + markdown specs
-   packages/mongodb → document + queue persistence; Pinecone for vectors

------------------------------------------------------------------------

# 3. Frontend (Next.js)

## 3.1 UI Stack

-   Next.js
-   TailwindCSS
-   shadcn/ui
-   CVA (Class Variance Authority)
-   Ferrari-inspired premium design

## 3.2 Pages

### Home (Search)

-   GPT-style centered search
-   Semantic retrieval across uploaded content

### File Manager (Upload-only v1)

-   Upload via pre-signed R2 links
-   Folder support
-   File status indicators

### File View Interface

For each file: - Native viewer (PDF/image/video/audio) - Extracted AI
summary - File metadata - Graph-extracted entities - Stored embeddings -
Processing logs

------------------------------------------------------------------------

# 4. Upload & Storage

## 4.1 Storage

-   Cloudflare R2
-   Single bucket
-   Organization-based partitioning

Object path example:
org/`<orgId>`{=html}/user/`<userId>`{=html}/`<folder>`{=html}/`<fileId>`{=html}.`<ext>`{=html}

## 4.2 Upload Flow

1.  Request pre-signed URL
2.  Direct upload to R2
3.  Commit upload
4.  Queue processing job

------------------------------------------------------------------------

# 5. Queue & Daemon

Queue system (Docker): - RabbitMQ or BullMQ

Daemon responsibilities: - File processing - Content extraction (PDF,
images, audio/video) - Whisper transcription - Vision analysis -
Embedding generation - LangGraph execution - Neo4j updates

All written in TypeScript.

------------------------------------------------------------------------

# 6. LangGraph Layer

LangGraph orchestrates:

-   Entity extraction
-   Node type resolution
-   Dynamic type creation
-   Relationship creation
-   Iterative graph enrichment

Agents must:

-   Query Neo4j
-   Access Type Registry
-   Create new node types (with description)
-   Log decisions

All orchestration documented in markdown inside packages/langgraph.

------------------------------------------------------------------------

# 7. Neo4j Graph Model

## 7.1 Core Nodes

-   Organization
-   User
-   File
-   Document
-   Transcript
-   MediaAsset
-   Tag
-   Mention
-   TypeRegistry

## 7.2 Dynamic Type System

Agents can: - Query existing types - Reuse types - Create new types with
description + metadata

Each type stores: - typeName - description - createdBy - timestamp

------------------------------------------------------------------------

# 8. Embeddings

For every file:

-   Chunked embeddings generated
-   Stored and linked in Neo4j
-   Embedding metadata stored:
    -   model
    -   version
    -   createdAt

Embeddings are mandatory for semantic retrieval.

------------------------------------------------------------------------

# 9. External AI Infrastructure

Initial provider: OpenAI

Used APIs:

-   GPT models (analysis & reasoning)
-   Vision models (image & PDF processing)
-   Whisper (audio transcription)
-   Embedding models

All model usage must be configurable via environment variables.

------------------------------------------------------------------------

# 10. AI Execution Logging & Cost Tracking

Every LangGraph or AI execution must store:

-   model name
-   input tokens
-   output tokens
-   total tokens
-   cost estimate
-   execution timestamp
-   file reference (if applicable)
-   org reference

This enables:

-   Cost monitoring
-   Auditability
-   Performance analysis

------------------------------------------------------------------------

# 11. Docker Compose Requirements

Single command:

docker compose up

Must start:

-   Next.js frontoffice
-   tRPC API
-   Daemon
-   Neo4j
-   Queue system
-   LangGraph runtime dependencies

Environment-driven configuration.

------------------------------------------------------------------------

# 12. Development Philosophy

-   Strict layer separation
-   No business logic in tRPC
-   Services encapsulate domain logic
-   Repositories encapsulate Neo4j queries
-   Shared schemas prevent type drift
-   Everything in TypeScript

------------------------------------------------------------------------

# 13. Core Principles

-   Graph-first RAG
-   Agent-driven enrichment
-   Deterministic storage
-   Organization isolation
-   Observability & cost awareness
-   Ferrari-grade UX quality

------------------------------------------------------------------------

END OF SPECIFICATION
