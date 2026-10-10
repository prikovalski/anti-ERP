import { translateDateRange, type AnalyticsResult } from "@anti-erp/shared";
import { buildClarifyingFallbackQuestion } from "../clarifying-fallback";
import { formatMoney } from "../agent-messages";
import type { CommandOf } from "../nlu/commands";
import { audit, clarificationResponse, response } from "../responses";
import type { AgentHandler, HandlerContext } from "./types";

type AnalyticsCommand = CommandOf<"report.intelligent" | "report.metrics" | "report.clarify" | "info.traditional_flow">;

export const analyticsHandler: AgentHandler<AnalyticsCommand> = {
  name: "analytics",
  match: (command): command is AnalyticsCommand => command.kind.startsWith("report.") || command.kind === "info.traditional_flow",
  async execute(command, context) {
    switch (command.kind) {
      case "report.intelligent":
        return runIntelligentReport(command.question, context);
      case "report.metrics":
        return metrics(command, context);
      case "report.clarify":
        return clarificationResponse(buildClarifyingFallbackQuestion(context.message), "Relatorio sem metrica definida.");
      case "info.traditional_flow":
        return traditionalFlow(context);
    }
  }
};

export async function runIntelligentReport(question: string, { gateway }: HandlerContext) {
  const report = await gateway.queryIntelligentReport({ question });
  if (report.plan.needsClarification && report.plan.clarificationQuestion) {
    return response(report.plan.clarificationQuestion, {
      intelligentReport: report,
      auditEvents: [audit("clarification_required", "Agente pediu esclarecimento para relatorio gerencial inteligente.")]
    });
  }
  const insight = report.insights[0] ? ` ${report.insights[0]}` : "";
  return response(`${report.title}: ${report.summary}${insight}`, {
    intelligentReport: report,
    auditEvents: [audit("query_intelligent_report", `Relatorio inteligente executado: ${report.title}.`)]
  });
}

async function metrics(command: CommandOf<"report.metrics">, { gateway }: HandlerContext) {
  const result = await gateway.querySalesMetrics({
    metric: command.metric,
    productQuery: command.productQuery,
    productQueries: command.productQueries,
    customerQuery: command.customerQuery,
    dateRange: command.dateRange,
    groupBy: command.groupBy
  });
  return response(`${describeMetric(result)}: ${result.metric === "revenue" ? formatMoney(result.value) : result.value}.`, {
    analyticsResult: result,
    auditEvents: [audit("query_sales_metrics", "Metrica de vendas consultada.")]
  });
}

async function traditionalFlow({ gateway }: HandlerContext) {
  const flow = await gateway.getTraditionalErpFlow();
  return response(
    `ERP tradicional (${flow.traditional.length} passos): ${flow.traditional.join(" -> ")}. anti-ERP (${flow.antiErp.length} passos): ${flow.antiErp.join(" -> ")}.`,
    { auditEvents: [audit("get_traditional_erp_flow", "Comparacao entre o fluxo tradicional e o anti-ERP.")] }
  );
}

/** Portuguese label built from the query the gateway actually ran. */
function describeMetric(result: AnalyticsResult) {
  const metric = result.metric === "revenue" ? "Faturamento" : result.metric === "order_count" ? "Pedidos" : "Unidades vendidas";
  const filter = (label: string) => result.query.filters.find((candidate) => candidate.label === label)?.value ?? null;
  const products = filter("products") ?? filter("product");
  const customer = filter("customer");
  const scope = [products ? `de ${products}` : null, customer ? `do cliente ${customer}` : null].filter(Boolean).join(" ");
  return `${metric}${scope ? ` ${scope}` : ""} (${translateDateRange(result.query.dateRange)})`;
}
