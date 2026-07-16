import type {
  AgentResponse,
  AnalyticsDateRange,
  AnalyticsGroupBy,
  AnalyticsMetric,
  ConceptInvoice,
  ConceptInvoiceStatus,
  Customer,
  InventoryMovement,
  ListConceptInvoicesInput,
  ListInventoryMovementsInput,
  ListSalesOrdersInput,
  ManagerialReport,
  ManagerialReportKind,
  Product,
  SalesOrder,
  SalesOrderStatus,
  Supplier
} from "@anti-erp/shared";
import { getCapabilityGateway } from "../capabilities";
import { recordAgentStep } from "../observability/mcp-trace";
import { createObservedCapabilityGateway } from "../observability/observed-gateway";
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
  await recordDirectDecision("direct_agent_start", {
    messageLength: input.message.length,
    hasLastOrderId: Boolean(input.lastOrderId)
  });
  const gateway = createObservedCapabilityGateway(await getCapabilityGateway(), "capability");
  if (isManagerialReportRequest(input.message)) {
    await recordDirectDecision("direct_route_selected", {
      route: "managerial_report",
      kind: inferManagerialReportKind(input.message)
    });
    const report = await gateway.queryManagerialReport({
      question: input.message,
      kind: inferManagerialReportKind(input.message),
      dateRange: inferDateRange(input.message),
      groupBy: inferGroupBy(input.message),
      take: 10
    });
    return response(formatManagerialReportAnswer(report), {
      managerialReport: report,
      auditEvents: [audit("query_managerial_report", `Relatorio gerencial executado: ${report.kind}.`)]
    });
  }

  if (asksToListCustomers(input.message)) {
    await recordDirectDecision("direct_route_selected", {
      route: "catalog_list",
      catalogKind: "customer"
    });
    const status = inferCatalogStatus(normalizeText(input.message));
    const customers = await gateway.searchCustomersAdvanced({ status, take: 25 });
    return response(formatCustomerList(customers), {
      auditEvents: [audit("search_customers_advanced", `Listados ${customers.length} cliente(s).`)]
    });
  }

  const explicitCatalogCommand = parseExplicitCatalogCommand(input.message);
  if (explicitCatalogCommand.action === "list") {
    await recordDirectDecision("direct_route_selected", {
      route: "explicit_catalog",
      action: explicitCatalogCommand.action,
      catalogKind: explicitCatalogCommand.kind
    });
    if (explicitCatalogCommand.kind === "product") {
      const products = await gateway.listProducts({ query: explicitCatalogCommand.query, status: explicitCatalogCommand.status, take: 25 });
      return response(formatProductList(products), {
        auditEvents: [audit("list_products", `Listados ${products.length} produto(s).`)]
      });
    }
    if (explicitCatalogCommand.kind === "supplier") {
      const suppliers = await gateway.listSuppliers({ query: explicitCatalogCommand.query, status: explicitCatalogCommand.status, take: 25 });
      return response(formatSupplierList(suppliers), {
        auditEvents: [audit("list_suppliers", `Listados ${suppliers.length} fornecedor(es).`)]
      });
    }
    if (explicitCatalogCommand.kind === "customer") {
      const customers = await gateway.searchCustomersAdvanced({ query: explicitCatalogCommand.query, status: explicitCatalogCommand.status, take: 25 });
      return response(formatCustomerList(customers), {
        auditEvents: [audit("search_customers_advanced", `Listados ${customers.length} cliente(s).`)]
      });
    }
  }

  if (explicitCatalogCommand.action === "set_status" && explicitCatalogCommand.query && explicitCatalogCommand.status) {
    await recordDirectDecision("direct_route_selected", {
      route: "explicit_catalog",
      action: explicitCatalogCommand.action,
      catalogKind: explicitCatalogCommand.kind,
      status: explicitCatalogCommand.status
    });
    if (explicitCatalogCommand.kind === "product") {
      const product = (await gateway.searchProduct({ query: explicitCatalogCommand.query }))[0];
      if (!product) return response(`Nao encontrei o produto ${explicitCatalogCommand.query}.`);
      const updated = await gateway.updateProduct({ productId: product.id, status: explicitCatalogCommand.status === "active" ? "active" : "inactive" });
      return response(`Produto ${updated.name} ${updated.status === "active" ? "ativado" : "inativado"} com sucesso.`, {
        auditEvents: [audit("update_product", `Status atualizado: ${updated.name}.`)]
      });
    }
    if (explicitCatalogCommand.kind === "supplier") {
      const supplier = (await gateway.searchSupplier({ query: explicitCatalogCommand.query }))[0];
      if (!supplier) return response(`Nao encontrei o fornecedor ${explicitCatalogCommand.query}.`);
      const updated = await gateway.updateSupplier({ supplierId: supplier.id, status: explicitCatalogCommand.status });
      return response(`Fornecedor ${updated.name} ${updated.status === "active" ? "ativado" : "inativado"} com sucesso.`, {
        auditEvents: [audit("update_supplier", `Status atualizado: ${updated.name}.`)]
      });
    }
    if (explicitCatalogCommand.kind === "customer") {
      const customer = (await gateway.searchCustomer({ query: explicitCatalogCommand.query }))[0];
      if (!customer) return response(`Nao encontrei o cliente ${explicitCatalogCommand.query}.`);
      const updated = await gateway.updateCustomer({ customerId: customer.id, status: explicitCatalogCommand.status });
      return response(`Cliente ${updated.name} ${updated.status === "active" ? "ativado" : "inativado"} com sucesso.`, {
        auditEvents: [audit("update_customer", `Status atualizado: ${updated.name}.`)]
      });
    }
  }

  if (explicitCatalogCommand.action === "rename" && explicitCatalogCommand.query && explicitCatalogCommand.nextName) {
    await recordDirectDecision("direct_route_selected", {
      route: "explicit_catalog",
      action: explicitCatalogCommand.action,
      catalogKind: explicitCatalogCommand.kind
    });
    if (explicitCatalogCommand.kind === "product") {
      const product = (await gateway.searchProduct({ query: explicitCatalogCommand.query }))[0];
      if (!product) return response(`Nao encontrei o produto ${explicitCatalogCommand.query}.`);
      const updated = await gateway.updateProduct({ productId: product.id, name: explicitCatalogCommand.nextName });
      return response(`Produto renomeado para ${updated.name}.`, { auditEvents: [audit("update_product", `Produto renomeado: ${updated.name}.`)] });
    }
    if (explicitCatalogCommand.kind === "supplier") {
      const supplier = (await gateway.searchSupplier({ query: explicitCatalogCommand.query }))[0];
      if (!supplier) return response(`Nao encontrei o fornecedor ${explicitCatalogCommand.query}.`);
      const updated = await gateway.updateSupplier({ supplierId: supplier.id, name: explicitCatalogCommand.nextName });
      return response(`Fornecedor renomeado para ${updated.name}.`, { auditEvents: [audit("update_supplier", `Fornecedor renomeado: ${updated.name}.`)] });
    }
    if (explicitCatalogCommand.kind === "customer") {
      const customer = (await gateway.searchCustomer({ query: explicitCatalogCommand.query }))[0];
      if (!customer) return response(`Nao encontrei o cliente ${explicitCatalogCommand.query}.`);
      const updated = await gateway.updateCustomer({ customerId: customer.id, name: explicitCatalogCommand.nextName });
      return response(`Cliente renomeado para ${updated.name}.`, { auditEvents: [audit("update_customer", `Cliente renomeado: ${updated.name}.`)] });
    }
  }

  const explicitInventoryCommand = parseExplicitInventoryCommand(input.message);
  if (explicitInventoryCommand.action) {
    await recordDirectDecision("direct_route_selected", {
      route: "inventory",
      action: explicitInventoryCommand.action,
      hasProductQuery: Boolean(explicitInventoryCommand.productQuery),
      hasSalesOrderId: Boolean(explicitInventoryCommand.salesOrderId)
    });
    if (explicitInventoryCommand.action === "low_stock") {
      const products = await gateway.listLowStockProducts({ threshold: explicitInventoryCommand.threshold ?? 10 });
      const text = products.length
        ? `Produtos com estoque baixo: ${products.map((product) => `${product.name} (${product.sku}, disponivel ${product.availableStock}, reservado ${product.reservedStock ?? 0})`).join("; ")}.`
        : "Nenhum produto esta com estoque baixo.";
      return response(text, {
        auditEvents: [audit("list_low_stock_products", `Encontrados ${products.length} produto(s) com estoque baixo.`)]
      });
    }

    if (explicitInventoryCommand.action === "history") {
      const product = explicitInventoryCommand.productQuery
        ? await resolveProductByQuery(gateway, explicitInventoryCommand.productQuery)
        : null;
      if (explicitInventoryCommand.productQuery && !product) {
        return response(`Nao encontrei o produto ${explicitInventoryCommand.productQuery}.`);
      }
      const filters: ListInventoryMovementsInput = {
        productId: product?.id ?? null,
        salesOrderId: explicitInventoryCommand.salesOrderId,
        type: explicitInventoryCommand.type,
        dateRange: inferDateRange(input.message),
        take: 25
      };
      const movements = await gateway.listInventoryMovements(filters);
      return response(formatInventoryMovementList(movements, filters), {
        auditEvents: [audit("list_inventory_movements", `Listadas ${movements.length} movimentacao(oes) de estoque.`)]
      });
    }

    if (explicitInventoryCommand.action === "writeoff") {
      const salesOrderId = explicitInventoryCommand.salesOrderId ?? input.lastOrderId ?? null;
      if (!salesOrderId) {
        return response("Qual pedido devo usar para baixar o estoque?");
      }
      const order = await gateway.getSalesOrder({ salesOrderId });
      if (!order) {
        return response(`Nao encontrei o pedido ${salesOrderId}.`);
      }
      let movements: InventoryMovement[];
      try {
        movements = await gateway.writeOffInventoryForSalesOrder({
          salesOrderId,
          reason: `Baixa por pedido ${salesOrderId}`
        });
      } catch (error) {
        return response(formatInventoryError(error));
      }
      return response(`Baixa de estoque realizada para o pedido ${salesOrderId}: ${formatInventoryMovementItems(movements)}.`, {
        lastOrderId: salesOrderId,
        auditEvents: [audit("inventory_order_writeoff", `Baixa por pedido executada: ${salesOrderId}.`)]
      });
    }

    if (!explicitInventoryCommand.productQuery) {
      return response("Qual produto devo movimentar no estoque?");
    }
    const product = await resolveProductByQuery(gateway, explicitInventoryCommand.productQuery);
    if (!product) {
      return response(`Nao encontrei o produto ${explicitInventoryCommand.productQuery}.`);
    }
    if (explicitInventoryCommand.quantity == null) {
      return response(`Qual quantidade devo usar para movimentar o estoque de ${product.name}?`);
    }

    const reason = explicitInventoryReason(explicitInventoryCommand.action, input.message);
    let movement: InventoryMovement;
    try {
      movement =
        explicitInventoryCommand.action === "entry"
          ? await gateway.createInventoryEntry({ productId: product.id, quantity: explicitInventoryCommand.quantity, reason })
          : explicitInventoryCommand.action === "exit"
            ? await gateway.createInventoryExit({ productId: product.id, quantity: explicitInventoryCommand.quantity, reason })
            : explicitInventoryCommand.action === "adjustment"
              ? await gateway.adjustInventory({ productId: product.id, quantity: explicitInventoryCommand.quantity, reason })
              : explicitInventoryCommand.action === "reservation"
                ? await gateway.reserveInventory({
                  productId: product.id,
                  quantity: explicitInventoryCommand.quantity,
                  salesOrderId: explicitInventoryCommand.salesOrderId ?? input.lastOrderId ?? null,
                  reason
                })
                : await gateway.releaseInventoryReservation({
                  productId: product.id,
                  quantity: explicitInventoryCommand.quantity,
                  salesOrderId: explicitInventoryCommand.salesOrderId ?? input.lastOrderId ?? null,
                  reason
                });
    } catch (error) {
      return response(formatInventoryError(error));
    }
    return response(formatInventoryMovement(movement), {
      lastOrderId: explicitInventoryCommand.salesOrderId ?? input.lastOrderId ?? null,
      auditEvents: [audit(`inventory_${explicitInventoryCommand.action}`, `Estoque movimentado: ${product.name}.`)]
    });
  }

  const explicitInvoiceCommand = parseExplicitInvoiceCommand(input.message);
  if (explicitInvoiceCommand.action === "create") {
    await recordDirectDecision("direct_route_selected", {
      route: "invoice",
      action: explicitInvoiceCommand.action,
      hasSalesOrderId: Boolean(explicitInvoiceCommand.salesOrderId ?? input.lastOrderId)
    });
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
    await recordDirectDecision("direct_route_selected", {
      route: "invoice",
      action: explicitInvoiceCommand.action,
      invoiceId: explicitInvoiceCommand.invoiceId
    });
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
    await recordDirectDecision("direct_route_selected", {
      route: "invoice",
      action: explicitInvoiceCommand.action,
      invoiceId: explicitInvoiceCommand.invoiceId
    });
    const invoice = await gateway.cancelConceptInvoice({ invoiceId: explicitInvoiceCommand.invoiceId });
    return response(`Nota fiscal conceitual ${invoice.id} cancelada.`, {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("cancel_concept_invoice", `Nota fiscal cancelada: ${invoice.id}.`)]
    });
  }
  if (explicitInvoiceCommand.action === "reissue" && explicitInvoiceCommand.invoiceId) {
    await recordDirectDecision("direct_route_selected", {
      route: "invoice",
      action: explicitInvoiceCommand.action,
      invoiceId: explicitInvoiceCommand.invoiceId
    });
    const invoice = await gateway.reissueConceptInvoice({ invoiceId: explicitInvoiceCommand.invoiceId });
    return response(`Nota fiscal ${explicitInvoiceCommand.invoiceId} reemitida como ${invoice.id}.`, {
      invoice,
      lastOrderId: invoice.salesOrderId,
      auditEvents: [audit("reissue_concept_invoice", `Nota fiscal reemitida: ${explicitInvoiceCommand.invoiceId} -> ${invoice.id}.`)]
    });
  }
  if (explicitInvoiceCommand.action === "list") {
    await recordDirectDecision("direct_route_selected", {
      route: "invoice",
      action: explicitInvoiceCommand.action
    });
    const invoices = await gateway.listConceptInvoices(explicitInvoiceCommand.filters);
    return response(formatInvoiceList(invoices, explicitInvoiceCommand.filters), {
      auditEvents: [audit("list_concept_invoices", `Listadas ${invoices.length} nota(s) fiscal(is).`)]
    });
  }

  const explicitOrderCommand = parseExplicitOrderCommand(input.message);

  if (explicitOrderCommand.action === "get" && explicitOrderCommand.salesOrderId) {
    await recordDirectDecision("direct_route_selected", {
      route: "sales_order",
      action: explicitOrderCommand.action,
      salesOrderId: explicitOrderCommand.salesOrderId
    });
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
    await recordDirectDecision("direct_route_selected", {
      route: "sales_order",
      action: explicitOrderCommand.action,
      salesOrderId: explicitOrderCommand.salesOrderId
    });
    const order = await gateway.cancelSalesOrder({ salesOrderId: explicitOrderCommand.salesOrderId });
    return response(`Pedido ${order.id} cancelado. O estoque dos itens foi recomposto.`, {
      order,
      lastOrderId: order.id,
      auditEvents: [audit("cancel_sales_order", `Pedido cancelado: ${order.id}.`)]
    });
  }

  if (explicitOrderCommand.action === "duplicate" && explicitOrderCommand.salesOrderId) {
    await recordDirectDecision("direct_route_selected", {
      route: "sales_order",
      action: explicitOrderCommand.action,
      salesOrderId: explicitOrderCommand.salesOrderId
    });
    const order = await gateway.duplicateSalesOrder({ salesOrderId: explicitOrderCommand.salesOrderId });
    return response(`Pedido ${explicitOrderCommand.salesOrderId} duplicado como ${order.id}.`, {
      order,
      lastOrderId: order.id,
      auditEvents: [audit("duplicate_sales_order", `Pedido duplicado: ${explicitOrderCommand.salesOrderId} -> ${order.id}.`)]
    });
  }

  if (explicitOrderCommand.action === "list") {
    await recordDirectDecision("direct_route_selected", {
      route: "sales_order",
      action: explicitOrderCommand.action
    });
    const orders = await gateway.listSalesOrders(explicitOrderCommand.filters);
    return response(formatOrderList(orders, explicitOrderCommand.filters), {
      auditEvents: [audit("list_sales_orders", `Listados ${orders.length} pedido(s).`)]
    });
  }

  const intent = parseIntentLocally(input.message);
  await recordDirectDecision("direct_parse_local_intent", {
    intent: intent.intent,
    confidence: intent.confidence,
    hasCustomerQuery: Boolean(intent.customerQuery),
    lineCount: intent.orderLines?.length ?? 0
  });

  if (intent.intent === "list_orders") {
    await recordDirectDecision("direct_route_selected", {
      route: "list_orders",
      intent: intent.intent
    });
    const filters = inferOrderListFilters(input.message);
    const orders = await gateway.listSalesOrders(filters);
    return response(formatOrderList(orders, filters), {
      auditEvents: [audit("list_sales_orders", `Listados ${orders.length} pedido(s).`)]
    });
  }

  if (intent.intent === "analytics_query") {
    await recordDirectDecision("direct_route_selected", {
      route: isManagerialReportRequest(input.message) ? "managerial_report" : "analytics",
      intent: intent.intent,
      metric: intent.analytics?.metric ?? inferMetric(input.message)
    });
    if (isManagerialReportRequest(input.message)) {
      const report = await gateway.queryManagerialReport({
        question: input.message,
        kind: inferManagerialReportKind(input.message),
        dateRange: intent.analytics?.dateRange ?? inferDateRange(input.message),
        groupBy: intent.analytics?.groupBy ?? inferGroupBy(input.message),
        take: 10
      });
      return response(formatManagerialReportAnswer(report), {
        managerialReport: report,
        auditEvents: [audit("query_managerial_report", `Relatorio gerencial executado: ${report.kind}.`)]
      });
    }
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
    await recordDirectDecision("direct_route_selected", {
      route: "invoice",
      intent: intent.intent
    });
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
    await recordDirectDecision("direct_route_selected", {
      route: "inventory_diagnostic",
      intent: intent.intent
    });
    const products = await gateway.listLowStockProducts({ threshold: 10 });
    const text = products.length
      ? `Produtos com estoque baixo: ${products.map((product) => `${product.name} (${product.availableStock})`).join(", ")}.`
      : "Nenhum produto esta com estoque baixo.";
    return response(text, {
      auditEvents: [audit("list_low_stock_products", `Encontrados ${products.length} produto(s) com estoque baixo.`)]
    });
  }

  if (intent.intent === "create_customer" || intent.intent === "create_product" || intent.intent === "create_supplier") {
    await recordDirectDecision("direct_route_selected", {
      route: "catalog_create",
      intent: intent.intent
    });
    const name = intent.catalogName?.trim();
    if (!name) {
      return response("Qual nome devo cadastrar?");
    }
    try {
      const record =
        intent.intent === "create_customer"
          ? await gateway.createCustomer({ name })
          : intent.intent === "create_product"
            ? await gateway.createProduct({ name })
            : await gateway.createSupplier({ name });
      return response(`${name} cadastrado com sucesso.`, {
        auditEvents: [audit(intent.intent, `Cadastro criado: ${"name" in record ? record.name : name}.`)]
      });
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        await recordAgentStep({
          name: "direct_controlled_error.duplicate_catalog",
          kind: "error",
          status: "error",
          durationMs: 0,
          inputs: { intent: intent.intent, name },
          error
        });
        return response(`Nao cadastrei ${name}, porque ja existe um cadastro com exatamente esse nome.`);
      }
      throw error;
    }
  }

  if (intent.intent === "update_product" && intent.productUpdate?.productQuery) {
    await recordDirectDecision("direct_route_selected", {
      route: "product_update",
      intent: intent.intent
    });
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
    await recordDirectDecision("direct_route_selected", {
      route: "order_update",
      intent: intent.intent,
      productQuery: intent.productQuery
    });
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
    await recordDirectDecision("direct_route_selected", {
      route: "sales_order_preview",
      intent: intent.intent,
      customerQuery: intent.customerQuery,
      lineCount: intent.orderLines.length
    });
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

  await recordDirectDecision("direct_route_selected", {
    route: "unknown",
    intent: intent.intent
  });
  return response("Nao consegui executar esse comando pelo executor local. Tente ser mais especifica.");
}

