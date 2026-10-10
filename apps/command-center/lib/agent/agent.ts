import type { AgentResponse } from "@anti-erp/shared";
import { getCapabilityGateway } from "../capabilities";
import { createObservedCapabilityGateway } from "../observability/observed-gateway";
import { buildClarifyingFallbackQuestion } from "./clarifying-fallback";
import { handlers, type HandlerContext } from "./handlers";
import { classifyCommand } from "./nlu/classifier";
import type { Classification, ClassificationSource } from "./nlu/commands";
import { clarificationResponse, recordDecision } from "./responses";

const MODE_BY_SOURCE: Record<ClassificationSource, AgentResponse["mode"]> = {
  rules: "deterministic",
  llm: "llm",
  fallback: "fallback"
};

export type AgentInput = { message: string; lastOrderId?: string | null };

/** Classifies the message once and lets the owning handler answer it. Used by /api/agent and by the Studio graph. */
export async function runAgent(input: AgentInput): Promise<AgentResponse> {
  return executeClassification(await classifyCommand(input.message), input);
}

export async function executeClassification(classification: Classification, input: AgentInput): Promise<AgentResponse> {
  await recordDecision("intent_classified", {
    kind: classification.command.kind,
    confidence: classification.confidence,
    source: classification.source,
    candidates: classification.candidates.slice(0, 4)
  });

  const context: HandlerContext = {
    gateway: createObservedCapabilityGateway(await getCapabilityGateway(), "capability"),
    message: input.message,
    lastOrderId: input.lastOrderId ?? null
  };
  const handler = handlers.find((candidate) => candidate.match(classification.command));
  const result = handler
    ? await handler.execute(classification.command, context)
    : clarificationResponse(buildClarifyingFallbackQuestion(input.message), "Mensagem sem rota executavel.");
  return { ...result, mode: MODE_BY_SOURCE[classification.source] };
}
