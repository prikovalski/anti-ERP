# Backend Architecture

The anti-ERP backend is organized around natural-language intent, not CRUD screens.

```mermaid
flowchart LR
  Frontend["Frontend<br/>Next.js Command Center"]
  API["API Routes<br/>/api/agent<br/>/api/agent/confirm"]
  Graph["LangGraph Agent"]
  OpenRouter["OpenRouter<br/>intent inference"]
  Gateway["Capability Gateway"]
  PrismaGateway["Prisma Gateway<br/>recommended deploy path"]
  McpGateway["MCP stdio Gateway<br/>local architecture path"]
  Customers["MCP Customers"]
  Products["MCP Products"]
  Suppliers["MCP Suppliers"]
  SalesOrders["MCP Sales Orders"]
  Invoices["MCP Invoices"]
  Analytics["MCP Analytics"]
  DB["Postgres Neon<br/>Prisma"]
  LangSmith["LangSmith<br/>Tracing"]
  Studio["LangGraph Studio"]

  Frontend --> API
  API --> Graph
  Graph --> OpenRouter
  Graph --> Gateway
  Gateway --> PrismaGateway
  Gateway -. "optional local stdio" .-> McpGateway
  McpGateway --> Customers
  McpGateway --> Products
  McpGateway --> Suppliers
  McpGateway --> SalesOrders
  McpGateway --> Invoices
  McpGateway --> Analytics
  PrismaGateway --> DB
  Customers --> DB
  Products --> DB
  Suppliers --> DB
  SalesOrders --> DB
  Invoices --> DB
  Analytics --> DB
  Graph --> LangSmith
  Gateway --> LangSmith
  Graph --> Studio
```

## Responsibilities

Frontend:
- Renders the conversational command center, confirmation UI, timeline, and MCP trace.
- Never receives LLM or database secrets.

API routes:
- Validate request payloads.
- Start the LangGraph agent or confirm a prepared order.
- Return structured responses to the frontend.

LangGraph agent:
- Parses local intent first.
- Optionally asks OpenRouter for better intent inference.
- Routes each intent to explicit graph nodes.
- Composes user-facing responses.

Capability Gateway:
- Provides a stable interface between the agent and executable business capabilities.
- Uses the Prisma gateway for public deploys.
- Can route calls to domain MCP servers over stdio for local architecture experiments.
- Records MCP traces and LangSmith child runs.

MCP servers:
- Own domain-specific tools for customers, products, suppliers, sales orders, invoices, and analytics when `CAPABILITY_GATEWAY=mcp`.
- Execute business operations against Postgres through Prisma.

Postgres:
- Source of truth for catalog, orders, invoices, sequences, audit events, and MCP call logs.

LangSmith and LangGraph Studio:
- Show graph execution, node-level decisions, and MCP tool calls.
- Help debug both intent routing and operational failures.

## Current Graph Routes

- `sales_order`: prepares order previews and optional invoice intent.
- `sales_order_update`: changes quantities, removes items, duplicates, cancels, and applies discounts.
- `invoice`: issues, cancels, reissues, consults, and lists concept invoices.
- `analytics`: answers sales metric questions and supports intelligent report generation.
- `catalog`: creates, updates, searches, lists, activates, and deactivates customers, products, and suppliers.
- `product_update`: updates product price or stock.
- `inventory`: creates entries, exits, adjustments, reservations, write-offs, low-stock alerts, stock position, and movement history.
- `orders_list`: lists orders by customer, period, or status.
- `traditional_flow`: explains traditional ERP flow versus anti-ERP flow.
- `clarification`: asks a specific follow-up question when intent or entities are ambiguous.