async function recordDirectDecision(name: string, outputs: Record<string, unknown>) {
  await recordAgentStep({
    name,
    kind: "decision",
    status: "success",
    durationMs: 0,
    outputs
  });
}

function parseExplicitInventoryCommand(message: string): {
  action: "entry" | "exit" | "adjustment" | "reservation" | "reservation_release" | "writeoff" | "history" | "low_stock" | null;
  productQuery: string | null;
  quantity: number | null;
  salesOrderId: string | null;
  threshold: number | null;
  type: InventoryMovement["type"] | null;
} {
  const normalized = normalizeText(message);
  const salesOrderId = extractSalesOrderId(message);
  const mentionsInventory =
    /\b(estoque|estoques|entrada|saida|ajuste|ajustar|reserve|reservar|reserva|reservado|libere|liberar|baixa|baixar|baixe|historico|movimentacoes)\b/.test(normalized);
  if (!mentionsInventory) {
    return { action: null, productQuery: null, quantity: null, salesOrderId, threshold: null, type: null };
  }

  const quantity = extractInventoryQuantity(message);
  const productQuery = extractInventoryProductQuery(message);
  const threshold = extractThreshold(message);
  const type = inferInventoryMovementType(normalized);

  if (/\b(baixo|baixa|minimo|minima|critico|critica|alerta)\b/.test(normalized) && /\bestoque\b/.test(normalized)) {
    return { action: "low_stock", productQuery: null, quantity: null, salesOrderId, threshold, type: null };
  }
  if (/\b(historico|movimentacoes|movimentos|extrato|liste|listar|mostre|mostrar|consultar|consulte)\b/.test(normalized)
    && /\b(estoque|movimentacoes|movimentos)\b/.test(normalized)) {
    return { action: "history", productQuery, quantity: null, salesOrderId, threshold: null, type };
  }
  if (/\b(baixa|baixar|baixe)\b/.test(normalized) && /\bpedido\b/.test(normalized)) {
    return { action: "writeoff", productQuery: null, quantity: null, salesOrderId, threshold: null, type: null };
  }
  if (/\b(libere|liberar|libera|solte|soltar|cancelar reserva|cancele reserva)\b/.test(normalized)) {
    return { action: "reservation_release", productQuery, quantity, salesOrderId, threshold: null, type: null };
  }
  if (/\b(reserve|reservar|reserva)\b/.test(normalized)) {
    return { action: "reservation", productQuery, quantity, salesOrderId, threshold: null, type: null };
  }
  if (/\b(ajuste|ajustar|ajusta|atualize|atualizar|defina|definir)\b/.test(normalized) && /\bestoque\b/.test(normalized)) {
    return { action: "adjustment", productQuery, quantity, salesOrderId, threshold: null, type: null };
  }
  if (/\b(entrada|entrar|recebimento|receber|adicione|adicionar|inclua|incluir)\b/.test(normalized) && /\bestoque|produto|unidade|unidades\b/.test(normalized)) {
    return { action: "entry", productQuery, quantity, salesOrderId, threshold: null, type: null };
  }
  if (/\b(saida|retirada|retirar|remova|remover)\b/.test(normalized) && /\bestoque|produto|unidade|unidades\b/.test(normalized)) {
    return { action: "exit", productQuery, quantity, salesOrderId, threshold: null, type: null };
  }
  return { action: null, productQuery: null, quantity: null, salesOrderId, threshold: null, type: null };
}

