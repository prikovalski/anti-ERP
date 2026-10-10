import { translateDateRange, type InventoryMovement, type ListInventoryMovementsInput, type Product } from "@anti-erp/shared";
import { formatDate, formatInventoryError, formatInventoryMovement, translateInventoryMovementType } from "../agent-messages";
import { resolveProduct } from "../entity-resolution";
import type { CommandOf } from "../nlu/commands";
import { inventoryReason } from "../nlu/inventory";
import { audit, proposalResponse, response, unresolvedResponse } from "../responses";
import type { AgentHandler, HandlerContext } from "./types";

type InventoryCommand = CommandOf<"inventory.low_stock" | "inventory.history" | "inventory.position" | "inventory.writeoff" | "inventory.move">;

export const inventoryHandler: AgentHandler<InventoryCommand> = {
  name: "inventory",
  match: (command): command is InventoryCommand => command.kind.startsWith("inventory."),
  async execute(command, context) {
    switch (command.kind) {
      case "inventory.low_stock":
        return lowStock(command, context);
      case "inventory.history":
        return history(command, context);
      case "inventory.position":
        return position(command, context);
      case "inventory.writeoff":
        return writeOff(command, context);
      case "inventory.move":
        return move(command, context);
    }
  }
};

async function lowStock(command: CommandOf<"inventory.low_stock">, { gateway }: HandlerContext) {
  const products = await gateway.listLowStockProducts({ threshold: command.threshold ?? 10 });
  const text = products.length
    ? `Produtos com estoque baixo: ${products.map((product) => `${product.name} (${product.sku}, disponivel ${product.availableStock}, reservado ${product.reservedStock ?? 0})`).join("; ")}.`
    : "Nenhum produto esta com estoque baixo.";
  return response(text, { auditEvents: [audit("list_low_stock_products", `Encontrados ${products.length} produto(s) com estoque baixo.`)] });
}

async function history(command: CommandOf<"inventory.history">, { gateway }: HandlerContext) {
  let product: Product | null = null;
  if (command.productQuery) {
    const resolution = await resolveProduct(gateway, command.productQuery);
    if (resolution.status !== "resolved") return unresolvedResponse(resolution, "produto", command.productQuery);
    product = resolution.entity;
  }
  const filters: ListInventoryMovementsInput = {
    productId: product?.id ?? null,
    salesOrderId: command.salesOrderId,
    type: command.type,
    dateRange: command.dateRange,
    take: 25
  };
  const movements = await gateway.listInventoryMovements(filters);
  return response(formatMovementList(movements, filters), {
    auditEvents: [audit("list_inventory_movements", `Listadas ${movements.length} movimentacao(oes) de estoque.`)]
  });
}

async function position(command: CommandOf<"inventory.position">, { gateway }: HandlerContext) {
  const products = await gateway.listProducts({ query: command.productQuery, status: "active", take: 100 });
  const text = products.length
    ? `Estoque atual:\nProduto | Quantidade disponivel\n${products.map((product) => `${product.name} | ${product.availableStock}`).join("\n")}`
    : "Nao encontrei produtos ativos em estoque.";
  return response(text, { auditEvents: [audit("list_inventory_position", `Listada posicao atual de estoque de ${products.length} produto(s).`)] });
}

async function writeOff(command: CommandOf<"inventory.writeoff">, { gateway, lastOrderId }: HandlerContext) {
  const salesOrderId = command.salesOrderId ?? lastOrderId;
  if (!salesOrderId) {
    return response("Qual pedido devo usar para baixar o estoque?");
  }
  const order = await gateway.getSalesOrder({ salesOrderId });
  if (!order) {
    return response(`Nao encontrei o pedido ${salesOrderId}.`);
  }
  let movements: InventoryMovement[];
  try {
    movements = await gateway.writeOffInventoryForSalesOrder({ salesOrderId, reason: `Baixa por pedido ${salesOrderId}` });
  } catch (error) {
    return response(formatInventoryError(error));
  }
  const text = movements.length
    ? `Baixa de estoque realizada para o pedido ${salesOrderId}: ${formatMovementItems(movements)}.`
    : `Nenhuma baixa foi necessaria para o pedido ${salesOrderId}.`;
  return response(text, {
    lastOrderId: salesOrderId,
    auditEvents: [audit("inventory_order_writeoff", `Baixa por pedido executada: ${salesOrderId}.`)]
  });
}

async function move(command: CommandOf<"inventory.move">, { gateway, lastOrderId }: HandlerContext) {
  if (!command.productQuery) {
    return response("Qual produto devo movimentar no estoque?");
  }
  const resolution = await resolveProduct(gateway, command.productQuery);
  if (resolution.status !== "resolved") return unresolvedResponse(resolution, "produto", command.productQuery);
  const product = resolution.entity;
  if (command.quantity == null) {
    return response(`Qual quantidade devo usar para movimentar o estoque de ${product.name}?`);
  }

  const salesOrderId = command.salesOrderId ?? (command.action.startsWith("reservation") ? lastOrderId : null);
  const reason = inventoryReason(command.action, salesOrderId);
  if (command.action === "adjustment") {
    return proposalResponse({
      payload: { kind: "inventory.adjust", productId: product.id, quantity: command.quantity, reason },
      title: "Ajustar estoque",
      summary: `Ajustar o estoque disponivel de ${product.name} (${product.sku}) de ${product.availableStock} para ${command.quantity} unidade(s).`,
      details: [`Reservado: ${product.reservedStock ?? 0}`, `Motivo: ${reason}`]
    });
  }

  const input = { productId: product.id, quantity: command.quantity, salesOrderId, reason };
  let movement: InventoryMovement;
  try {
    movement = command.action === "entry"
      ? await gateway.createInventoryEntry(input)
      : command.action === "exit"
        ? await gateway.createInventoryExit(input)
        : command.action === "reservation"
          ? await gateway.reserveInventory(input)
          : await gateway.releaseInventoryReservation(input);
  } catch (error) {
    return response(formatInventoryError(error));
  }
  return response(formatInventoryMovement(movement), {
    lastOrderId: salesOrderId,
    auditEvents: [audit(`inventory_${command.action}`, `Estoque movimentado: ${product.name}.`)]
  });
}

function formatMovementList(movements: InventoryMovement[], filters: ListInventoryMovementsInput) {
  if (!movements.length) {
    return "Nao encontrei movimentacoes de estoque para esses filtros.";
  }
  const scope = [
    filters.salesOrderId ? `pedido ${filters.salesOrderId}` : null,
    filters.type ? translateInventoryMovementType(filters.type) : null,
    filters.dateRange && filters.dateRange !== "all_time" ? translateDateRange(filters.dateRange) : null
  ].filter(Boolean).join(", ");
  return `${scope ? `Historico de estoque para ${scope}` : "Historico de estoque"}: ${formatMovementItems(movements)}.`;
}

function formatMovementItems(movements: InventoryMovement[]) {
  return movements
    .slice(0, 25)
    .map((movement) =>
      `${formatDate(movement.createdAt)} | ${movement.productName} | ${translateInventoryMovementType(movement.type)} | qtd ${movement.quantity} | disponivel ${movement.previousAvailableStock} -> ${movement.nextAvailableStock} | reservado ${movement.previousReservedStock} -> ${movement.nextReservedStock} | ${movement.salesOrderId ?? "-"} | ${movement.reason ?? "-"}`
    )
    .join("; ");
}
