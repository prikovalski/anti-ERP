# Architecture

```text
Command Center -> API Routes -> LangGraph Agent -> Capability Gateway -> Prisma/PostgreSQL
```

## Why MCP-native

Traditional ERPs expose screens and CRUD endpoints, then force people to translate business intent into system operations. anti-ERP starts from capabilities. Each capability is explicit, typed, auditable, and safe to call from an agent.

## Boundary decisions

- The Command Center owns the user experience, confirmation states, and audit visualization.
- The LangGraph agent interprets intent, routes each flow through explicit nodes, and plans tool calls.
- The Capability Gateway is the boundary between agent orchestration and executable business capabilities.
- MCP Servers own business capabilities and validation by domain when the stdio gateway is enabled.
- Prisma/PostgreSQL persist catalog, orders, invoices, sequences, audit events, and MCP call logs.

## Capability gateway

The Command Center depends on a `CapabilityGateway` interface, not on domain data directly.

```text
/api/agent -> LangGraph Agent -> CapabilityGateway -> Prisma Gateway -> PostgreSQL
```

For public deploys, the recommended runtime is `CAPABILITY_GATEWAY=prisma` with `MCP_STDIO_ENABLED=false`. This avoids spawning stdio subprocesses in serverless environments while preserving the same capability interface and business validations.

For local architecture experiments, `CAPABILITY_GATEWAY=mcp` with `MCP_STDIO_ENABLED=true` exercises the intended MCP-native shape by spawning domain MCP servers over stdio and calling explicit tools.

## AI architecture roadmap

1. Use tool calling with structured outputs for intent extraction and planning.
2. Add guardrails for demo-safe behavior and confirmation enforcement.
3. Expand LangSmith traces with eval datasets for critical business flows.
4. Add evals for ambiguity handling and refusal behavior.
5. Consider RAG only for business-document retrieval, not for transactional truth.
6. Add human-in-the-loop approval flows before irreversible operations beyond the demo scope.

## Public demo LLM posture

The public demo must never expose an LLM key to the browser. The Command Center calls server-side API routes:

```text
Browser -> /api/agent -> LangGraph -> optional OpenRouter intent inference -> Capability Gateway
Browser -> /api/agent/confirm -> explicit write action
```

OpenRouter is optional and used only for intent inference and planning assistance. The local parser remains the deterministic fallback, so the public demo stays usable when free model capacity is unavailable. The OpenRouter key stays server-side and is never exposed to the browser.

For the current backend diagram and graph routes, see [Backend Architecture](./backend-architecture.md).
