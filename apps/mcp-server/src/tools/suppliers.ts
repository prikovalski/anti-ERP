import type { CapabilityGateway } from "@anti-erp/capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json } from "./shared";

export function registerSupplierTools(server: McpServer, gateway: CapabilityGateway) {
  server.tool("create_supplier", { name: z.string().trim().min(2) }, async (input) =>
    json(await gateway.createSupplier(input))
  );
}
