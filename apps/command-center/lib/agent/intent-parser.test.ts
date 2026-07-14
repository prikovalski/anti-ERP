import assert from "node:assert/strict";
import test from "node:test";
import { parseIntentLocally } from "./intent-parser";

test("parseIntentLocally returns unknown for empty input", () => {
  const intent = parseIntentLocally(undefined);

  assert.equal(intent.intent, "unknown");
  assert.equal(intent.confidence, 0.4);
});

test("parseIntentLocally parses order with invoice and multiple lines", () => {
  const intent = parseIntentLocally("crie o pedido e a NF para Maria com 1 mouse e 1 monitor");

  assert.equal(intent.intent, "create_order_with_invoice");
  assert.equal(intent.customerQuery, "Maria");
  assert.equal(intent.wantsInvoice, true);
  assert.deepEqual(intent.orderLines, [
    { productQuery: "mouse", quantity: 1 },
    { productQuery: "monitor", quantity: 1 }
  ]);
});

test("parseIntentLocally parses natural quantity words in order lines", () => {
  const intent = parseIntentLocally("faça um pedido pra Northstar com um monitor e dois teclados e emita nota fiscal");

  assert.equal(intent.intent, "create_order_with_invoice");
  assert.equal(intent.customerQuery, "Northstar");
  assert.equal(intent.wantsInvoice, true);
  assert.deepEqual(intent.orderLines, [
    { productQuery: "monitor", quantity: 1 },
    { productQuery: "teclados", quantity: 2 }
  ]);
});

test("parseIntentLocally parses adding an item to the current order", () => {
  const intent = parseIntentLocally("adicione um notebook no pedido criado");

  assert.equal(intent.intent, "add_item_to_order");
  assert.equal(intent.productQuery, "notebook");
  assert.equal(intent.quantity, 1);
  assert.deepEqual(intent.orderLines, [{ productQuery: "notebook", quantity: 1 }]);
});

test("parseIntentLocally parses changing item quantity in the current order", () => {
  const intent = parseIntentLocally("altere o notebook do pedido para 3 unidades");

  assert.equal(intent.intent, "set_order_item_quantity");
  assert.equal(intent.productQuery, "notebook");
  assert.equal(intent.quantity, 3);
  assert.deepEqual(intent.orderLines, [{ productQuery: "notebook", quantity: 3 }]);
});

test("parseIntentLocally parses removing an item from the current order", () => {
  const intent = parseIntentLocally("remova o monitor do pedido criado");

  assert.equal(intent.intent, "remove_item_from_order");
  assert.equal(intent.productQuery, "monitor");
  assert.equal(intent.quantity, 0);
  assert.deepEqual(intent.orderLines, [{ productQuery: "monitor", quantity: 0 }]);
});

test("parseIntentLocally parses catalog creation", () => {
  const customer = parseIntentLocally("cadastre o cliente Maria");
  const product = parseIntentLocally("cadastre o produto Mouse");
  const supplier = parseIntentLocally("cadastre o fornecedor Delta");

  assert.equal(customer.intent, "create_customer");
  assert.equal(customer.catalogName, "Maria");
  assert.equal(product.intent, "create_product");
  assert.equal(product.catalogName, "Mouse");
  assert.equal(supplier.intent, "create_supplier");
  assert.equal(supplier.catalogName, "Delta");
});

test("parseIntentLocally parses product price and stock updates", () => {
  const price = parseIntentLocally("Atualize o preço do produto Mouse para 50 reais");
  const stock = parseIntentLocally("Atualize o estoque do produto Mouse para 12 unidades");
  const formattedPrice = parseIntentLocally("Atualize o preço do produto Mouse para R$ 1.234,56");
  const stockByWord = parseIntentLocally("Atualize o estoque do produto Mouse para vinte unidades");

  assert.equal(price.intent, "update_product");
  assert.deepEqual(price.productUpdate, {
    productQuery: "Mouse",
    unitPrice: 50,
    availableStock: null
  });
  assert.equal(stock.intent, "update_product");
  assert.deepEqual(stock.productUpdate, {
    productQuery: "Mouse",
    unitPrice: null,
    availableStock: 12
  });
  assert.deepEqual(formattedPrice.productUpdate, {
    productQuery: "Mouse",
    unitPrice: 1234.56,
    availableStock: null
  });
  assert.deepEqual(stockByWord.productUpdate, {
    productQuery: "Mouse",
    unitPrice: null,
    availableStock: 20
  });
});

test("parseIntentLocally parses analytics questions", () => {
  const units = parseIntentLocally("Quantos monitores foram vendidos hoje?");
  const revenue = parseIntentLocally("Qual foi o faturamento de notebooks hoje?");

  assert.equal(units.intent, "analytics_query");
  assert.equal(units.productQuery, "monitor");
  assert.equal(units.analytics?.metric, "units_sold");
  assert.equal(units.analytics?.dateRange, "today");
  assert.equal(revenue.intent, "analytics_query");
  assert.equal(revenue.productQuery, "notebook");
  assert.equal(revenue.analytics?.metric, "revenue");
  assert.equal(revenue.analytics?.dateRange, "today");
});

test("parseIntentLocally parses composite analytics by customer", () => {
  const intent = parseIntentLocally("Quais clientes compraram notebooks hoje e qual foi o faturamento por cliente?");

  assert.equal(intent.intent, "analytics_query");
  assert.equal(intent.productQuery, "notebook");
  assert.equal(intent.analytics?.metric, "revenue");
  assert.equal(intent.analytics?.groupBy, "customer");
  assert.equal(intent.analytics?.dateRange, "today");
});

test("parseIntentLocally parses analytics filters with period and product", () => {
  const intent = parseIntentLocally("Relatório de faturamento por cliente dos notebooks nos últimos 7 dias");

  assert.equal(intent.intent, "analytics_query");
  assert.equal(intent.productQuery, "notebook");
  assert.equal(intent.analytics?.metric, "revenue");
  assert.equal(intent.analytics?.groupBy, "customer");
  assert.equal(intent.analytics?.dateRange, "last_7_days");
  assert.deepEqual(intent.analytics?.productQueries, ["notebook"]);
});

test("parseIntentLocally parses product ranking", () => {
  const intent = parseIntentLocally("Quais produtos mais venderam hoje?");

  assert.equal(intent.intent, "analytics_query");
  assert.equal(intent.productQuery, null);
  assert.equal(intent.analytics?.metric, "units_sold");
  assert.equal(intent.analytics?.groupBy, "product");
  assert.equal(intent.analytics?.dateRange, "today");
});

test("parseIntentLocally parses product comparison", () => {
  const intent = parseIntentLocally("Compare o faturamento de notebooks e monitores hoje");

  assert.equal(intent.intent, "analytics_query");
  assert.equal(intent.productQuery, null);
  assert.equal(intent.analytics?.metric, "revenue");
  assert.equal(intent.analytics?.groupBy, "product");
  assert.equal(intent.analytics?.dateRange, "today");
  assert.deepEqual(intent.analytics?.productQueries, ["monitor", "notebook"]);
});

test("parseIntentLocally parses inventory diagnostics before generic analytics", () => {
  const intent = parseIntentLocally("Quais produtos estão com estoque baixo?");

  assert.equal(intent.intent, "inventory_diagnostic");
});
