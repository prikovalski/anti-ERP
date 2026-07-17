import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  taxId: z.string(),
  city: z.string(),
  status: z.enum(["active", "blocked"])
});

const SalesOrderLineSchema = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  total: z.number().nonnegative()
});

const SalesOrderPreviewSchema = z.object({
  customer: CustomerSchema,
  lines: z.array(SalesOrderLineSchema),
  subtotal: z.number().nonnegative(),
  warnings: z.array(z.string()),
  confirmationRequired: z.literal(true)
});

export function registerSalesOrderTools(server: McpServer, gateway: CapabilityGateway) {
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
    async (input) => json(await gateway.prepareSalesOrder(input))
  );

  server.tool(
    "create_sales_order",
    {
      preview: SalesOrderPreviewSchema,
      confirmedByUser: z.literal(true)
    },
    async (input) => json(await gateway.createSalesOrder(input))
  );

  server.tool(
    "add_sales_order_line",
    {
      salesOrderId: z.string(),
      productId: z.string(),
      quantity: z.number().int().positive()
    },
    async (input) => json(await gateway.addSalesOrderLine(input))
  );

  server.tool(
    "set_sales_order_line_quantity",
    {
      salesOrderId: z.string(),
      productId: z.string(),
      quantity: z.number().int().nonnegative()
    },
    async (input) => json(await gateway.setSalesOrderLineQuantity(input))
  );

  server.tool(
    "remove_sales_order_line",
    {
      salesOrderId: z.string(),
      productId: z.string()
    },
    async (input) => json(await gateway.removeSalesOrderLine(input))
  );

  server.tool(
    "apply_sales_order_discount",
    {
      salesOrderId: z.string(),
      productId: z.string().nullable().optional(),
      discountType: z.enum(["percent", "amount"]),
      value: z.number().positive()
    },
    async (input) => json(await gateway.applySalesOrderDiscount(input))
  );

  server.tool("cancel_sales_order", { salesOrderId: z.string() }, async (input) =>
    json(await gateway.cancelSalesOrder(input))
  );

  server.tool("duplicate_sales_order", { salesOrderId: z.string() }, async (input) =>
    json(await gateway.duplicateSalesOrder(input))
  );

  server.tool("get_sales_order", { salesOrderId: z.string() }, async (input) =>
    json(await gateway.getSalesOrder(input))
  );

  server.tool(
    "list_sales_orders",
    {
      customerQuery: z.string().nullable().optional(),
      dateRange: z.enum(["today", "last_7_days", "month_to_date", "all_time"]).nullable().optional(),
      status: z.enum(["draft", "confirmed", "canceled"]).nullable().optional(),
      take: z.number().int().positive().max(100).nullable().optional()
    },
    async (input) => json(await gateway.listSalesOrders(input))
  );

  server.tool("list_recent_orders", {}, async () => json(await gateway.listRecentOrders()));
}
