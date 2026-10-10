import type { AgentResponse, ExecutionPlan } from "@anti-erp/shared";
import type { CommandOf, WorkflowStep } from "../nlu/commands";
import { audit, response } from "../responses";
import { runIntelligentReport } from "./analytics";
import { invoiceHandler } from "./invoice";
import { prepareSalesOrderProposal } from "./order";
import type { AgentHandler, HandlerContext } from "./types";

type PlanStep = ExecutionPlan["steps"][number];

const STATUS_LABEL: Record<PlanStep["status"], string> = {
  planned: "planejada",
  executed: "concluida",
  pending_confirmation: "aguardando confirmacao",
  blocked: "bloqueada",
  skipped: "ignorada"
};

/** Runs a multi-step request in order. Writes that need confirmation stop at a pending action, as everywhere else. */
export const workflowHandler: AgentHandler<CommandOf<"workflow">> = {
  name: "workflow",
  match: (command): command is CommandOf<"workflow"> => command.kind === "workflow",
  async execute(command, context) {
    const steps: PlanStep[] = [];
    let result: Partial<AgentResponse> = {};

    for (const step of command.steps) {
      const outcome = await runStep(step, context);
      steps.push(...outcome.steps.map((planStep) => ({ ...planStep, id: `plan_step_${steps.length + 1}` })));
      result = { ...result, ...Object.fromEntries(Object.entries(outcome.extra).filter(([, value]) => value !== undefined)) };
      if (outcome.extra.lastOrderId) {
        context = { ...context, lastOrderId: outcome.extra.lastOrderId };
      }
    }

    const executionPlan: ExecutionPlan = {
      summary: `Plano com ${steps.length} etapa(s) a partir da solicitacao.`,
      steps
    };
    const lines = steps.map((step, index) => `${index + 1}) ${step.description}: ${STATUS_LABEL[step.status]}${step.detail ? ` (${step.detail})` : ""}`);
    const needsConfirmation = steps.some((step) => step.status === "pending_confirmation");
    return response(`${lines.join("; ")}.${needsConfirmation ? " Confirme o pedido para concluir." : ""}`, {
      ...result,
      executionPlan,
      auditEvents: [audit("workflow", `Plano com ${steps.length} etapa(s) processado.`)]
    });
  }
};

async function runStep(step: WorkflowStep, context: HandlerContext): Promise<{ steps: Omit<PlanStep, "id">[]; extra: Partial<AgentResponse> }> {
  const { gateway } = context;
  if (step.type === "create_customer" || step.type === "create_product" || step.type === "create_supplier") {
    const label = step.type === "create_customer" ? "cliente" : step.type === "create_product" ? "produto" : "fornecedor";
    const description = `Cadastrar ${label} ${step.name}`;
    try {
      const record = step.type === "create_customer"
        ? await gateway.createCustomer({ name: step.name })
        : step.type === "create_product"
          ? await gateway.createProduct({ name: step.name })
          : await gateway.createSupplier({ name: step.name });
      return { steps: [{ action: step.type, description, status: "executed", detail: record.name }], extra: {} };
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        return { steps: [{ action: step.type, description, status: "skipped", detail: "ja existia um cadastro com esse nome" }], extra: {} };
      }
      throw error;
    }
  }

  if (step.type === "prepare_sales_order") {
    const items = step.lines.map((line) => `${line.quantity}x ${line.productQuery}`).join(", ");
    const description = `Preparar pedido${step.customerQuery ? ` para ${step.customerQuery}` : ""}${items ? ` com ${items}` : ""}`;
    if (!step.customerQuery || !step.lines.length) {
      return { steps: [{ action: "prepare_sales_order", description, status: "blocked", detail: "faltou o cliente ou os itens" }], extra: {} };
    }
    const prepared = await prepareSalesOrderProposal(gateway, { ...step, customerQuery: step.customerQuery }, "workflow_prepare_sales_order");
    const extra = { preview: prepared.preview, pendingAction: prepared.pendingAction, clarification: prepared.clarification };
    if (!prepared.pendingAction) {
      const detail = prepared.preview?.warnings.join(" ") || prepared.message.text;
      return { steps: [{ action: "prepare_sales_order", description, status: "blocked", detail }], extra };
    }
    const orderStep: Omit<PlanStep, "id"> = { action: "prepare_sales_order", description, status: "pending_confirmation", detail: null };
    const invoiceStep: Omit<PlanStep, "id"> = { action: "create_invoice", description: "Gerar nota fiscal conceitual", status: "pending_confirmation", detail: "emitida ao confirmar o pedido" };
    return { steps: step.wantsInvoice ? [orderStep, invoiceStep] : [orderStep], extra };
  }

  if (step.type === "create_invoice") {
    const issued = await invoiceHandler.execute({ kind: "invoice.create", salesOrderId: null }, context);
    return {
      steps: [{ action: "create_invoice", description: "Gerar nota fiscal conceitual", status: issued.invoice ? "executed" : "blocked", detail: issued.invoice?.id ?? issued.message.text }],
      extra: { invoice: issued.invoice, lastOrderId: issued.lastOrderId }
    };
  }

  const report = await runIntelligentReport(step.question, context);
  return {
    steps: [{ action: "query_report", description: "Gerar relatorio gerencial", status: "executed", detail: report.intelligentReport?.title ?? null }],
    extra: { intelligentReport: report.intelligentReport }
  };
}
