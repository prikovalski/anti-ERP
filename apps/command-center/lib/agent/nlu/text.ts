import { normalizeText } from "@anti-erp/shared";

export { normalizeText };

const NUMBER_WORDS = new Map<string, number>([
  ["um", 1],
  ["uma", 1],
  ["dois", 2],
  ["duas", 2],
  ["tres", 3],
  ["quatro", 4],
  ["cinco", 5],
  ["seis", 6],
  ["sete", 7],
  ["oito", 8],
  ["nove", 9],
  ["dez", 10],
  ["onze", 11],
  ["doze", 12],
  ["vinte", 20]
]);

/** Regex alternation for a quantity written as digits or as a Portuguese number word. */
export const QUANTITY_TOKEN = "\\d+|um|uma|dois|duas|tres|três|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte";

// Plural forms of the demo catalog vocabulary; anything else is searched as typed.
const SINGULAR_PRODUCT_WORDS: Record<string, string> = {
  monitores: "monitor",
  notebooks: "notebook",
  teclados: "teclado",
  mouses: "mouse"
};

export function parseQuantity(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const normalized = normalizeText(value);
  const word = NUMBER_WORDS.get(normalized) ?? NUMBER_WORDS.get(normalized.split(" ")[0] ?? "");
  if (word) {
    return word;
  }
  const parsed = Number(normalized.replace(",", "."));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Parses "1.234,56", "R$ 50", "12 unidades" or a number word. */
export function parsePtNumber(value: string) {
  const cleaned = value
    .replace(/r\$/gi, "")
    .replace(/\breais?\b/gi, "")
    .replace(/\bunidades?\b/gi, "")
    .replace(/[^\d.,-]/g, "")
    .trim();
  if (!cleaned) {
    return parseQuantity(value);
  }
  const parsed = parseDecimal(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseDecimal(value: string) {
  const normalized = value.includes(",")
    ? value.replace(/\./g, "").replace(",", ".")
    : value;
  return Number(normalized);
}

/** Drops leading articles and catalog labels: "o cliente Maria" -> "Maria". */
export function cleanEntityName(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:(?:de|do|da|dos|das|um|uma|o|a|os|as|cliente|clientes|produto|produtos|fornecedor|fornecedores)\s+)+/i, "")
    .replace(/[.!?]+$/g, "");
}

/** Keeps catalog labels but drops leading articles: used where the label is part of the query. */
export function cleanCatalogQuery(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:o|a|os|as|de|do|da|dos|das)\s+/i, "")
    .replace(/[.!?]+$/g, "");
}

export function cleanName(value: string) {
  return value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "");
}

/** Normalizes a product mention for catalog search: articles, unit words and plural demo words. */
export function cleanProductQuery(value: string) {
  const cleaned = cleanEntityName(value)
    .replace(/\s+(?:para|pra|no|na|do|da)\s+(?:o\s+|a\s+)?pedido\b.*$/i, "")
    .replace(/\b(?:unidades?|quantidades?|itens|item|pcs?|pecas?)\b/gi, "")
    .replace(/\s+(?:para|pra|no|na|do|da|de)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .split(" ")
    .map((word) => SINGULAR_PRODUCT_WORDS[normalizeText(word)] ?? word)
    .join(" ");
}

export function extractSalesOrderId(message: string) {
  const match = normalizeText(message).match(/\bso[-_\s]?(\d+)\b/);
  return match ? `SO-${match[1]}` : null;
}

export function extractInvoiceId(message: string) {
  const match = normalizeText(message).match(/\bci[-_\s]?(\d+)\b/);
  return match ? `CI-${match[1]}` : null;
}

export function mentionsSalesOrder(normalized: string) {
  return /\b(pedido|venda|order)\b/.test(normalized);
}

export function mentionsInvoice(normalized: string) {
  return /\b(nota|notas|nf|nfs|nfe|nfes|nf-e|danfe|fatura|faturas|invoice|invoices)\b/.test(normalized);
}
