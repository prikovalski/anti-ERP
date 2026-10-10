import assert from "node:assert/strict";
import test from "node:test";
import { extractAnalytics } from "./analytics";
import { classifyCommand, classifyWithRules } from "./classifier";
import type { Command, CommandKind, CommandOf } from "./commands";

function classify<K extends CommandKind>(message: string, kind: K): CommandOf<K> {
  const { command } = classifyWithRules(message);
  assert.equal(command.kind, kind, message);
  return command as CommandOf<K>;
}

function orderOf(message: string) {
  const command = classify(message, "order.create");
  return { customerQuery: command.customerQuery, lines: command.lines, wantsInvoice: command.wantsInvoice };
}

test("empty input is unknown", () => {
  assert.deepEqual(classifyWithRules(undefined), { command: { kind: "unknown" }, confidence: 0.4, candidates: [] });
  assert.equal(classifyWithRules("   ").command.kind, "unknown");
});

test("orders are read with customer, items and invoice intent in any phrasing", () => {
  assert.deepEqual(orderOf("crie o pedido e a NF para Maria com 1 mouse e 1 monitor"), {
    customerQuery: "Maria",
    lines: [{ productQuery: "mouse", quantity: 1 }, { productQuery: "monitor", quantity: 1 }],
    wantsInvoice: true
  });
  assert.deepEqual(orderOf("faça um pedido pra Northstar com um monitor e dois teclados e emita nota fiscal"), {
    customerQuery: "Northstar",
    lines: [{ productQuery: "monitor", quantity: 1 }, { productQuery: "teclado", quantity: 2 }],
    wantsInvoice: true
  });
  assert.deepEqual(orderOf("gere um pedido para o cliente joao silva com 2 monitores"), {
    customerQuery: "joao silva",
    lines: [{ productQuery: "monitor", quantity: 2 }],
    wantsInvoice: false
  });

  const variations: Array<[string, string, string, number]> = [
    ["faz um pedido pra Northstar de 2 monitores", "Northstar", "monitor", 2],
    ["gere pedido para Northstar com dois monitores", "Northstar", "monitor", 2],
    ["crie um pedido com 1 monitor e 1 notebook para o cliente joao", "joao", "monitor", 1],
    ["crie um pedido de um monitor para joao da silva", "joao da silva", "monitor", 1],
    ["crie o pedido e nota fiscal para Globo com 1 monitor e 1 teclado", "Globo", "monitor", 1]
  ];
  for (const [phrase, customerQuery, productQuery, quantity] of variations) {
    const order = orderOf(phrase);
    assert.equal(order.customerQuery, customerQuery, phrase);
    assert.deepEqual(order.lines[0], { productQuery, quantity }, phrase);
  }
});

// P2.3: a complete order outranks the invoice and inventory words inside it.
test("order requests win over the invoice and stock words they contain", () => {
  const withInvoice = orderOf("Crie um pedido para Northstar com 10 notebooks e gere a nota.");
  assert.deepEqual(withInvoice.lines, [{ productQuery: "notebook", quantity: 10 }]);
  assert.equal(withInvoice.wantsInvoice, true);

  const withReservation = classify("Crie um pedido para Northstar com 10 notebooks e reserve o estoque", "order.create");
  assert.deepEqual(withReservation.lines, [{ productQuery: "notebook", quantity: 10 }]);
  assert.equal(withReservation.mentionsReservation, true);

  const candidates = classifyWithRules("Crie um pedido para Northstar com 10 notebooks e gere a nota.").candidates.map((candidate) => candidate.kind);
  assert.deepEqual(candidates.slice(0, 2), ["order.create", "invoice.create"]);
});

// P2.6
test("negated invoice requests do not ask for an invoice", () => {
  for (const phrase of [
    "Crie um pedido para Northstar com 2 monitores sem nota fiscal",
    "crie o pedido sem nota para Northstar com 2 monitores",
    "pedido para Northstar com 2 monitores, nao precisa de nota"
  ]) {
    assert.equal(orderOf(phrase).wantsInvoice, false, phrase);
  }
  assert.deepEqual(orderOf("pedido para Northstar com 2 fones sem fio").lines, [{ productQuery: "fones sem fio", quantity: 2 }]);
});

test("order item changes use the active order", () => {
  const cases: Array<[string, Command["kind"], string, number]> = [
    ["adicione um notebook no pedido criado", "order.add_item", "notebook", 1],
    ["inclua um notebook no pedido criado", "order.add_item", "notebook", 1],
    ["altere o notebook do pedido para 3 unidades", "order.set_item_quantity", "notebook", 3],
    ["muda o notebook do pedido para 3 unidades", "order.set_item_quantity", "notebook", 3],
    ["remova o monitor do pedido criado", "order.remove_item", "monitor", 0],
    ["tira o monitor do pedido criado", "order.remove_item", "monitor", 0],
    ["adicione o produto Cabo no pedido", "order.add_item", "Cabo", 1]
  ];
  for (const [phrase, kind, productQuery, quantity] of cases) {
    const command = classifyWithRules(phrase).command as CommandOf<"order.add_item">;
    assert.equal(command.kind, kind, phrase);
    assert.equal(command.productQuery, productQuery, phrase);
    assert.equal(command.quantity, quantity, phrase);
  }
});

