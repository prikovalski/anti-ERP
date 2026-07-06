# anti-ERP

**The first MCP-native AI ERP experiment.**

> You shouldn't learn an ERP. Your ERP should understand your intent.

anti-ERP is a public, open-source portfolio prototype that questions the default shape of enterprise software. It is not "an ERP with a chatbot". It is an experiment in what happens when agents become the primary interface and the backend is designed as a typed capability server from day one.

## The thesis

Most ERP systems make people translate business intent into menu navigation, forms, modules, and transaction codes.

anti-ERP flips the model:

```text
Command Center -> Agent -> MCP Client -> anti-ERP MCP Server -> Domain Services -> Database
```

The center of the system is not a CRUD REST API. The center is a set of explicit MCP tools that an agent can call safely, with validation, confirmation, and auditability.

## MVP experience

The public demo opens directly in the Command Center. No login, no menu tree.

Try:

```text
Crie um pedido para ACME com 10 notebooks e gere a nota.
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
│   └── mcp-server/
├── packages/
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
- MCP Server: TypeScript and MCP SDK
- Shared contracts: Zod schemas and TypeScript types
- Persistence roadmap: Prisma and PostgreSQL, preferably Neon
- AI roadmap: OpenAI Responses API, tool calling, structured outputs, guardrails, observability, evals

## MCP tools

- `search_customer`
- `search_product`
- `validate_stock`
- `prepare_sales_order`
- `create_sales_order`
- `create_concept_invoice`
- `get_sales_order`
- `list_recent_orders`
- `get_traditional_erp_flow`

Key rule: `prepare_sales_order` only creates a preview. `create_sales_order` requires explicit user confirmation.

## Run locally

```bash
pnpm install
pnpm command-center:dev
```

In another terminal:

```bash
pnpm mcp:dev
```

## Why this matters

Enterprise software is full of accidental complexity. Agents give us a chance to remove some of it, but only if we avoid building a thin chatbot over the same old screens.

anti-ERP is a small prototype with a large question behind it:

What if the ERP became a set of business capabilities that could understand intent, ask for confirmation, and leave a trustworthy audit trail?
