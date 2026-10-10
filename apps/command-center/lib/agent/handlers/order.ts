import { normalizeText, translateDateRange, type ListSalesOrdersInput, type SalesOrder } from "@anti-erp/shared";
import { getPendingActionStore, type CapabilityGateway } from "../../capabilities";
import { buildClarifyingFallbackQuestion } from "../clarifying-fallback";
import {
  describeOrder,
  formatDate,
  formatDiscountError,
  formatMoney,
  formatPercent,
  roundMoney,
  translateStatus
} from "../agent-messages";
import { resolveCustomer, resolveProduct } from "../entity-resolution";
import type { CommandOf, OrderLineRequest } from "../nlu/commands";
import { proposeAction } from "../pending-actions";
import { audit, clarificationResponse, proposalResponse, response, unresolvedResponse } from "../responses";
import type { AgentHandler, HandlerContext } from "./types";

type OrderCommand = CommandOf<
  | "order.create"
  | "order.get"
  | "order.cancel"
  | "order.duplicate"
  | "order.list"
  | "order.add_item"
  | "order.set_item_quantity"
  | "order.remove_item"
  | "order.discount"
>;

export const orderHandler: AgentHandler<OrderCommand> = {
  name: "order",
  match: (command): command is OrderCommand => command.kind.startsWith("order."),
  async execute(command, context) {
    switch (command.kind) {
      case "order.create":
        return create(command, context);
      case "order.get":
      case "order.cancel":
      case "order.duplicate":
        return byId(command, context);
      case "order.list":
        return list(command.filters, context);
      case "order.add_item":
      case "order.set_item_quantity":
      case "order.remove_item":
        return changeItem(command, context);
      case "order.discount":
        return discount(command, context);
    }
  }
};

async function create(command: CommandOf<"order.create">, context: HandlerContext) {
  if (!command.customerQuery || !command.lines.length) {
    return clarificationResponse(buildClarifyingFallbackQuestion(context.message), "Pedido sem cliente ou sem itens.");
  }
  return prepareSalesOrderProposal(context.gateway, { ...command, customerQuery: command.customerQuery }, "prepare_sales_order");
}

/** Resolves customer and products, builds the preview and stores the order as a pending action. */
export async function prepareSalesOrderProposal(
  gateway: CapabilityGateway,
  order: { customerQuery: string; lines: OrderLineRequest[]; wantsInvoice: boolean; mentionsReservation?: boolean },
  auditAction: string
) {
  const customerResolution = await resolveCustomer(gateway, order.customerQuery);
  if (customerResolution.status !== "resolved") {
    return unresolvedResponse(customerResolution, "cliente", order.customerQuery);
  }
  const customer = customerResolution.entity;

  const lines = [];
  for (const item of order.lines) {
    const productResolution = await resolveProduct(gateway, item.productQuery);
    if (productResolution.status !== "resolved") {
      return unresolvedResponse(productResolution, "produto", item.productQuery);
    }
    lines.push({ productId: productResolution.entity.id, quantity: item.quantity });
  }

  const preview = await gateway.prepareSalesOrder({ customerId: customer.id, lines });
  const text = `Preparei o pedido para ${customer.name}. Confira os itens e confirme para gravar.`;
  const auditEvents = [audit(auditAction, `Pedido preparado para ${customer.name}.`)];
  if (preview.warnings.length) {
    // Nothing can be confirmed while warnings exist, so no pending action is created.
    return response(text, { preview, auditEvents });
  }
  const pendingAction = await proposeAction(await getPendingActionStore(), {
    payload: { kind: "sales_order.create", customerId: customer.id, lines, subtotal: preview.subtotal, wantsInvoice: order.wantsInvoice },
    title: "Criar pedido de venda",
    summary: `Criar pedido para ${customer.name} com ${lines.length} item(ns), total ${formatMoney(preview.subtotal)}${order.wantsInvoice ? ", com nota fiscal conceitual" : ""}.`,
    details: order.mentionsReservation ? ["O estoque dos itens e reservado automaticamente quando o pedido e confirmado."] : []
  });
  return response(text, { preview, pendingAction, auditEvents });
}

