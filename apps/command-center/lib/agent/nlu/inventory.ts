import type { InventoryMovementType } from "@anti-erp/shared";
import type { Command, InventoryMoveAction } from "./commands";
import { inferDateRange } from "./dates";
import { cleanCatalogQuery, cleanProductQuery, extractSalesOrderId, normalizeText } from "./text";

type InventoryCommand = Extract<Command, { kind: `inventory.${string}` }>;

export function extractInventoryCommand(message: string): InventoryCommand | null {
  const normalized = normalizeText(message);
  const mentionsInventory =
    /\b(estoque|estoques|entrada|saida|ajuste|ajustar|reserve|reservar|reserva|reservado|libere|liberar|baixa|baixar|baixe|historico|movimentacoes)\b/.test(normalized)
    || (/\b(adicione|adicionar|inclua|incluir)\b/.test(normalized)
      && /\b(quantidade|quantidades|unidade|unidades)\b/.test(normalized)
      && /\b(item|produto)\b/.test(normalized)
      && !/\bpedido\b/.test(normalized));
  if (!mentionsInventory) {
    return null;
  }

  const salesOrderId = extractSalesOrderId(message);
  const productQuery = extractInventoryProductQuery(message);

  if (/\b(baixo|baixa|minimo|minima|critico|critica|alerta)\b/.test(normalized) && /\bestoque\b/.test(normalized)) {
    return { kind: "inventory.low_stock", threshold: extractThreshold(normalized) };
  }
  if (/\b(historico|movimentacoes|movimentos|extrato)\b/.test(normalized) && /\b(estoque|movimentacoes|movimentos)\b/.test(normalized)) {
    return {
      kind: "inventory.history",
      productQuery,
      salesOrderId,
      type: inferMovementType(normalized),
      dateRange: inferDateRange(message)
    };
  }
  if (/\b(liste|listar|mostre|mostrar|consultar|consulte|exiba|exibir|quais)\b/.test(normalized)
    && /\b(estoque|estoques|saldo|saldos|disponivel|disponiveis)\b/.test(normalized)) {
    return { kind: "inventory.position", productQuery };
  }
  if (/\b(baixa|baixar|baixe)\b/.test(normalized) && /\bpedido\b/.test(normalized)) {
    return { kind: "inventory.writeoff", salesOrderId };
  }
  const action = inferMoveAction(normalized);
  if (!action) {
    return null;
  }
  return { kind: "inventory.move", action, productQuery, quantity: extractQuantity(normalized), salesOrderId };
}

/** Low-stock questions phrased without the inventory keywords above, e.g. "o que precisa repor?". */
export function asksInventoryDiagnostic(message: string) {
  return /\bestoque\s+baixo\b|\bbaixo\s+estoque\b|\breposi[cç]ao\b|\brepor\b|\bacabando\b/.test(normalizeText(message));
}

function inferMoveAction(normalized: string): InventoryMoveAction | null {
  if (/\b(libere|liberar|libera|solte|soltar|cancelar reserva|cancele reserva)\b/.test(normalized)) return "reservation_release";
  if (/\b(reserve|reservar|reserva)\b/.test(normalized)) return "reservation";
  if (/\b(ajuste|ajustar|ajusta|atualize|atualizar|defina|definir)\b/.test(normalized) && /\bestoque\b/.test(normalized)) return "adjustment";
  if (/\b(entrada|entrar|recebimento|receber|adicione|adicionar|inclua|incluir)\b/.test(normalized)
    && /\b(estoque|produto|item|unidade|unidades|quantidade|quantidades)\b/.test(normalized)) return "entry";
  if (/\b(saida|retirada|retirar|remova|remover)\b/.test(normalized) && /\b(estoque|produto|unidade|unidades)\b/.test(normalized)) return "exit";
  return null;
}

function inferMovementType(normalized: string): InventoryMovementType | null {
  if (/\b(entrada|recebimento)\b/.test(normalized)) return "entry";
  if (/\b(saida|retirada)\b/.test(normalized)) return "exit";
  if (/\b(ajuste|manual)\b/.test(normalized)) return "adjustment";
  if (/\breserva\b/.test(normalized) && /\b(libere|liberar|cancelar|cancele)\b/.test(normalized)) return "reservation_release";
  if (/\b(reserva|reservado)\b/.test(normalized)) return "reservation";
  if (/\b(baixa|pedido)\b/.test(normalized)) return "order_writeoff";
  return null;
}

function extractQuantity(normalized: string) {
  const target = normalized.match(/\b(?:para|em)\s+(\d+)\b/);
  if (target && /\b(ajuste|ajustar|atualize|defina|estoque)\b/.test(normalized)) {
    return Number(target[1]);
  }
  const match = normalized.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function extractThreshold(normalized: string) {
  const match = normalized.match(/\b(?:abaixo de|menor que|ate|<=?)\s*(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function extractInventoryProductQuery(message: string) {
  const stopBeforeOrderOrStock = "(?=\\s+(?:para|pra|com|no|na|do|da|em|ao|a)\\s+(?:o\\s+|a\\s+)?(?:pedido|estoque|\\d)|[.!?]?$)";
  const candidates = [
    message.match(new RegExp(`\\b(?:ao|a|no|na|do|da)\\s+(?:item|produto)\\s+(.+?)${stopBeforeOrderOrStock}`, "i")),
    message.match(new RegExp(`\\b(?:produto|item)\\s+(.+?)${stopBeforeOrderOrStock}`, "i")),
    message.match(/\b\d+\s+(?:unidades?|quantidades?)?\s+(?:d[eo]s?\s+)?(.+?)(?=\s+(?:para|pra|no|na|do|da)\s+(?:o\s+|a\s+)?(?:pedido|estoque)|[.!?]?$)/i)
  ];
  const match = candidates.find((candidate) => candidate?.[1]);
  if (match?.[1]) {
    return cleanProductQuery(cleanCatalogQuery(match[1])) || null;
  }
  const stockMatch = message.match(/\b(?:estoque|entrada|saida|reserva)\s+(?:d[eo]\s+)?(?:produto\s+)?(.+?)(?=\s+(?:para|pra|no|na|do|da)\s+(?:o\s+|a\s+)?pedido|[.!?]?$)/i);
  if (stockMatch?.[1] && !/\b(pedido|baixo|baixa|minimo|historico|movimentacoes)\b/i.test(stockMatch[1])) {
    return cleanProductQuery(cleanCatalogQuery(stockMatch[1])) || null;
  }
  return null;
}

export function inventoryReason(action: InventoryMoveAction, salesOrderId: string | null) {
  if (action === "entry") return "Entrada de estoque por comando em linguagem natural";
  if (action === "exit") return "Saida de estoque por comando em linguagem natural";
  if (action === "adjustment") return "Ajuste manual de estoque por comando em linguagem natural";
  if (action === "reservation") return salesOrderId ? `Reserva para pedido ${salesOrderId}` : "Reserva de estoque por comando em linguagem natural";
  return salesOrderId ? `Liberacao de reserva do pedido ${salesOrderId}` : "Liberacao de reserva por comando em linguagem natural";
}
