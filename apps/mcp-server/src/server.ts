import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createCustomer,
  createConceptInvoice,
  createProduct,
  createSalesOrder,
  createSupplier,
  getSalesOrder,
  getTraditionalErpFlow,
  listRecentOrders,
  prepareSalesOrder,
  querySalesMetrics,
  searchCustomer,
  searchProduct,
  validateStock
} from "./domain.js";

const server = new McpServer({
  name: "anti-erp-mcp-server",
  version: "0.1.0"
});

function json(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.tool("search_customer", { query: z.string().min(2) }, (input) => json(searchCustomer(input)));

server.tool("search_product", { query: z.string().min(2) }, (input) => json(searchProduct(input)));

server.tool("create_customer", { name: z.string().trim().min(2) }, (input) => json(createCustomer(input)));

server.tool("create_product", { name: z.string().trim().min(2) }, (input) => json(createProduct(input)));

server.tool("create_supplier", { name: z.string().trim().min(2) }, (input) => json(createSupplier(input)));

server.tool(
  "validate_stock",
  {
    productId: z.string(),
    quantity: z.number().int().positive()
  },
  (input) => json(validateStock(input))
);

server.tool(
  "prepare_sales_order",
  {
    customerId: z.string(),
    lines: z.array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive()
      })
    )
  },
  (input) => json(prepareSalesOrder(input))
);

server.tool(
  "create_sales_order",
  {
    preview: z.object({
      customer: z.object({
        id: z.string(),
        name: z.string(),
        taxId: z.string(),
        city: z.string(),
        status: z.enum(["active", "blocked"])
      }),
      lines: z.array(
        z.object({
          productId: z.string(),
          sku: z.string(),
          name: z.string(),
          quantity: z.number().int().positive(),
          unitPrice: z.number().nonnegative(),
          total: z.number().nonnegative()
        })
      ),
      subtotal: z.number().nonnegative(),
      warnings: z.array(z.string()),
      confirmationRequired: z.literal(true)
    }),
    confirmedByUser: z.literal(true)
  },
  (input) => json(createSalesOrder(input))
);

server.tool(
  "create_concept_invoice",
  { salesOrderId: z.string() },
  (input) => json(createConceptInvoice(input))
);

server.tool("get_sales_order", { salesOrderId: z.string() }, (input) => json(getSalesOrder(input)));

server.tool("list_recent_orders", {}, () => json(listRecentOrders()));

server.tool("get_traditional_erp_flow", {}, () => json(getTraditionalErpFlow()));

server.tool(
  "query_sales_metrics",
  {
    metric: z.enum(["units_sold", "revenue", "order_count"]),
    productQuery: z.string().nullable().optional(),
    customerQuery: z.string().nullable().optional(),
    dateRange: z.enum(["today", "last_7_days", "month_to_date", "all_time"]),
    groupBy: z.enum(["product", "customer", "day"]).nullable().optional()
  },
  (input) => json(querySalesMetrics(input))
);

const transport = new StdioServerTransport();
await server.connect(transport);
