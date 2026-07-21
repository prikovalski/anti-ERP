# anti-ERP

**The first MCP-native AI ERP experiment.**

> You shouldn't learn an ERP. Your ERP should understand your intent.

anti-ERP is a public, open-source portfolio prototype that questions the default shape of enterprise software. It is not "an ERP with a chatbot". It is an experiment in what happens when agents become the primary interface and the backend is designed as a typed capability server from day one.

## The thesis

Most ERP systems make people translate business intent into menu navigation, forms, modules, and transaction codes.

anti-ERP flips the model:

```text
Command Center -> API Routes -> LangGraph Agent -> Capability Gateway -> Prisma/Postgres
```

The center of the system is not a CRUD REST API. The center is a set of explicit business capabilities that an agent can call safely, with validation, confirmation, and auditability. The intended architecture is MCP-native; the public demo can run through the Prisma gateway to avoid stdio subprocesses in serverless hosting.

## MVP experience

The public demo opens directly in the Command Center. No login, no menu tree.

Try:

```text
Crie um pedido para Northstar com 10 notebooks e gere a nota.
```

The prototype:

1. Resolves the customer.
2. Resolves the product.
3. Validates stock.
4. Prepares a sales-order preview.
5. Shows a confirmation card.
6. Creates the order only after confirmation.
7. Generates a concept invoice.
8. Records an auditable timeline.

## Monorepo

```text
anti-erp/
├── apps/
│   ├── command-center/
│   ├── mcp-analytics/
│   ├── mcp-customers/
│   ├── mcp-invoices/
│   ├── mcp-products/
│   ├── mcp-sales-orders/
│   ├── mcp-server/
│   └── mcp-suppliers/
├── packages/
│   ├── capabilities/
│   ├── shared/
│   └── config/
├── prisma/
├── specs/
├── docs/
├── package.json
└── README.md
```

## Stack

- Monorepo with pnpm workspaces and Turborepo
- Command Center: Next.js, TypeScript, Tailwind CSS
- Agent orchestration: LangGraph with deterministic local parsing and optional OpenRouter inference
- Capability layer: Prisma gateway for deploys, MCP stdio gateway for local architecture experiments
- MCP servers: TypeScript and MCP SDK, split by domain
- Shared contracts: Zod schemas, TypeScript types, and utility helpers
- Persistence: Prisma and PostgreSQL, preferably Neon
- Observability: LangSmith traces plus local MCP call logs

## Capabilities

- Catalog: create, update, search, list, activate, and deactivate customers, products, and suppliers.
- Sales orders: prepare, confirm, update items, apply discounts, cancel, duplicate, consult, and list by customer, period, or status.
- Invoices: issue from sales orders, cancel, reissue, consult, and list by period.
- Inventory: entry, exit, adjustment, reservation, order write-off, low-stock alerts, position, and movement history.
- Analytics: natural-language managerial reports over sales, revenue, stock, rankings, margins, and trends.
- Auditability: every meaningful action can be traced as a capability call and surfaced in the UI.

Key rule: `prepare_sales_order` only creates a preview. `create_sales_order` requires explicit user confirmation.

## Capability gateway

The Command Center talks to capabilities through a gateway interface. For the current public demo posture, use Prisma with Neon/Postgres:

```bash
CAPABILITY_GATEWAY=prisma
MCP_STDIO_ENABLED=false
DATABASE_URL="postgresql://..."
```

This mode persists customers, products, suppliers, inventory, sales orders, concept invoices, audit events, document counters, and MCP call logs.

To use the deterministic in-memory gateway without a database:

```bash
CAPABILITY_GATEWAY=demo
```

To exercise the MCP-native stdio path locally:

```bash
CAPABILITY_GATEWAY=mcp
MCP_STDIO_ENABLED=true
MCP_SERVER_COMMAND=pnpm
MCP_SERVER_ARGS="--filter @anti-erp/mcp-server dev"
```

In all modes, the agent orchestrates capabilities. Domain actions stay behind explicit operations such as customer search, stock validation, sales-order preparation, invoice issue, inventory write-off, and managerial reporting.

## Database setup

Prisma commands run from the repository root and read `.env` from the repository root:

```text
anti-ERP/
  .env
  apps/
    command-center/
      .env.local
```

Root `.env`:

```bash
DATABASE_URL="postgresql://..."
CAPABILITY_GATEWAY=prisma
MCP_STDIO_ENABLED=false
```

Then run:

```bash
pnpm db:generate
pnpm db:push
```

Run `pnpm db:seed` only when you intentionally want to insert demo data. Do not run seed against a shared or already-populated database unless you have reviewed the seed script.

## Run locally

Install dependencies:

```bash
pnpm install
```

Create `apps/command-center/.env.local` for the Next.js app:

```bash
DATABASE_URL="postgresql://..."
CAPABILITY_GATEWAY=prisma
MCP_STDIO_ENABLED=false
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Start the Command Center:

```bash
pnpm command-center:dev
```

Open:

```text
http://localhost:3000
```

## LLM configuration

The demo is safe to run without any LLM key. In that case, the Command Center uses a deterministic demo-agent that can classify the core MVP intents and execute the same typed flow.

To experiment with a free OpenRouter model, create `.env.local` inside `apps/command-center` or set the variables in Vercel:

```bash
OPENROUTER_API_KEY=your_server_side_key
OPENROUTER_MODEL=openrouter/free
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Do not expose secrets with `NEXT_PUBLIC_`. The browser calls `/api/agent`; the OpenRouter key stays server-side only. If OpenRouter is unavailable, rate-limited, or returns invalid output, the app falls back to the deterministic demo-agent.

## LangSmith observability

LangSmith is optional and server-side only:

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=your_server_side_key
LANGSMITH_PROJECT=anti-erp
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```

When enabled, traces show graph execution, intent routing decisions, capability calls, errors, and clarification flows.

## Deploy

Recommended first deploy:

- Host the Next.js app on Vercel.
- Use Neon/Postgres for `DATABASE_URL`.
- Set `CAPABILITY_GATEWAY=prisma`.
- Set `MCP_STDIO_ENABLED=false`.
- Store OpenRouter, LangSmith, and database credentials only as platform environment variables.
- Run `pnpm db:generate` and `pnpm db:push` from a trusted local terminal or CI job before the first deploy.
- Do not run `pnpm db:seed` against production unless you intentionally want demo records.

For Vercel monorepo settings:

```text
Root Directory: apps/command-center
Install Command: pnpm install --frozen-lockfile
Build Command: pnpm --filter @anti-erp/command-center build
```

## Why this matters

Enterprise software is full of accidental complexity. Agents give us a chance to remove some of it, but only if we avoid building a thin chatbot over the same old screens.

anti-ERP is a small prototype with a large question behind it:

What if the ERP became a set of business capabilities that could understand intent, ask for confirmation, and leave a trustworthy audit trail?
