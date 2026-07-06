# Architecture

```text
Command Center -> Agent -> MCP Client -> anti-ERP MCP Server -> Domain Services -> Database
```

## Why MCP-native

Traditional ERPs expose screens and CRUD endpoints, then force people to translate business intent into system operations. anti-ERP starts from capabilities. Each capability is explicit, typed, auditable, and safe to call from an agent.

## Boundary decisions

- The Command Center owns the user experience, confirmation states, and audit visualization.
- The agent interprets intent and plans tool calls.
- The MCP Server owns business capabilities and validation.
- Domain Services own invariants such as stock validation, customer status, and order creation.
- Prisma/PostgreSQL persist state when the prototype moves beyond seeded demo data.

## AI architecture roadmap

1. Use tool calling with structured outputs for intent extraction and planning.
2. Add guardrails for demo-safe behavior and confirmation enforcement.
3. Add OpenTelemetry and Langfuse for agent traces, cost, latency, and tool-call observability.
4. Add evals for the core sales-order flow, ambiguity handling, and refusal behavior.
5. Consider RAG only for business-document retrieval, not for transactional truth.
6. Add human-in-the-loop approval flows before any irreversible operation.
