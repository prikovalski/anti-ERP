import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

export function registerCustomerTools(server: McpServer, gateway: CapabilityGateway) {
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
}
