# anti-ERP MVP Spec

## Thesis

The anti-ERP is not an ERP with a chatbot attached. It is an MCP-native business system where the primary interface is intent, and the backend exposes explicit capabilities instead of CRUD-first endpoints.

## Demo promise

A visitor can open the public demo, type "Create an order for ACME with 10 notebooks and generate the invoice", review a confirmation card, approve it, and see an auditable timeline of what the agent did.

## Required capabilities

- `search_customer`
- `search_product`
- `validate_stock`
- `prepare_sales_order`
- `create_sales_order`
- `create_concept_invoice`
- `get_sales_order`
- `list_recent_orders`
- `get_traditional_erp_flow`

## Product rules

- The agent never writes directly to the database.
- Every write must pass through an MCP tool.
- `prepare_sales_order` returns a preview only.
- `create_sales_order` requires explicit user confirmation.
- `create_concept_invoice` requires an existing sales order.
- Every relevant action is audit logged.
- Traditional menus are secondary to intent-driven interaction.

## Out of scope

Authentication, fiscal compliance, SEFAZ integration, real NFe, tax calculation, multi-company logic, complex inventory, financial settlement, advanced reporting, and a CRUD-first REST API.
