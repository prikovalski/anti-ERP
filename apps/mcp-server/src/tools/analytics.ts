import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

export function registerAnalyticsTools(server: McpServer, gateway: CapabilityGateway) {
  server.tool("get_traditional_erp_flow", {}, async () => json(await gateway.getTraditionalErpFlow()));

  server.tool(
    "query_sales_metrics",
    {
      metric: z.enum(["units_sold", "revenue", "order_count"]),
      productQuery: z.string().nullable().optional(),
      customerQuery: z.string().nullable().optional(),
      dateRange: z.enum(["today", "last_7_days", "month_to_date", "all_time"]),
      groupBy: z.enum(["product", "customer", "day"]).nullable().optional()
    },
    async (input) => json(await gateway.querySalesMetrics(input))
  );

  server.tool(
    "query_managerial_report",
    {
      question: z.string().trim().min(1).nullable().optional(),
      kind: z.enum(["sales_by_period", "top_products", "active_customers", "margin", "stockout_risk", "revenue", "ranking", "trend"]).nullable().optional(),
      dateRange: z.enum(["today", "last_7_days", "month_to_date", "all_time"]).default("all_time"),
      groupBy: z.enum(["product", "customer", "day"]).nullable().optional(),
      take: z.number().int().positive().max(100).nullable().optional()
    },
    async (input) => json(await gateway.queryManagerialReport(input))
  );
}
