import type { AgentResponse } from "@anti-erp/shared";
import type { CapabilityGateway } from "../../capabilities";
import type { Command } from "../nlu/commands";

export type HandlerContext = {
  gateway: CapabilityGateway;
  message: string;
  /** Active order of the server-side conversation session, if any. */
  lastOrderId: string | null;
};

/** One domain of the agent. The router asks each handler, in order, whether it owns the classified command. */
export interface AgentHandler<C extends Command = Command> {
  name: string;
  match(command: Command): command is C;
  execute(command: C, context: HandlerContext): Promise<AgentResponse>;
}
