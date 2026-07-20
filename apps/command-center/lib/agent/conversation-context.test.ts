import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResponse, SalesOrderPreview } from "@anti-erp/shared";
import {
  createEmptyConversationContext,
  evolveContextFromPreviewConfirmation,
  evolveConversationContext
} from "./conversation-context";

const preview: SalesOrderPreview = {
  customer: {
    id: "cus_northstar",
    name: "Northstar Labs",
    taxId: "12.345.678/0001-90",
    city: "Sao Paulo",
    status: "active"
  },
  lines: [
    {
      productId: "prd_monitor_27",
      sku: "MON-27-4K",
      name: "Monitor 27 4K",
      quantity: 1,
      unitPrice: 1950,
      total: 1950
    }
  ],
  subtotal: 1950,
  warnings: [],
  confirmationRequired: true
};

test("evolveConversationContext stores active customer and pending preview", () => {
  const response: AgentResponse = {
    mode: "langgraph",
    preview,
    message: {
      id: "msg_1",
      role: "agent",
      text: "Preview pronto."
    },
    auditEvents: [],
    lastOrderId: null
  };

  const context = evolveConversationContext({
    current: createEmptyConversationContext(),
    response,
    userCommand: "crie um pedido"
  });

  assert.equal(context.activeCustomer?.name, "Northstar Labs");
  assert.equal(context.activeProducts[0]?.name, "Monitor 27 4K");
  assert.equal(context.lastDocumentType, "sales_order_preview");
  assert.equal(context.pendingConfirmation, "sales_order");
  assert.equal(context.lastUserCommand, "crie um pedido");
});

test("evolveContextFromPreviewConfirmation stores confirmed order and invoice", () => {
  const response: AgentResponse = {
    mode: "langgraph",
    order: {
      ...preview,
      id: "SO-1001",
      status: "confirmed",
      createdAt: "2026-07-14T12:00:00.000Z"
    },
    invoice: {
      id: "CI-5001",
      status: "issued",
      salesOrderId: "SO-1001",
      customerName: "Northstar Labs",
      amount: 1950,
      issuedAt: "2026-07-14T12:00:00.000Z",
      disclaimer: "Concept invoice.",
      orderChangedAfterIssue: false
    },
    message: {
      id: "msg_2",
      role: "agent",
      text: "Pedido confirmado."
    },
    auditEvents: [],
    lastOrderId: "SO-1001"
  };

  const context = evolveContextFromPreviewConfirmation({
    current: createEmptyConversationContext(),
    preview,
    response
  });

  assert.equal(context.activeOrderId, "SO-1001");
  assert.equal(context.activeInvoiceId, "CI-5001");
  assert.equal(context.activeCustomer?.name, "Northstar Labs");
  assert.equal(context.lastDocumentType, "invoice");
  assert.equal(context.pendingConfirmation, "none");
});
