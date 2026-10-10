import { analyticsHandler } from "./analytics";
import { catalogHandler } from "./catalog";
import { inventoryHandler } from "./inventory";
import { invoiceHandler } from "./invoice";
import { orderHandler } from "./order";
import type { AgentHandler } from "./types";
import { workflowHandler } from "./workflow";

export const handlers: ReadonlyArray<AgentHandler> = [
  workflowHandler,
  orderHandler,
  invoiceHandler,
  catalogHandler,
  inventoryHandler,
  analyticsHandler
];

export type { AgentHandler, HandlerContext } from "./types";
