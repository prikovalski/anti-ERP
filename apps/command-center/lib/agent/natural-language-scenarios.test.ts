import assert from "node:assert/strict";
import test from "node:test";
import { parseIntentLocally } from "./intent-parser";
import { runDirectAgent } from "./direct-agent";

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

  const history = await runDirectAgent({ message: `historico de estoque do produto ${productName}` });
  assert.match(history.message.text, /Historico de estoque/i);
  assert.match(history.message.text, new RegExp(productName, "i"));

  const margin = await runDirectAgent({ message: "gere um relatório de margem do mês" });
  assert.equal(margin.managerialReport?.kind, "margin");
  assert.match(margin.message.text, /Margem estimada/i);

  const stockout = await runDirectAgent({ message: "mostre o risco de ruptura de estoque" });
  assert.equal(stockout.managerialReport?.kind, "stockout_risk");
  assert.match(stockout.message.text, /Ruptura de estoque/i);
});