test("catalog creation, price and stock updates", () => {
  assert.deepEqual(classify("cadastre o cliente Maria", "catalog.create"), { kind: "catalog.create", entity: "customer", name: "Maria" });
  assert.deepEqual(classify("registre o cliente Loja Solar", "catalog.create"), { kind: "catalog.create", entity: "customer", name: "Loja Solar" });
  assert.deepEqual(classify("manda cadastrar o produto Cabo HDMI", "catalog.create"), { kind: "catalog.create", entity: "product", name: "Cabo HDMI" });
  assert.deepEqual(classify("adicione fornecedor Delta Sul", "catalog.create"), { kind: "catalog.create", entity: "supplier", name: "Delta Sul" });

  assert.equal(classify("Atualize o preço do produto Mouse para 50 reais", "product.update_price").unitPrice, 50);
  assert.equal(classify("Atualize o preço do produto Mouse para R$ 1.234,56", "product.update_price").unitPrice, 1234.56);
  // Stock changes go through the inventory ledger.
  assert.deepEqual(classify("Atualize o estoque do produto Mouse para 12 unidades", "inventory.move"), {
    kind: "inventory.move",
    action: "adjustment",
    productQuery: "Mouse",
    quantity: 12,
    salesOrderId: null
  });
  assert.equal(classify("Atualize o estoque do produto Mouse para vinte unidades", "inventory.move").quantity, 20);
});

test("multi-step requests become a workflow", () => {
  const workflow = classify(
    "Cadastre o cliente Aurora, cadastre o produto Mouse, crie um pedido para Aurora com 1 Mouse, gere a nota e um relatorio de vendas hoje",
    "workflow"
  );
  assert.deepEqual(workflow.steps.map((step) => step.type), ["create_customer", "create_product", "prepare_sales_order", "query_report"]);
  assert.deepEqual(workflow.steps[2], {
    type: "prepare_sales_order",
    customerQuery: "Aurora",
    lines: [{ productQuery: "Mouse", quantity: 1 }],
    wantsInvoice: true
  });

  assert.deepEqual(
    classify("cadastre o cliente Acme e crie um pedido para Acme com 2 monitores", "workflow").steps.map((step) => step.type),
    ["create_customer", "prepare_sales_order"]
  );
});

test("reports, metrics and inventory diagnostics", () => {
  classify("Quais produtos estão com estoque baixo?", "inventory.low_stock");
  classify("quero um relatorio", "report.clarify");
  classify("compare o erp tradicional com o anti-erp", "info.traditional_flow");

  const revenueToday = classify("quanto faturamos hoje?", "report.metrics");
  assert.equal(revenueToday.metric, "revenue");
  assert.equal(revenueToday.dateRange, "today");
  assert.equal(classify("quantos notebooks vendemos hoje?", "report.metrics").productQuery, "notebook");

  const analyticsCases: Array<[string, Partial<ReturnType<typeof extractAnalytics>>]> = [
    ["Quantos monitores foram vendidos hoje?", { metric: "units_sold", dateRange: "today", productQueries: ["monitor"] }],
    ["Qual foi o faturamento de notebooks hoje?", { metric: "revenue", dateRange: "today", productQueries: ["notebook"] }],
    ["Quais clientes compraram notebooks hoje e qual foi o faturamento por cliente?", { metric: "revenue", groupBy: "customer", dateRange: "today", productQueries: ["notebook"] }],
    ["Relatório de faturamento por cliente dos notebooks nos últimos 7 dias", { metric: "revenue", groupBy: "customer", dateRange: "last_7_days", productQueries: ["notebook"] }],
    ["Quais produtos mais venderam hoje?", { metric: "units_sold", groupBy: "product", dateRange: "today", productQueries: [] }],
    ["Compare o faturamento de notebooks e monitores hoje", { metric: "revenue", groupBy: "product", productQueries: ["monitor", "notebook"] }],
    ["quais produtos foram vendidos nos ultimos 30 dias, totalize por produto e mostre o valor total faturado de cada produto", { metric: "revenue", groupBy: "product", dateRange: "last_30_days" }],
    ["ranking dos produtos mais vendidos na semana", { groupBy: "product", dateRange: "last_7_days" }],
    ["compare receita de notebooks contra monitores hoje", { metric: "revenue", productQueries: ["monitor", "notebook"] }]
  ];
  for (const [phrase, expected] of analyticsCases) {
    assert.equal(classifyWithRules(phrase).command.kind, "report.intelligent", phrase);
    const analytics = extractAnalytics(phrase);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(analytics[key as keyof typeof analytics], value, `${phrase}: ${key}`);
    }
  }
});

test("destructive commands carry the ids or queries they act on", () => {
  assert.deepEqual(classify("cancele o pedido SO-1001", "order.cancel"), { kind: "order.cancel", salesOrderId: "SO-1001" });
  assert.deepEqual(classify("cancele a nota fiscal CI-5001", "invoice.cancel"), { kind: "invoice.cancel", invoiceId: "CI-5001" });
  assert.equal(classify("cancele a nota do pedido SO-1001", "invoice.cancel").invoiceId, null);
  assert.deepEqual(classify("inative o cliente la", "catalog.set_status"), {
    kind: "catalog.set_status",
    entity: "customer",
    query: "la",
    status: "inactive"
  });
  assert.equal(classify("liste os pedidos do dia 01/01/2020", "order.list").filters.customerQuery, null);
});

// P2.2: without a model key the rules decide and the source says so.
test("classification source is rules when no model is configured", async () => {
  delete process.env.OPENROUTER_API_KEY;
  const classification = await classifyCommand("faz um pedido");
  assert.equal(classification.source, "rules");
  assert.equal(classification.command.kind, "order.create");
});
