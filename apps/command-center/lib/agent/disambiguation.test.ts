import assert from "node:assert/strict";
import test from "node:test";
import { AgentResponseSchema } from "@anti-erp/shared";
import { createCustomerDisambiguation, createProductDisambiguation } from "./disambiguation";

test("createCustomerDisambiguation builds a specific question with options", () => {
  const clarification = createCustomerDisambiguation("Maria", [
    {
      id: "cus_maria_matriz",
      name: "Maria Matriz",
      city: "Sao Paulo",
      taxId: "11.111.111/0001-11",
      status: "active"
    },
    {
      id: "cus_maria_filial",
      name: "Maria Filial",
      city: "Curitiba",
      taxId: "22.222.222/0001-22",
      status: "blocked"
    }
  ]);

  assert.equal(clarification.kind, "customer");
  assert.equal(clarification.query, "Maria");
  assert.match(clarification.question, /Qual deles devo usar/);
  assert.deepEqual(clarification.options.map((option) => option.label), ["Maria Matriz", "Maria Filial"]);
  assert.match(clarification.options[1]?.description ?? "", /bloqueado/);
});

test("createProductDisambiguation is valid in AgentResponseSchema", () => {
  const clarification = createProductDisambiguation("Mouse", [
    {
      id: "prd_mouse_basic",
      name: "Mouse Basic",
      sku: "MOU-BASIC",
      unitPrice: 50,
      availableStock: 10
    },
    {
      id: "prd_mouse_pro",
      name: "Mouse Pro",
      sku: "MOU-PRO",
      unitPrice: 90,
      availableStock: 4
    }
  ]);

  const parsed = AgentResponseSchema.parse({
    mode: "langgraph",
    message: {
      id: "msg_test",
      role: "agent",
      text: clarification.question
    },
    clarification,
    auditEvents: [],
    lastOrderId: null
  });

  assert.equal(parsed.clarification?.kind, "product");
  assert.equal(parsed.clarification?.options.length, 2);
});
