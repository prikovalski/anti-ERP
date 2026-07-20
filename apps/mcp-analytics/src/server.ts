import { PrismaCapabilityGateway } from "@anti-erp/capabilities";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "anti-erp-analytics-mcp",
  version: "0.1.0"
});
const gateway = new PrismaCapabilityGateway();

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

server.tool("get_traditional_erp_flow", {}, async () => json(await gateway.getTraditionalErpFlow()));

server.tool(
  "query_sales_metrics",
  {
    metric: z.enum(["units_sold", "revenue", "order_count"]),
    productQuery: z.string().nullable().optional(),
    productQueries: z.array(z.string().min(1)).nullable().optional(),
    customerQuery: z.string().nullable().optional(),
    dateRange: z.enum(["today", "last_7_days", "last_30_days", "month_to_date", "all_time"]),
    groupBy: z.enum(["product", "customer", "day"]).nullable().optional()
  },
  async (input) => json(await gateway.querySalesMetrics(input))
);

server.tool(
  "query_managerial_report",
  {
    question: z.string().trim().min(1).nullable().optional(),
    kind: z.enum(["sales_by_period", "top_products", "active_customers", "margin", "stockout_risk", "revenue", "ranking", "trend"]).nullable().optional(),
    dateRange: z.enum(["today", "last_7_days", "last_30_days", "month_to_date", "all_time"]).default("all_time"),
    groupBy: z.enum(["product", "customer", "day"]).nullable().optional(),
    take: z.number().int().positive().max(100).nullable().optional()
  },
  async (input) => json(await gateway.queryManagerialReport(input))
);

server.tool(
  "query_intelligent_report",
  {
    question: z.string().trim().min(1)
  },
  async (input) => json(await gateway.queryIntelligentReport(input))
);

const transport = new StdioServerTransport();
await server.connect(transport);
