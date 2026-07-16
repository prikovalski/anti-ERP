import type {
  AgentResponse,
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  ConceptInvoice,
  ConceptInvoiceStatus,
  ListConceptInvoicesInput,
  ListSalesOrdersInput,
  SalesOrder,
  SalesOrderStatus
} from "@anti-erp/shared";
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
  if (asksToListCustomers(input.message)) {
    const gateway = await getCapabilityGateway();
    const customers = await gateway.listCustomers();
    const text = customers.length
      ? `Encontrei ${customers.length} cliente(s): ${customers
          .slice(0, 12)
          .map((customer) => `${customer.name} (${customer.city}, ${customer.status === "active" ? "ativo" : "bloqueado"})`)
          .join("; ")}.`
      : "Nao encontrei clientes cadastrados.";
    return response(text, {
      auditEvents: [audit("list_customers", `Listados ${customers.length} cliente(s).`)]
    });
  }

  const gateway = await getCapabilityGateway();
  const explicitInvoiceCommand = parseExplicitInvoiceCommand(input.message);
  if (explicitInvoiceCommand.action === "create") {
    const salesOrderId = explicitInvoiceCommand.salesOrderId ?? input.lastOrderId ?? null;
    if (!salesOrderId) {
      return response("Qual pedido devo usar para emitir a nota fiscal? Informe o numero do pedido.");
    }
    const invoice = await gateway.createConceptInvoice({ salesOrderId });
    return response(`Nota fiscal conceitual ${invoice.id} emitida para o pedido ${invoice.salesOrderId}.`, {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("create_concept_invoice", `Nota fiscal emitida: ${invoice.id}.`)]
    });
  }
  if (explicitInvoiceCommand.action === "get" && explicitInvoiceCommand.invoiceId) {
    const invoice = await gateway.getConceptInvoice({ invoiceId: explicitInvoiceCommand.invoiceId });
    if (!invoice) {
      return response(`Nao encontrei a nota fiscal ${explicitInvoiceCommand.invoiceId}.`);
    }
    return response(describeInvoice(invoice), {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("get_concept_invoice", `Nota fiscal consultada: ${invoice.id}.`)]
    });
  }
  if (explicitInvoiceCommand.action === "cancel" && explicitInvoiceCommand.invoiceId) {
    const invoice = await gateway.cancelConceptInvoice({ invoiceId: explicitInvoiceCommand.invoiceId });
    return response(`Nota fiscal conceitual ${invoice.id} cancelada.`, {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("cancel_concept_invoice", `Nota fiscal cancelada: ${invoice.id}.`)]
    });
  }
  if (explicitInvoiceCommand.action === "reissue" && explicitInvoiceCommand.invoiceId) {
    const invoice = await gateway.reissueConceptInvoice({ invoiceId: explicitInvoiceCommand.invoiceId });
    return response(`Nota fiscal ${explicitInvoiceCommand.invoiceId} reemitida como ${invoice.id}.`, {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("reissue_concept_invoice", `Nota fiscal reemitida: ${explicitInvoiceCommand.invoiceId} -> ${invoice.id}.`)]
    });
  }
  if (explicitInvoiceCommand.action === "list") {
    const invoices = await gateway.listConceptInvoices(explicitInvoiceCommand.filters);
    return response(formatInvoiceList(invoices, explicitInvoiceCommand.filters), {
      auditEvents: [audit("list_concept_invoices", `Listadas ${invoices.length} nota(s) fiscal(is).`)]
    });
  }

  const explicitOrderCommand = parseExplicitOrderCommand(input.message);

  if (explicitOrderCommand.action === "get" && explicitOrderCommand.salesOrderId) {
    const order = await gateway.getSalesOrder({ salesOrderId: explicitOrderCommand.salesOrderId });
    if (!order) {
      return response(`Nao encontrei o pedido ${explicitOrderCommand.salesOrderId}.`);
    }
    return response(describeOrder(order), {
      order,
      lastOrderId: order.id,
      auditEvents: [audit("get_sales_order", `Pedido consultado: ${order.id}.`)]
    });
  }

  if (explicitOrderCommand.action === "cancel" && explicitOrderCommand.salesOrderId) {
    const order = await gateway.cancelSalesOrder({ salesOrderId: explicitOrderCommand.salesOrderId });
    return response(`Pedido ${order.id} cancelado. O estoque dos itens foi recomposto.`, {
      order,
      lastOrderId: order.id,
      auditEvents: [audit("cancel_sales_order", `Pedido cancelado: ${order.id}.`)]
    });
  }

  if (explicitOrderCommand.action === "duplicate" && explicitOrderCommand.salesOrderId) {
    const order = await gateway.duplicateSalesOrder({ salesOrderId: explicitOrderCommand.salesOrderId });
    return response(`Pedido ${explicitOrderCommand.salesOrderId} duplicado como ${order.id}.`, {
      order,
      lastOrderId: order.id,
      auditEvents: [audit("duplicate_sales_order", `Pedido duplicado: ${explicitOrderCommand.salesOrderId} -> ${order.id}.`)]
    });
  }

  if (explicitOrderCommand.action === "list") {
    const orders = await gateway.listSalesOrders(explicitOrderCommand.filters);
    return response(formatOrderList(orders, explicitOrderCommand.filters), {
      auditEvents: [audit("list_sales_orders", `Listados ${orders.length} pedido(s).`)]
    });
  }

  const intent = parseIntentLocally(input.message);

  if (intent.intent === "list_orders") {
    const filters = inferOrderListFilters(input.message);
    const orders = await gateway.listSalesOrders(filters);
    return response(formatOrderList(orders, filters), {
      auditEvents: [audit("list_sales_orders", `Listados ${orders.length} pedido(s).`)]
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

  if (intent.intent === "create_invoice") {
    const salesOrderId = extractSalesOrderId(input.message) ?? input.lastOrderId ?? null;
    if (!salesOrderId) {
      return response("Qual pedido devo usar para emitir a nota fiscal? Informe o numero do pedido.");
    }
    const invoice = await gateway.createConceptInvoice({ salesOrderId });
    return response(`Nota fiscal conceitual ${invoice.id} emitida para o pedido ${invoice.salesOrderId}.`, {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("create_concept_invoice", `Nota fiscal emitida: ${invoice.id}.`)]
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

  if (
    (intent.intent === "add_item_to_order" ||
      intent.intent === "set_order_item_quantity" ||
      intent.intent === "remove_item_from_order") &&
    intent.productQuery
  ) {
    const salesOrderId = extractSalesOrderId(input.message) ?? input.lastOrderId ?? null;
    if (!salesOrderId) {
      return response("Qual pedido devo alterar? Informe o numero do pedido ou use o pedido criado anteriormente.");
    }

    const products = await gateway.searchProduct({ query: intent.productQuery });
    const product = products[0];
    if (!product) {
      return response(`Nao encontrei o produto ${intent.productQuery}.`);
    }

    const quantity = intent.quantity ?? intent.orderLines?.[0]?.quantity ?? 1;
    const order =
      intent.intent === "add_item_to_order"
        ? await gateway.addSalesOrderLine({ salesOrderId, productId: product.id, quantity: Math.max(quantity, 1) })
        : intent.intent === "set_order_item_quantity"
          ? await gateway.setSalesOrderLineQuantity({ salesOrderId, productId: product.id, quantity })
          : await gateway.removeSalesOrderLine({ salesOrderId, productId: product.id });

    const verb =
      intent.intent === "add_item_to_order"
        ? "adicionado"
        : intent.intent === "set_order_item_quantity"
          ? "atualizado"
          : "removido";
    return response(`Item ${product.name} ${verb} no pedido ${order.id}.`, {
      order,
      lastOrderId: order.id,
      auditEvents: [audit(intent.intent, `Item ${verb} no pedido ${order.id}: ${product.name}.`)]
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

function parseExplicitOrderCommand(message: string): {
  action: "get" | "cancel" | "duplicate" | "list" | null;
  salesOrderId: string | null;
  filters: ListSalesOrdersInput;
} {
  const normalized = normalizeText(message);
  const salesOrderId = extractSalesOrderId(message);
  if (/\b(cancelar|cancele|cancela|cancelamento)\b/.test(normalized) && /\b(pedido|order)\b/.test(normalized)) {
    return { action: "cancel", salesOrderId, filters: {} };
  }
  if (/\b(duplicar|duplique|duplica|copiar|copie)\b/.test(normalized) && /\b(pedido|order)\b/.test(normalized)) {
    return { action: "duplicate", salesOrderId, filters: {} };
  }
  if (salesOrderId && /\b(consulte|consultar|mostre|mostrar|exiba|exibir|detalhe|detalhes|ver)\b/.test(normalized)) {
    return { action: "get", salesOrderId, filters: {} };
  }
  if (asksToListSalesOrders(message)) {
    return { action: "list", salesOrderId: null, filters: inferOrderListFilters(message) };
  }
  return { action: null, salesOrderId, filters: {} };
}

function parseExplicitInvoiceCommand(message: string): {
  action: "create" | "get" | "cancel" | "reissue" | "list" | null;
  invoiceId: string | null;
  salesOrderId: string | null;
  filters: ListConceptInvoicesInput;
} {
  const normalized = normalizeText(message);
  const invoiceId = extractInvoiceId(message);
  const salesOrderId = extractSalesOrderId(message);
  const mentionsInvoice = /\b(nota|notas|nf|nfs|nfe|nfes|fatura|faturas|invoice|invoices)\b/.test(normalized);
  if (!mentionsInvoice) {
    return { action: null, invoiceId, salesOrderId, filters: {} };
  }
  if (/\b(cancelar|cancele|cancela|cancelamento)\b/.test(normalized)) {
    return { action: "cancel", invoiceId, salesOrderId, filters: {} };
  }
  if (/\b(reemitir|reemita|reemita|regerar|regere|segunda via|nova nota)\b/.test(normalized)) {
    return { action: "reissue", invoiceId, salesOrderId, filters: {} };
  }
  if (invoiceId && /\b(consulte|consultar|mostre|mostrar|exiba|exibir|detalhe|detalhes|ver)\b/.test(normalized)) {
    return { action: "get", invoiceId, salesOrderId, filters: {} };
  }
  if (asksToListInvoices(message)) {
    return { action: "list", invoiceId: null, salesOrderId, filters: inferInvoiceListFilters(message) };
  }
  if (/\b(emitir|emita|gerar|gere|criar|crie)\b/.test(normalized) && (salesOrderId || /\bpedido\b/.test(normalized))) {
    return { action: "create", invoiceId, salesOrderId, filters: {} };
  }
  return { action: null, invoiceId, salesOrderId, filters: {} };
}

function extractSalesOrderId(message: string) {
  const match = normalizeText(message).match(/\bso[-_\s]?(\d+)\b/);
  return match ? `SO-${match[1]}` : null;
}

function extractInvoiceId(message: string) {
  const match = normalizeText(message).match(/\bci[-_\s]?(\d+)\b/);
  return match ? `CI-${match[1]}` : null;
}

function asksToListInvoices(message: string) {
  const normalized = normalizeText(message);
  return /\b(liste|listar|mostre|mostrar|exiba|exibir|quais)\b/.test(normalized)
    && /\b(notas|nota|nfs|nf|faturas)\b/.test(normalized);
}

function inferInvoiceListFilters(message: string): ListConceptInvoicesInput {
  const normalized = normalizeText(message);
  return {
    salesOrderId: extractSalesOrderId(message),
    dateRange: inferDateRange(message),
    status: inferInvoiceStatus(normalized),
    take: 25
  };
}

function inferInvoiceStatus(normalized: string): ConceptInvoiceStatus | null {
  if (/\b(cancelada|canceladas|cancelado|cancelados)\b/.test(normalized)) {
    return "canceled";
  }
  if (/\b(reemitida|reemitidas|reemitido|reemitidos|substituida|substituidas)\b/.test(normalized)) {
    return "reissued";
  }
  if (/\b(emitida|emitidas|emitido|emitidos|ativas|ativa)\b/.test(normalized)) {
    return "issued";
  }
  return null;
}

function asksToListSalesOrders(message: string) {
  const normalized = normalizeText(message);
  return /\b(liste|listar|mostre|mostrar|exiba|exibir|quais|pedidos|pedido)\b/.test(normalized)
    && /\bpedidos\b/.test(normalized)
    && !/\bclientes\b/.test(normalized);
}

function inferOrderListFilters(message: string): ListSalesOrdersInput {
  const normalized = normalizeText(message);
  return {
    customerQuery: extractOrderCustomerFilter(message),
    dateRange: inferDateRange(message),
    status: inferOrderStatus(normalized),
    take: 25
  };
}

function inferOrderStatus(normalized: string): SalesOrderStatus | null {
  if (/\b(cancelado|cancelados|cancelada|canceladas)\b/.test(normalized)) {
    return "canceled";
  }
  if (/\b(rascunho|rascunhos|draft)\b/.test(normalized)) {
    return "draft";
  }
  if (/\b(confirmado|confirmados|confirmada|confirmadas|emitido|emitidos)\b/.test(normalized)) {
    return "confirmed";
  }
  return null;
}

function extractOrderCustomerFilter(message: string) {
  const match = message.match(
    /\b(?:cliente|clientes|para|da|do)\s+(.+?)(?=\s+(?:hoje|ontem|semana|mes|m[eê]s|confirmad|cancelad|rascunho|status|criados|recentes)\b|[.!?]?$)/i
  );
  if (!match?.[1]) {
    return null;
  }
  const value = match[1]
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:o|a|os|as|cliente|clientes)\s+/i, "")
    .replace(/[.!?]+$/g, "");
  return value || null;
}

function formatOrderList(orders: SalesOrder[], filters: ListSalesOrdersInput) {
  if (!orders.length) {
    return "Nao encontrei pedidos para esses filtros.";
  }
  const scope = [
    filters.customerQuery ? `cliente ${filters.customerQuery}` : null,
    filters.status ? `status ${translateStatus(filters.status)}` : null,
    filters.dateRange && filters.dateRange !== "all_time" ? translateDateRange(filters.dateRange) : null
  ].filter(Boolean).join(", ");
  const prefix = scope ? `Encontrei ${orders.length} pedido(s) para ${scope}` : `Encontrei ${orders.length} pedido(s)`;
  return `${prefix}: ${orders
    .slice(0, 8)
    .map((order) => `${order.id} para ${order.customer.name} (${translateStatus(order.status)}, ${order.lines.length} item(ns), total ${formatMoney(order.subtotal)})`)
    .join("; ")}.`;
}

function describeOrder(order: SalesOrder) {
  const items = order.lines
    .map((line) => `${line.quantity}x ${line.name} (${formatMoney(line.total)})`)
    .join("; ");
  return `Pedido ${order.id} para ${order.customer.name}: ${translateStatus(order.status)}, ${items}, total ${formatMoney(order.subtotal)}.`;
}

function formatInvoiceList(invoices: ConceptInvoice[], filters: ListConceptInvoicesInput) {
  if (!invoices.length) {
    return "Nao encontrei notas fiscais para esses filtros.";
  }
  const scope = [
    filters.salesOrderId ? `pedido ${filters.salesOrderId}` : null,
    filters.status ? `status ${translateInvoiceStatus(filters.status)}` : null,
    filters.dateRange && filters.dateRange !== "all_time" ? translateDateRange(filters.dateRange) : null
  ].filter(Boolean).join(", ");
  const prefix = scope ? `Encontrei ${invoices.length} nota(s) fiscal(is) para ${scope}` : `Encontrei ${invoices.length} nota(s) fiscal(is)`;
  return `${prefix}: ${invoices
    .slice(0, 8)
    .map((invoice) =>
      `${invoice.id} do pedido ${invoice.salesOrderId} para ${invoice.customerName} (${translateInvoiceStatus(invoice.status)}, valor ${formatMoney(invoice.amount)}, ${invoice.orderChangedAfterIssue ? "pedido alterado apos emissao" : "pedido sem alteracao"})`
    )
    .join("; ")}.`;
}

function describeInvoice(invoice: ConceptInvoice) {
  const changed = invoice.orderChangedAfterIssue ? " O pedido foi alterado apos a emissao; reemissao recomendada." : "";
  return `Nota fiscal ${invoice.id} do pedido ${invoice.salesOrderId}: ${translateInvoiceStatus(invoice.status)}, cliente ${invoice.customerName}, valor ${formatMoney(invoice.amount)}, emitida em ${formatDate(invoice.issuedAt)}.${changed}`;
}

function translateInvoiceStatus(status: ConceptInvoiceStatus) {
  return status === "canceled" ? "cancelada" : status === "reissued" ? "reemitida" : "emitida";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function translateStatus(status: SalesOrderStatus) {
  return status === "canceled" ? "cancelado" : status === "draft" ? "rascunho" : "confirmado";
}

function translateDateRange(dateRange: AnalyticsDateRange) {
  return dateRange === "today"
    ? "hoje"
    : dateRange === "last_7_days"
      ? "ultimos 7 dias"
      : dateRange === "month_to_date"
        ? "mes atual"
        : "todo o periodo";
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

function asksToListCustomers(message: string) {
  const normalized = normalizeText(message);
  return /\b(liste|listar|mostre|mostrar|exiba|exibir|quais|clientes|cliente)\b/.test(normalized)
    && /\bclientes\b/.test(normalized)
    && !/\bcompraram|comprou|venderam|vendeu|faturamento|receita|pedido|pedidos\b/.test(normalized);
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inferDateRange(message: string): AnalyticsDateRange {
  const normalized = normalizeText(message);
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
