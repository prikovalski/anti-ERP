import assert from "node:assert/strict";
import test from "node:test";
import { parseIntentLocally } from "./intent-parser";
import { runDirectAgent } from "./direct-agent";
import { buildLocalSemanticPlan } from "./semantic-plan";
import { demoCapabilityGateway } from "../capabilities/demo-gateway";

process.env.CAPABILITY_GATEWAY = "demo";
process.env.LANGSMITH_TRACING = "false";

test("parser understands natural Portuguese variations for sales orders", () => {
  const scenarios = [
    {
      phrase: "faz um pedido pra Northstar de 2 monitores",
      intent: "create_order",
      customerQuery: "Northstar",
      productQuery: "monitor",
      quantity: 2
    },
    {
      phrase: "gere pedido para Northstar com dois monitores",
      intent: "create_order",
      customerQuery: "Northstar",
      productQuery: "monitor",
      quantity: 2
    },
    {
      phrase: "crie um pedido com 1 monitor e 1 notebook para o cliente joao",
      intent: "create_order",
      customerQuery: "joao",
      productQuery: "monitor",
      quantity: 1
    },
    {
      phrase: "crie um pedido de um monitor para joao da silva",
      intent: "create_order",
      customerQuery: "joao da silva",
      productQuery: "monitor",
      quantity: 1
    },
    {
      phrase: "crie o pedido e nota fiscal para Globo com 1 monitor e 1 teclado",
      intent: "create_order_with_invoice",
      customerQuery: "Globo",
      productQuery: "monitor",
      quantity: 1
    }
  ];

  for (const scenario of scenarios) {
    const intent = parseIntentLocally(scenario.phrase);
    assert.equal(intent.intent, scenario.intent, scenario.phrase);
    assert.equal(intent.customerQuery, scenario.customerQuery, scenario.phrase);
    assert.equal(intent.productQuery, scenario.productQuery, scenario.phrase);
    assert.equal(intent.quantity, scenario.quantity, scenario.phrase);
  }
});

test("semantic plan extracts free-order sales order requests", () => {
  const plan = buildLocalSemanticPlan("crie um pedido com 1 monitor e 1 notebook para o cliente joao");
  const naturalPlan = buildLocalSemanticPlan("crie um pedido de um monitor para joao da silva");

  assert.equal(plan?.intent, "sales_order.create");
  assert.equal(plan?.entities.customer?.name, "joao");
  assert.deepEqual(plan?.entities.items, [
    { product: "monitor", quantity: 1 },
    { product: "notebook", quantity: 1 }
  ]);
  assert.deepEqual(plan?.steps, [
    "resolve_customer",
    "resolve_products",
    "validate_stock",
    "prepare_sales_order"
  ]);
  assert.equal(naturalPlan?.entities.customer?.name, "joao da silva");
  assert.deepEqual(naturalPlan?.entities.items, [
    { product: "monitor", quantity: 1 }
  ]);
});

test("parser understands natural Portuguese variations for order item changes", () => {
  const add = parseIntentLocally("inclua um notebook no pedido criado");
  const change = parseIntentLocally("muda o notebook do pedido para 3 unidades");
  const remove = parseIntentLocally("tira o monitor do pedido criado");

  assert.equal(add.intent, "add_item_to_order");
  assert.equal(add.productQuery, "notebook");
  assert.equal(add.quantity, 1);

  assert.equal(change.intent, "set_order_item_quantity");
  assert.equal(change.productQuery, "notebook");
  assert.equal(change.quantity, 3);

  assert.equal(remove.intent, "remove_item_from_order");
  assert.equal(remove.productQuery, "monitor");
  assert.equal(remove.quantity, 0);
});

test("parser understands natural Portuguese variations for catalog and analytics", () => {
  const customer = parseIntentLocally("registre o cliente Loja Solar");
  const product = parseIntentLocally("manda cadastrar o produto Cabo HDMI");
  const supplier = parseIntentLocally("adicione fornecedor Delta Sul");
  const revenue = parseIntentLocally("quanto faturamos hoje?");
  const ranking = parseIntentLocally("ranking dos produtos mais vendidos na semana");
  const comparison = parseIntentLocally("compare receita de notebooks contra monitores hoje");

  assert.equal(customer.intent, "create_customer");
  assert.equal(customer.catalogName, "Loja Solar");
  assert.equal(product.intent, "create_product");
  assert.equal(product.catalogName, "Cabo HDMI");
  assert.equal(supplier.intent, "create_supplier");
  assert.equal(supplier.catalogName, "Delta Sul");

  assert.equal(revenue.intent, "analytics_query");
  assert.equal(revenue.analytics?.metric, "revenue");
  assert.equal(revenue.analytics?.dateRange, "today");

  assert.equal(ranking.intent, "analytics_query");
  assert.equal(ranking.analytics?.groupBy, "product");
  assert.equal(ranking.analytics?.dateRange, "last_7_days");

  assert.equal(comparison.intent, "analytics_query");
  assert.equal(comparison.analytics?.metric, "revenue");
  assert.deepEqual(comparison.analytics?.productQueries, ["monitor", "notebook"]);
});

