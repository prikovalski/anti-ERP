import type { AgentResponse, AuditEvent, PendingActionPayload } from "@anti-erp/shared";
import { getPendingActionStore } from "../capabilities";
import { recordAgentStep } from "../observability/mcp-trace";
import { describeClarification, type EntityResolution } from "./entity-resolution";
import { proposeAction } from "./pending-actions";

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function audit(action: string, summary: string, actor: AuditEvent["actor"] = "agent"): AuditEvent {
  return {
    id: createId("aud"),
    timestamp: new Date().toISOString(),
    actor,
    action,
    summary
  };
}

/** The router overwrites `mode` with how the message was classified. */
export function response(text: string, extra: Partial<AgentResponse> = {}): AgentResponse {
  return {
    message: { id: createId("agent"), role: "agent", text },
    auditEvents: extra.auditEvents ?? [audit("agent_response", "Resposta gerada pelo agente.")],
    mode: "deterministic",
    ...extra
  };
}

export function clarificationResponse(text: string, reason: string) {
  return response(text, { auditEvents: [audit("clarification_required", reason)] });
}

/** Writes never run from a chat message: they become a pending action the user confirms in /api/agent/confirm. */
export async function proposalResponse(input: {
  payload: PendingActionPayload;
  title: string;
  summary: string;
  details?: string[];
  extra?: Partial<AgentResponse>;
}) {
  const pendingAction = await proposeAction(await getPendingActionStore(), input);
  await recordDecision("confirmation_required", { kind: input.payload.kind, actionId: pendingAction.id });
  return response(`${input.summary} Confirme para executar.`, {
    pendingAction,
    auditEvents: [audit("confirmation_required", `Aguardando confirmacao: ${input.title}.`)],
    ...input.extra
  });
}

export function unresolvedResponse(
  resolution: Exclude<EntityResolution<unknown>, { status: "resolved" }>,
  label: string,
  query: string
) {
  if (resolution.status === "ambiguous") {
    return response(describeClarification(resolution.clarification), {
      clarification: resolution.clarification,
      auditEvents: [audit("clarification_required", `Mais de um ${label} encontrado para "${query}".`)]
    });
  }
  return response(`Nao encontrei o ${label} ${query}.`);
}

export async function recordDecision(name: string, outputs: Record<string, unknown>) {
  await recordAgentStep({ name, kind: "decision", status: "success", durationMs: 0, outputs });
}
