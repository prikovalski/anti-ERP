import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

export function registerCustomerTools(server: McpServer, gateway: CapabilityGateway) {
  server.tool("search_customer", { query: z.string().min(2) }, async (input) =>
    json(await gateway.searchCustomer(input))
  );

  server.tool("create_customer", { name: z.string().trim().min(2) }, async (input) =>
    json(await gateway.createCustomer(input))
  );
}