test("direct agent executes natural sales order and catalog commands with demo gateway", async () => {
  const freeOrder = await runDirectAgent({ message: "crie um pedido com 1 monitor e 1 notebook para o cliente Northstar" });
  assert.equal(freeOrder.preview?.customer.name, "Northstar Labs");
  assert.deepEqual(freeOrder.preview?.lines.map((line) => [line.name, line.quantity]), [
    ["Monitor 27 4K", 1],
    ["Notebook Air 14", 1]
  ]);

  const order = await runDirectAgent({ message: "gere pedido para Northstar com dois monitores" });
  assert.equal(order.preview?.customer.name, "Northstar Labs");
  assert.equal(order.preview?.lines[0]?.quantity, 2);
  assert.match(order.message.text, /Preparei o pedido/i);

  const suffix = Math.random().toString(36).slice(2, 8);
  const productName = `Produto Frases Reais ${suffix}`;
  const created = await runDirectAgent({ message: `cadastre o produto ${productName}` });
  assert.match(created.message.text, /cadastrado com sucesso/i);

  const listed = await runDirectAgent({ message: `liste produtos ${productName}` });
  assert.match(listed.message.text, new RegExp(productName, "i"));
});

test("direct agent executes natural inventory and managerial report commands with demo gateway", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const productName = `Produto Estoque Frases ${suffix}`;
  await runDirectAgent({ message: `cadastre o produto ${productName}` });

  const entry = await runDirectAgent({ message: `dê entrada de 7 unidades no produto ${productName}` });
  assert.match(entry.message.text, /entrada/i);
  assert.match(entry.message.text, /quantidade 7/i);

  await runDirectAgent({ message: "cadastre o produto mouse qa 1200" });
  const itemQuantityEntry = await runDirectAgent({ message: "adicione 10 quantidades ao item mouse qa 1200" });
  assert.match(itemQuantityEntry.message.text, /entrada/i);
  assert.match(itemQuantityEntry.message.text, /Mouse qa 1200|mouse qa 1200/i);
  assert.match(itemQuantityEntry.message.text, /quantidade 10/i);

  const history = await runDirectAgent({ message: `historico de estoque do produto ${productName}` });
  assert.match(history.message.text, /Historico de estoque/i);
  assert.match(history.message.text, new RegExp(productName, "i"));

  const stockPosition = await runDirectAgent({ message: "liste o estoque" });
  assert.match(stockPosition.message.text, /Estoque atual/i);
  assert.match(stockPosition.message.text, /Produto \| Quantidade disponivel/i);
  assert.doesNotMatch(stockPosition.message.text, /Historico de estoque/i);

  const margin = await runDirectAgent({ message: "gere um relatório de margem do mês" });
  assert.equal(margin.intelligentReport?.plan.metric, "sales");
  assert.match(margin.message.text, /Relatorio|Vendas|Margem|gerencial/i);

  const stockout = await runDirectAgent({ message: "mostre o risco de ruptura de estoque" });
  assert.equal(stockout.intelligentReport?.plan.metric, "stock");
  assert.match(stockout.message.text, /estoque/i);

  const productRevenue = await runDirectAgent({
    message: "quais produtos foram vendidos nos ultimos 30 dias, totalize por produto e mostre o valor total faturado de cada produto"
  });
  assert.equal(productRevenue.intelligentReport?.plan.dateRange, "last_30_days");
  assert.equal(productRevenue.intelligentReport?.plan.grain, "product");
  assert.deepEqual(productRevenue.intelligentReport?.columns, ["produto", "quantidade", "faturamento", "pedidos"]);
});

test("direct agent treats catalog delete language as safe product deactivation", async () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const productName = `MCP Migracao ${suffix}`;
  await demoCapabilityGateway.createProduct({ name: productName });

  const response = await runDirectAgent({ message: `exclua o produto ${productName}` });
  const [product] = await demoCapabilityGateway.searchProduct({ query: productName });

  assert.match(response.message.text, /Produto .* inativado com sucesso\./);
  assert.equal(product?.status, "inactive");
});

test("direct agent asks clarifying questions for incomplete informal commands", async () => {
  const incompleteOrder = await runDirectAgent({ message: "faz um pedido" });
  const vagueReport = await runDirectAgent({ message: "quero um relatorio" });
  const vagueStock = await runDirectAgent({ message: "mexer no estoque" });

  assert.match(incompleteOrder.message.text, /cliente|itens|pedido/i);
  assert.match(vagueReport.message.text, /relatorio|vendas|faturamento|margem/i);
  assert.match(vagueStock.message.text, /produto|estoque/i);
  assert.equal(incompleteOrder.auditEvents[0]?.action, "clarification_required");
});