function extractInventoryQuantity(message: string) {
  const normalized = normalizeText(message);
  const adjustment = normalized.match(/\b(?:para|em)\s+(\d+)\b/);
  if (adjustment && /\b(ajuste|ajustar|atualize|defina|estoque)\b/.test(normalized)) {
    return Number(adjustment[1]);
  }
  const match = normalized.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function extractInventoryProductQuery(message: string) {
  const productLabelMatch = message.match(/\bproduto\s+(.+?)(?=\s+(?:para|pra|com|no|na|do|da|em|ao|a)\s+(?:o\s+|a\s+)?(?:pedido|estoque|\d)|[.!?]?$)/i);
  if (productLabelMatch?.[1]) {
    return normalizeProductQuery(cleanCatalogQuery(productLabelMatch[1]));
  }
  const quantityProductMatch = message.match(/\b\d+\s+(?:unidades?\s+)?(?:d[eo]s?\s+)?(.+?)(?=\s+(?:para|pra|no|na|do|da)\s+(?:o\s+|a\s+)?(?:pedido|estoque)|[.!?]?$)/i);
  if (quantityProductMatch?.[1]) {
    return normalizeProductQuery(cleanCatalogQuery(quantityProductMatch[1]));
  }
  const stockProductMatch = message.match(/\b(?:estoque|entrada|saida|reserva)\s+(?:d[eo]\s+)?(?:produto\s+)?(.+?)(?=\s+(?:para|pra|no|na|do|da)\s+(?:o\s+|a\s+)?pedido|[.!?]?$)/i);
  if (stockProductMatch?.[1] && !/\b(pedido|baixo|baixa|minimo|historico|movimentacoes)\b/i.test(stockProductMatch[1])) {
    return normalizeProductQuery(cleanCatalogQuery(stockProductMatch[1]));
  }
  return null;
}

function normalizeProductQuery(value: string) {
  const cleaned = value
    .replace(/\s+(?:para|pra|no|na|do|da)\s+(?:o\s+|a\s+)?pedido\b.*$/i, "")
    .replace(/\b(?:unidade|unidades|itens|item)\b/gi, "")
    .replace(/\b(?:para|pra|no|na|do|da|de)\b\s*$/i, "")
    .trim();
  const dictionary: Record<string, string> = {
    monitores: "monitor",
    notebooks: "notebook",
    mouses: "mouse",
    teclados: "teclado"
  };
  const normalized = normalizeText(cleaned);
  return dictionary[normalized] ?? cleaned.replace(/s$/i, "");
}

function extractThreshold(message: string) {
  const match = normalizeText(message).match(/\b(?:abaixo de|menor que|ate|<=?)\s*(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function inferInventoryMovementType(normalized: string): InventoryMovement["type"] | null {
  if (/\bentrada|recebimento\b/.test(normalized)) return "entry";
  if (/\bsaida|retirada\b/.test(normalized)) return "exit";
  if (/\bajuste|manual\b/.test(normalized)) return "adjustment";
  if (/\breserva\b/.test(normalized) && /\b(libere|liberar|cancelar|cancele)\b/.test(normalized)) return "reservation_release";
  if (/\breserva|reservado\b/.test(normalized)) return "reservation";
  if (/\bbaixa|pedido\b/.test(normalized)) return "order_writeoff";
  return null;
}

function explicitInventoryReason(action: NonNullable<ReturnType<typeof parseExplicitInventoryCommand>["action"]>, message: string) {
  const salesOrderId = extractSalesOrderId(message);
  if (action === "entry") return "Entrada de estoque por comando em linguagem natural";
  if (action === "exit") return "Saida de estoque por comando em linguagem natural";
  if (action === "adjustment") return "Ajuste manual de estoque por comando em linguagem natural";
  if (action === "reservation") return salesOrderId ? `Reserva para pedido ${salesOrderId}` : "Reserva de estoque por comando em linguagem natural";
  if (action === "reservation_release") return salesOrderId ? `Liberacao de reserva do pedido ${salesOrderId}` : "Liberacao de reserva por comando em linguagem natural";
  return "Movimentacao de estoque por comando em linguagem natural";
}

async function resolveProductByQuery(gateway: Awaited<ReturnType<typeof getCapabilityGateway>>, query: string) {
  const matches = await gateway.searchProduct({ query });
  return matches[0] ?? null;
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

function parseExplicitCatalogCommand(message: string): {
  action: "list" | "set_status" | "rename" | null;
  kind: "product" | "customer" | "supplier" | null;
  query: string | null;
  nextName: string | null;
  status: "active" | "inactive" | "blocked" | null;
} {
  const normalized = normalizeText(message);
  const kind = normalized.includes("fornecedor")
    ? "supplier"
    : normalized.includes("cliente")
      ? "customer"
      : normalized.includes("produto")
        ? "product"
        : null;
  if (!kind) {
    return { action: null, kind, query: null, nextName: null, status: null };
  }
  const status = /\b(inative|inativar|desative|desativar|bloqueie|bloquear|inativo|inativos)\b/.test(normalized)
    ? "inactive"
    : /\b(ative|ativar|ativo|ativos)\b/.test(normalized)
      ? "active"
      : null;
  if (/\b(liste|listar|mostre|mostrar|exiba|exibir|busque|buscar|procure|procurar)\b/.test(normalized)) {
    return {
      action: "list",
      kind,
      query: extractCatalogQuery(message, kind),
      nextName: null,
      status
    };
  }
  if (status) {
    return {
      action: "set_status",
      kind,
      query: extractCatalogQuery(message, kind),
      nextName: null,
      status
    };
  }
  const renameMatch = message.match(/\b(?:renomeie|renomear|altere\s+o\s+nome\s+d[eo]?)\s+(?:o\s+|a\s+)?(?:produto|cliente|fornecedor)\s+(.+?)\s+(?:para|pra)\s+(.+)$/i);
  if (renameMatch?.[1] && renameMatch[2]) {
    return {
      action: "rename",
      kind,
      query: cleanCatalogQuery(renameMatch[1]),
      nextName: cleanCatalogQuery(renameMatch[2]),
      status: null
    };
  }
  return { action: null, kind, query: null, nextName: null, status: null };
}

function extractCatalogQuery(message: string, kind: "product" | "customer" | "supplier") {
  const label = kind === "product" ? "produto" : kind === "customer" ? "cliente" : "fornecedor";
  const match = message.match(new RegExp(`\\b${label}\\s+(.+?)(?:\\s+(?:ativo|ativos|inativo|inativos|bloqueado|bloqueados))?$`, "i"));
  return match?.[1] ? cleanCatalogQuery(match[1]) : null;
}

function cleanCatalogQuery(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:o|a|os|as|de|do|da|dos|das)\s+/i, "")
    .replace(/[.!?]+$/g, "");
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

function inferCatalogStatus(normalized: string): "active" | "inactive" | null {
  if (/\b(inativo|inativos|inativa|inativas|bloqueado|bloqueados|bloqueada|bloqueadas)\b/.test(normalized)) {
    return "inactive";
  }
  if (/\b(ativo|ativos|ativa|ativas)\b/.test(normalized)) {
    return "active";
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

function formatCustomerList(customers: Customer[]) {
  if (!customers.length) return "Nao encontrei clientes para esses filtros.";
  return `Encontrei ${customers.length} cliente(s): ${customers
    .slice(0, 12)
    .map((customer) => `${customer.name} (${customer.city}, ${customer.status === "active" ? "ativo" : "inativo"})`)
    .join("; ")}.`;
}

function formatSupplierList(suppliers: Supplier[]) {
  if (!suppliers.length) return "Nao encontrei fornecedores para esses filtros.";
  return `Encontrei ${suppliers.length} fornecedor(es): ${suppliers
    .slice(0, 12)
    .map((supplier) => `${supplier.name} (${supplier.status === "active" ? "ativo" : "inativo"})`)
    .join("; ")}.`;
}

function formatProductList(products: Product[]) {
  if (!products.length) return "Nao encontrei produtos para esses filtros.";
  return `Encontrei ${products.length} produto(s): ${products
    .slice(0, 12)
    .map((product) => `${product.name} (${product.sku}, ${product.status === "inactive" ? "inativo" : "ativo"}, disponivel ${product.availableStock}, reservado ${product.reservedStock ?? 0}, preco ${formatMoney(product.unitPrice)})`)
    .join("; ")}.`;
}

function formatInventoryMovement(movement: InventoryMovement) {
  return `Movimentacao de estoque registrada: ${movement.productName} (${movement.sku}), ${translateInventoryMovementType(movement.type)}, quantidade ${movement.quantity}, disponivel ${movement.previousAvailableStock} -> ${movement.nextAvailableStock}, reservado ${movement.previousReservedStock} -> ${movement.nextReservedStock}.`;
}

function formatInventoryMovementList(movements: InventoryMovement[], filters: ListInventoryMovementsInput) {
  if (!movements.length) {
    return "Nao encontrei movimentacoes de estoque para esses filtros.";
  }
  const scope = [
    filters.salesOrderId ? `pedido ${filters.salesOrderId}` : null,
    filters.type ? translateInventoryMovementType(filters.type) : null,
    filters.dateRange && filters.dateRange !== "all_time" ? translateDateRange(filters.dateRange) : null
  ].filter(Boolean).join(", ");
  const prefix = scope ? `Historico de estoque para ${scope}` : "Historico de estoque";
  return `${prefix}: ${formatInventoryMovementItems(movements)}.`;
}

function formatInventoryMovementItems(movements: InventoryMovement[]) {
  return movements
    .slice(0, 25)
    .map((movement) =>
      `${formatDate(movement.createdAt)} | ${movement.productName} | ${translateInventoryMovementType(movement.type)} | qtd ${movement.quantity} | disponivel ${movement.previousAvailableStock} -> ${movement.nextAvailableStock} | reservado ${movement.previousReservedStock} -> ${movement.nextReservedStock} | ${movement.salesOrderId ?? "-"} | ${movement.reason ?? "-"}`
    )
    .join("; ");
}

function translateInventoryMovementType(type: InventoryMovement["type"]) {
  const labels: Record<InventoryMovement["type"], string> = {
    entry: "entrada",
    exit: "saida",
    adjustment: "ajuste manual",
    reservation: "reserva",
    reservation_release: "liberacao de reserva",
    order_writeoff: "baixa por pedido"
  };
  return labels[type];
}

function isManagerialReportRequest(message: string) {
  const normalized = normalizeText(message);
  return /\b(relatorio|gerencial|analise|indicadores|dashboard|ranking|tendencia|evolucao|margem|lucro|rentabilidade|ruptura|estoque baixo|clientes ativos|produto mais vendido|produtos mais vendidos)\b/.test(normalized);
}

function inferManagerialReportKind(message: string): ManagerialReportKind {
  const normalized = normalizeText(message);
  if (/\b(margem|lucro|rentabilidade)\b/.test(normalized)) return "margin";
  if (/\b(ruptura|estoque baixo|sem estoque|risco de estoque|repor|reposicao)\b/.test(normalized)) return "stockout_risk";
  if (/\b(cliente|clientes|ativos|recorrentes)\b/.test(normalized)) return "active_customers";
  if (/\b(tendencia|evolucao|crescimento|queda|por dia)\b/.test(normalized)) return "trend";
  if (/\b(ranking|mais vendido|mais vendidos|top)\b/.test(normalized)) return "top_products";
  if (/\b(faturamento|receita)\b/.test(normalized)) return "revenue";
  return "sales_by_period";
}

function formatManagerialReportAnswer(report: ManagerialReport) {
  const insight = report.insights[0] ? ` ${report.insights[0]}` : "";
  return `${report.title}: ${report.summary}${insight}`;
}

function formatInventoryError(error: unknown) {
  const message = error instanceof Error ? error.message : "Erro desconhecido.";
  const stockMatch = message.match(/has only\s+(\d+)\s+(?:units available|reserved units)/i);
  if (/insufficient stock/i.test(message) || /units available/i.test(message)) {
    return stockMatch
      ? `Nao executei a movimentacao porque o estoque disponivel e ${stockMatch[1]} unidade(s).`
      : "Nao executei a movimentacao porque nao ha estoque disponivel suficiente.";
  }
  if (/reserved units/i.test(message)) {
    return stockMatch
      ? `Nao executei a liberacao porque existem apenas ${stockMatch[1]} unidade(s) reservada(s).`
      : "Nao executei a liberacao porque a reserva disponivel e insuficiente.";
  }
  return `Nao consegui movimentar o estoque: ${message}`;
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
