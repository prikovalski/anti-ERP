import type {
  AgentResponse,
  ConversationContext,
  ConversationEntity,
  SalesOrderPreview
} from "@anti-erp/shared";

export function createEmptyConversationContext(): ConversationContext {
  return {
    activeOrderId: null,
    activeInvoiceId: null,
    activeCustomer: null,
    activeProducts: [],
    lastDocumentType: null,
    pendingConfirmation: "none",
    lastUserCommand: null,
    lastAgentSummary: null
  };
}

export function evolveConversationContext(input: {
  current?: ConversationContext | null;
  response: AgentResponse;
  userCommand?: string | null;
}): ConversationContext {
  const current = input.current ?? createEmptyConversationContext();
  const preview = input.response.preview ?? null;
  const order = input.response.order ?? null;
  const invoice = input.response.invoice ?? null;
  const analyticsResult = input.response.analyticsResult ?? null;
  const customerSource = order ?? preview;

  return {
    ...current,
    activeOrderId: input.response.lastOrderId ?? order?.id ?? current.activeOrderId,
    activeInvoiceId: invoice?.id ?? current.activeInvoiceId,
    activeCustomer: customerSource ? toEntity(customerSource.customer) : current.activeCustomer,
    activeProducts: mergeEntities(
      current.activeProducts,
      order?.lines.map((line) => ({ id: line.productId, name: line.name }))
        ?? preview?.lines.map((line) => ({ id: line.productId, name: line.name }))
        ?? []
    ),
    lastDocumentType: inferDocumentType(input.response),
    pendingConfirmation: preview ? "sales_order" : "none",
    lastUserCommand: input.userCommand ?? current.lastUserCommand,
    lastAgentSummary: summarizeAgentMessage(input.response.message.text)
  };
}

export function evolveContextFromPreviewConfirmation(input: {
  current?: ConversationContext | null;
  preview: SalesOrderPreview;
  response: AgentResponse;
}): ConversationContext {
  return evolveConversationContext({
    current: {
      ...(input.current ?? createEmptyConversationContext()),
      activeCustomer: toEntity(input.preview.customer),
      activeProducts: mergeEntities(
        input.current?.activeProducts ?? [],
        input.preview.lines.map((line) => ({ id: line.productId, name: line.name }))
      ),
      pendingConfirmation: "none"
    },
    response: input.response
  });
}

function inferDocumentType(response: AgentResponse): ConversationContext["lastDocumentType"] {
  if (response.executionPlan) {
    return "plan";
  }
  if (response.preview) {
    return "sales_order_preview";
  }
  if (response.invoice) {
    return "invoice";
  }
  if (response.order) {
    return "sales_order";
  }
  if (response.analyticsResult) {
    return "report";
  }
  return "message";
}

function toEntity(entity: { id?: string | null; name: string }): ConversationEntity {
  return {
    id: entity.id ?? null,
    name: entity.name
  };
}

function mergeEntities(current: ConversationEntity[], incoming: ConversationEntity[]) {
  const byName = new Map<string, ConversationEntity>();
  for (const entity of [...current, ...incoming]) {
    byName.set(normalize(entity.name), entity);
  }
  return Array.from(byName.values()).slice(-8);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function summarizeAgentMessage(message: string) {
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}