test("direct agent applies discounts to the whole order or a specific item", async () => {
  const [customer] = await demoCapabilityGateway.searchCustomer({ query: "Northstar" });
  const [monitor] = await demoCapabilityGateway.searchProduct({ query: "monitor" });
  const [notebook] = await demoCapabilityGateway.searchProduct({ query: "notebook" });
  assert.ok(customer);
  assert.ok(monitor);
  assert.ok(notebook);

  const wholeOrderPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: customer.id,
    lines: [{ productId: monitor.id, quantity: 2 }]
  });
  const wholeOrder = await demoCapabilityGateway.createSalesOrder({ preview: wholeOrderPreview, confirmedByUser: true });
  const wholeOrderSubtotal = wholeOrder.subtotal;
  const wholeDiscount = await runDirectAgent({
    message: "aplique 10% de desconto no pedido",
    lastOrderId: wholeOrder.id
  });

  assert.equal(wholeDiscount.order?.subtotal, wholeOrderSubtotal * 0.9);
  assert.match(wholeDiscount.message.text, /desconto de 10% no pedido todo/i);

  const blockedSecondDiscount = await runDirectAgent({
    message: "aplique 10% de desconto no pedido",
    lastOrderId: wholeOrder.id
  });
  assert.match(blockedSecondDiscount.message.text, /ja possui desconto acumulado/i);
  assert.match(blockedSecondDiscount.message.text, /confirma aplicar um novo desconto/i);
  assert.equal(blockedSecondDiscount.order?.subtotal, wholeOrderSubtotal * 0.9);

  const confirmedSecondDiscount = await runDirectAgent({
    message: "confirmo aplicar 10% de desconto no pedido",
    lastOrderId: wholeOrder.id
  });
  assert.equal(confirmedSecondDiscount.order?.subtotal, wholeOrderSubtotal * 0.81);

  const itemPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: customer.id,
    lines: [
      { productId: monitor.id, quantity: 1 },
      { productId: notebook.id, quantity: 1 }
    ]
  });
  const itemOrder = await demoCapabilityGateway.createSalesOrder({ preview: itemPreview, confirmedByUser: true });
  const originalMonitorTotal = itemOrder.lines.find((line) => line.productId === monitor.id)!.total;
  const originalNotebookTotal = itemOrder.lines.find((line) => line.productId === notebook.id)!.total;
  const itemDiscount = await runDirectAgent({
    message: "de 100 reais de desconto no item monitor do pedido",
    lastOrderId: itemOrder.id
  });
  const discountedMonitor = itemDiscount.order?.lines.find((line) => line.productId === monitor.id);
  const unchangedNotebook = itemDiscount.order?.lines.find((line) => line.productId === notebook.id);

  assert.equal(discountedMonitor?.total, originalMonitorTotal - 100);
  assert.equal(unchangedNotebook?.total, originalNotebookTotal);
});

test("direct agent filters listed orders by customer name after 'pedidos de'", async () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const joao = await demoCapabilityGateway.createCustomer({ name: `Joao Silva ${suffix}` });
  const [northstar] = await demoCapabilityGateway.searchCustomer({ query: "Northstar" });
  const [monitor] = await demoCapabilityGateway.searchProduct({ query: "monitor" });
  assert.ok(northstar);
  assert.ok(monitor);

  const joaoPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: joao.id,
    lines: [{ productId: monitor.id, quantity: 1 }]
  });
  const northstarPreview = await demoCapabilityGateway.prepareSalesOrder({
    customerId: northstar.id,
    lines: [{ productId: monitor.id, quantity: 1 }]
  });
  const joaoOrder = await demoCapabilityGateway.createSalesOrder({ preview: joaoPreview, confirmedByUser: true });
  const northstarOrder = await demoCapabilityGateway.createSalesOrder({ preview: northstarPreview, confirmedByUser: true });

  const response = await runDirectAgent({ message: `liste todos os pedidos de Joao Silva ${suffix}` });

  assert.match(response.message.text, new RegExp(joaoOrder.id));
  assert.doesNotMatch(response.message.text, new RegExp(northstarOrder.id));
  assert.match(response.message.text, new RegExp(`cliente Joao Silva ${suffix}`, "i"));
});

test("direct agent applies natural date filters when listing orders", async () => {
  const unavailableDay = await runDirectAgent({ message: "liste os pedidos do dia 01/01/2020" });
  const lastWeek = await runDirectAgent({ message: "exiba os pedidos da ultima semana" });
  const previousWeek = await runDirectAgent({ message: "liste os pedidos da semana passada" });
  const lastMonth = await runDirectAgent({ message: "liste os pedidos do ultimo mes" });

  assert.match(unavailableDay.message.text, /periodo 01\/01\/2020 a 01\/01\/2020/i);
  assert.match(lastWeek.message.text, /periodo \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/i);
  assert.doesNotMatch(lastWeek.message.text, /cliente ultima/i);
  assert.match(previousWeek.message.text, /periodo \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/i);
  assert.match(lastMonth.message.text, /periodo \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/i);
});
