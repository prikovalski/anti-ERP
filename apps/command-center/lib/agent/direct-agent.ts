import type { AgentResponse, AnalyticsDateRange, AnalyticsGroupBy, AnalyticsMetric } from "@anti-erp/shared";
import { getCapabilityGateway } from "../capabilities";
import { parseIntentLocally } from "./intent-parser";

function id(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function audit(action: string, summary: string): AgentResponse["auditEvents"][number] {
  return {
    id: id(action),
    timestamp: new Date().toISOString(),
    actor: "agent",
    action,
    summary
  };
}

function response(text: string, extra: Partial<AgentResponse> = {}): AgentResponse {
  return {
    message: {
      id: id("agent"),
      role: "agent",
      text
    },
    auditEvents: extra.auditEvents ?? [audit("direct_agent_response", "Resposta gerada pelo executor direto local.")],
    mode: "langgraph",
    ...extra
  };
}

export async function runDirectAgent(input: { message: string; lastOrderId?: string | null }): Promise<AgentResponse> {
  const intent = parseIntentLocally(input.message);
  const gateway = await getCapabilityGateway();

  if (intent.intent === "list_orders") {
    const orders = await gateway.listRecentOrders();
    const text = orders.length
      ? `Encontrei ${orders.length} pedido(s) recente(s): ${orders
          .slice(0, 6)
          .map((order) => `${order.id} para ${order.customer.name} (${order.lines.length} item(ns), total ${formatMoney(order.subtotal)})`)
          .join("; ")}.`
      : "Nao encontrei pedidos recentes.";
    return response(text, {
      auditEvents: [audit("list_recent_orders", `Listados ${orders.length} pedido(s) recente(s).`)]
    });
  }

  if (intent.intent === "analytics_query") {
    const analytics = intent.analytics;
    const result = await gateway.querySalesMetrics({
      metric: analytics?.metric ?? inferMetric(input.message),
      productQuery: intent.productQuery,
      productQueries: analytics?.productQueries ?? null,
      customerQuery: intent.customerQuery,
      dateRange: analytics?.dateRange ?? inferDateRange(input.message),
      groupBy: analytics?.groupBy ?? inferGroupBy(input.message)
    });
    return response(`${result.label}: ${formatAnalyticsValue(result.metric, result.value)}.`, {
      analyticsResult: result,
      auditEvents: [audit("query_sales_metrics", "Relatorio gerencial executado pelo gateway direto.")]
    });
  }

  if (intent.intent === "inventory_diagnostic") {
    const products = await gateway.listLowStockProducts({ threshold: 10 });
    const text = products.length
      ? `Produtos com estoque baixo: ${products.map((product) => `${product.name} (${product.availableStock})`).join(", ")}.`
      : "Nenhum produto esta com estoque baixo.";
    return response(text, {
      auditEvents: [audit("list_low_stock_products", `Encontrados ${products.length} produto(s) com estoque baixo.`)]
    });
  }

  if (intent.intent === "create_customer" || intent.intent === "create_product" || intent.intent === "create_supplier") {
    const name = intent.catalogName?.trim();
    if (!name) {
      return response("Qual nome devo cadastrar?");
    }
    const record =
      intent.intent === "create_customer"
        ? await gateway.createCustomer({ name })
        : intent.intent === "create_product"
          ? await gateway.createProduct({ name })
          : await gateway.createSupplier({ name });
    return response(`${name} cadastrado com sucesso.`, {
      auditEvents: [audit(intent.intent, `Cadastro criado: ${"name" in record ? record.name : name}.`)]
    });
  }

  if (intent.intent === "update_product" && intent.productUpdate?.productQuery) {
    const matches = await gateway.searchProduct({ query: intent.productUpdate.productQuery });
    const product = matches[0];
    if (!product) {
      return response(`Nao encontrei o produto ${intent.productUpdate.productQuery}.`);
    }
    const updated = await gateway.updateProduct({
      productId: product.id,
      unitPrice: intent.productUpdate.unitPrice,
      availableStock: intent.productUpdate.availableStock
    });
    return response(`Produto ${updated.name} atualizado com sucesso.`, {
      auditEvents: [audit("update_product", `Produto atualizado: ${updated.name}.`)]
    });
  }

  if ((intent.intent === "create_order" || intent.intent === "create_order_with_invoice") && intent.customerQuery && intent.orderLines?.length) {
    const customers = await gateway.searchCustomer({ query: intent.customerQuery });
    const customer = customers[0];
    if (!customer) {
      return response(`Nao encontrei o cliente ${intent.customerQuery}.`);
    }

    const lines = [];
    for (const line of intent.orderLines) {
      const products = await gateway.searchProduct({ query: line.productQuery });
      const product = products[0];
      if (!product) {
        return response(`Nao encontrei o produto ${line.productQuery}.`);
      }
      lines.push({ productId: product.id, quantity: line.quantity });
    }

    const preview = await gateway.prepareSalesOrder({
      customerId: customer.id,
      lines
    });
    return response(`Preparei o pedido para ${customer.name}. Confira os itens e confirme para gravar.`, {
      preview,
      auditEvents: [audit("prepare_sales_order", `Pedido preparado para ${customer.name}.`)]
    });
  }

  return response("Nao consegui executar esse comando pelo executor local. Tente ser mais especifica.");
}

function inferMetric(message: string): AnalyticsMetric {
  const normalized = message.toLowerCase();
  if (normalized.includes("faturamento") || normalized.includes("receita") || normalized.includes("valor")) {
    return "revenue";
  }
  if (normalized.includes("pedido")) {
    return "order_count";
  }
  return "units_sold";
}

function inferDateRange(message: string): AnalyticsDateRange {
  const normalized = message.toLowerCase();
  if (normalized.includes("hoje")) {
    return "today";
  }
  if (normalized.includes("semana")) {
    return "last_7_days";
  }
  if (normalized.includes("mes")) {
    return "month_to_date";
  }
  return "all_time";
}

function inferGroupBy(message: string): AnalyticsGroupBy | null {
  const normalized = message.toLowerCase();
  if (normalized.includes("cliente")) {
    return "customer";
  }
  if (normalized.includes("produto") || normalized.includes("produtos")) {
    return "product";
  }
  if (normalized.includes("dia")) {
    return "day";
  }
  return null;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}

function formatAnalyticsValue(metric: AnalyticsMetric, value: number) {
  return metric === "revenue" ? formatMoney(value) : String(value);
}