async function byId(command: CommandOf<"order.get" | "order.cancel" | "order.duplicate">, { gateway, lastOrderId }: HandlerContext) {
  // Viewing needs an explicit id; cancel and duplicate may use the session's active order and are confirmed anyway.
  const salesOrderId = command.salesOrderId ?? (command.kind === "order.get" ? null : lastOrderId);
  if (!salesOrderId) {
    return response("Qual pedido devo usar? Informe o numero, por exemplo SO-1001.");
  }
  const order = await gateway.getSalesOrder({ salesOrderId });
  if (!order) {
    return response(`Nao encontrei o pedido ${salesOrderId}.`);
  }
  if (command.kind === "order.get") {
    return response(describeOrder(order), {
      order,
      lastOrderId: order.id,
      auditEvents: [audit("get_sales_order", `Pedido consultado: ${order.id}.`)]
    });
  }
  if (command.kind === "order.cancel") {
    if (order.status === "canceled") {
      return response(`O pedido ${order.id} ja esta cancelado.`, { order, lastOrderId: order.id });
    }
    return proposalResponse({
      payload: { kind: "sales_order.cancel", salesOrderId: order.id },
      title: "Cancelar pedido",
      summary: `Cancelar o pedido ${order.id} de ${order.customer.name} (${formatMoney(order.subtotal)}).`,
      details: order.lines.map((line) => `${line.quantity}x ${line.name}`),
      extra: { order, lastOrderId: order.id }
    });
  }
  return proposalResponse({
    payload: { kind: "sales_order.duplicate", salesOrderId: order.id },
    title: "Duplicar pedido",
    summary: `Criar um novo pedido para ${order.customer.name} com os mesmos itens do pedido ${order.id}, reservando o estoque.`,
    details: order.lines.map((line) => `${line.quantity}x ${line.name}`),
    extra: { order, lastOrderId: order.id }
  });
}

async function list(filters: ListSalesOrdersInput, { gateway }: HandlerContext) {
  const orders = await gateway.listSalesOrders(filters);
  return response(formatOrderList(orders, filters), {
    auditEvents: [audit("list_sales_orders", `Listados ${orders.length} pedido(s).`)]
  });
}

async function changeItem(command: CommandOf<"order.add_item" | "order.set_item_quantity" | "order.remove_item">, { gateway, lastOrderId }: HandlerContext) {
  const salesOrderId = command.salesOrderId ?? lastOrderId;
  if (!salesOrderId) {
    return response("Qual pedido devo alterar? Informe o numero do pedido ou use o pedido criado anteriormente.");
  }
  const resolution = await resolveProduct(gateway, command.productQuery);
  if (resolution.status !== "resolved") {
    return unresolvedResponse(resolution, "produto", command.productQuery);
  }
  const product = resolution.entity;
  const order = command.kind === "order.add_item"
    ? await gateway.addSalesOrderLine({ salesOrderId, productId: product.id, quantity: Math.max(command.quantity, 1) })
    : command.kind === "order.set_item_quantity"
      ? await gateway.setSalesOrderLineQuantity({ salesOrderId, productId: product.id, quantity: command.quantity })
      : await gateway.removeSalesOrderLine({ salesOrderId, productId: product.id });
  const verb = command.kind === "order.add_item" ? "adicionado" : command.kind === "order.set_item_quantity" ? "atualizado" : "removido";
  return response(`Item ${product.name} ${verb} no pedido ${order.id}. Novo total: ${formatMoney(order.subtotal)}.`, {
    order,
    lastOrderId: order.id,
    auditEvents: [audit(command.kind, `Item ${verb} no pedido ${order.id}: ${product.name}.`)]
  });
}

