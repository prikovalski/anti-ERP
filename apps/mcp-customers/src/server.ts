import { PrismaCapabilityGateway } from "@anti-erp/capabilities";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "anti-erp-customers-mcp",
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

server.tool("search_customer", { query: z.string().min(2) }, async (input) =>
  json(await gateway.searchCustomer(input))
);

server.tool(
  "search_customers_advanced",
  {
    query: z.string().trim().min(1).nullable().optional(),
    status: z.enum(["active", "inactive", "blocked"]).nullable().optional(),
    take: z.number().int().positive().max(100).nullable().optional()
  },
  async (input) => json(await gateway.searchCustomersAdvanced(input))
);

server.tool("create_customer", { name: z.string().trim().min(2) }, async (input) =>
  json(await gateway.createCustomer(input))
);

server.tool(
  "update_customer",
  {
    customerId: z.string(),
    name: z.string().trim().min(2).nullable().optional(),
    city: z.string().trim().min(2).nullable().optional(),
    status: z.enum(["active", "inactive", "blocked"]).nullable().optional()
  },
  async (input) => json(await gateway.updateCustomer(input))
);

server.tool("list_customers", {}, async () => json(await gateway.listCustomers()));

const transport = new StdioServerTransport();
await server.connect(transport);
