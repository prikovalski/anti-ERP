import type { InventoryMovement, SalesOrder, SalesOrderStatus } from "@anti-erp/shared";

// User-facing Portuguese texts shared by the agent routes and the confirmation executor.

export function describeOrder(order: SalesOrder) {
  const items = order.lines
    .map((line) => `${line.quantity}x ${line.name} (${formatMoney(line.total)})`)
    .join("; ");
  return `Pedido ${order.id} para ${order.customer.name}: ${translateStatus(order.status)}, ${items}, total ${formatMoney(order.subtotal)}.`;
}

export function formatInventoryMovement(movement: InventoryMovement) {
  return `Movimentacao de estoque registrada: ${movement.productName} (${movement.sku}), ${translateInventoryMovementType(movement.type)}, quantidade ${movement.quantity}, disponivel ${movement.previousAvailableStock} -> ${movement.nextAvailableStock}, reservado ${movement.previousReservedStock} -> ${movement.nextReservedStock}.`;
}

export function translateInventoryMovementType(type: InventoryMovement["type"]) {
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

export function formatInventoryError(error: unknown) {
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

export function formatDiscountError(error: unknown) {
  const message = error instanceof Error ? error.message : "Erro desconhecido.";
  if (/greater than 100/i.test(message)) {
    return "O percentual de desconto nao pode ser maior que 100%. Qual desconto devo aplicar?";
  }
  if (/greater than the selected total/i.test(message)) {
    return "O desconto informado e maior que o total selecionado. Qual valor de desconto devo aplicar?";
  }
  if (/not in sales order/i.test(message)) {
    return "Esse item nao esta no pedido. Qual item deve receber o desconto?";
  }
  if (/not found/i.test(message)) {
    return "Nao encontrei o pedido ou item informado para aplicar o desconto. Qual pedido e item devo usar?";
  }
  return `Nao consegui aplicar o desconto: ${message}`;
}

export function translateStatus(status: SalesOrderStatus) {
  return status === "canceled" ? "cancelado" : status === "draft" ? "rascunho" : "confirmado";
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}

export function formatPercent(value: number) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(value)}%`;
}