async function discount(command: CommandOf<"order.discount">, { gateway, lastOrderId }: HandlerContext) {
  const salesOrderId = command.salesOrderId ?? lastOrderId;
  if (!salesOrderId) {
    return response("Qual pedido devo alterar para aplicar o desconto?");
  }
  const order = await gateway.getSalesOrder({ salesOrderId });
  if (!order) {
    return response(`Nao encontrei o pedido ${salesOrderId}. Qual pedido deve receber o desconto?`);
  }
  if (order.status === "canceled") {
    return response(`O pedido ${order.id} esta cancelado e nao pode receber desconto.`, { order, lastOrderId: order.id });
  }

  let productId: string | null = null;
  let productName: string | null = null;
  if (command.productQuery) {
    // Only items already in the order are candidates, so "monitor" cannot hit a product outside it.
    const query = normalizeText(command.productQuery);
    const matches = order.lines.filter((line) => normalizeText(line.name).includes(query) || normalizeText(line.sku).includes(query));
    if (!matches.length) {
      return response(`Nao encontrei ${command.productQuery} entre os itens do pedido ${order.id}. Qual item deve receber o desconto?`);
    }
    if (matches.length > 1) {
      return response(`Mais de um item do pedido ${order.id} corresponde a "${command.productQuery}": ${matches.map((line) => line.name).join("; ")}. Qual deles deve receber o desconto?`);
    }
    productId = matches[0]!.productId;
    productName = matches[0]!.name;
  }

  const targetTotal = roundMoney(order.lines.filter((line) => !productId || line.productId === productId).reduce((sum, line) => sum + line.total, 0));
  const discountAmount = command.discountType === "percent" ? roundMoney(targetTotal * (command.value / 100)) : command.value;
  if (command.discountType === "percent" && command.value > 100) {
    return response(formatDiscountError(new Error("Discount percent cannot be greater than 100.")));
  }
  if (discountAmount > targetTotal) {
    return response(formatDiscountError(new Error("Discount cannot be greater than the selected total.")));
  }

  const accumulated = accumulatedDiscount(order);
  const label = command.discountType === "percent" ? `${command.value}%` : formatMoney(command.value);
  return proposalResponse({
    payload: {
      kind: "sales_order.discount",
      salesOrderId: order.id,
      productId,
      productName,
      discountType: command.discountType,
      value: command.value
    },
    title: "Aplicar desconto",
    summary: `Aplicar desconto de ${label} ${productName ? `no item ${productName}` : "no pedido todo"} do pedido ${order.id} (${formatMoney(discountAmount)}).`,
    details: [
      `Total atual: ${formatMoney(order.subtotal)}`,
      `Total apos o desconto: ${formatMoney(roundMoney(order.subtotal - discountAmount))}`,
      ...(accumulated.amount > 0
        ? [`Este pedido ja tem desconto acumulado de ${formatMoney(accumulated.amount)} (${formatPercent(accumulated.percent)}).`]
        : [])
    ],
    extra: { order, lastOrderId: order.id }
  });
}

function accumulatedDiscount(order: SalesOrder) {
  const originalSubtotal = roundMoney(order.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
  const amount = roundMoney(Math.max(0, originalSubtotal - order.subtotal));
  return { amount, percent: originalSubtotal > 0 ? (amount / originalSubtotal) * 100 : 0 };
}

function formatOrderList(orders: SalesOrder[], filters: ListSalesOrdersInput) {
  const scope = [
    filters.customerQuery ? `cliente ${filters.customerQuery}` : null,
    filters.status ? `status ${translateStatus(filters.status)}` : null,
    filters.dateFrom || filters.dateTo ? `periodo ${formatDateFilter(filters.dateFrom)} a ${formatDateFilter(filters.dateTo)}` : null,
    filters.dateRange && filters.dateRange !== "all_time" ? translateDateRange(filters.dateRange) : null
  ].filter(Boolean).join(", ");
  if (!orders.length) {
    return scope ? `Nao encontrei pedidos para ${scope}.` : "Nao encontrei pedidos para esses filtros.";
  }
  const prefix = scope ? `Encontrei ${orders.length} pedido(s) para ${scope}` : `Encontrei ${orders.length} pedido(s)`;
  return `${prefix}: ${orders
    .slice(0, 8)
    .map((order) => `${order.id} | criado em ${formatDate(order.createdAt)} | cliente ${order.customer.name} | status ${translateStatus(order.status)} | itens ${order.lines.length} | total ${formatMoney(order.subtotal)}`)
    .join("; ")}.`;
}

function formatDateFilter(value?: string | null) {
  if (!value) return "-";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}
