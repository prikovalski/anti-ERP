import type { CatalogEntity, CatalogStatus } from "./commands";
import { cleanCatalogQuery, cleanEntityName, cleanName, normalizeText, parsePtNumber } from "./text";

const ENTITY_LABEL: Record<CatalogEntity, string> = {
  customer: "cliente",
  product: "produto",
  supplier: "fornecedor"
};

function toEntity(label: string): CatalogEntity {
  const normalized = normalizeText(label);
  return normalized === "fornecedor" ? "supplier" : normalized === "cliente" ? "customer" : "product";
}

function mentionedEntity(normalized: string): CatalogEntity | null {
  if (normalized.includes("fornecedor")) return "supplier";
  if (normalized.includes("cliente")) return "customer";
  if (normalized.includes("produto")) return "product";
  return null;
}

export function extractCatalogCreate(message: string): { entity: CatalogEntity; name: string } | null {
  const match = message.match(/\b(?:cadastre|cadastrar|crie|criar|registre|registrar|adicione|adicionar)\s+(?:o\s+|a\s+|um\s+|uma\s+)?(cliente|produto|fornecedor)\s+(.+)$/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const name = cleanName(match[2]);
  return name ? { entity: toEntity(match[1]), name } : null;
}

/** Catalog creations inside a longer message, used to detect multi-step workflows. */
export function extractCatalogCreations(message: string): Array<{ entity: CatalogEntity; name: string }> {
  const creations: Array<{ entity: CatalogEntity; name: string }> = [];
  for (const entity of ["customer", "product", "supplier"] as const) {
    const match = message.match(
      new RegExp(`\\b(?:cadastre|cadastrar|crie|criar|registre|registrar)\\s+(?:o\\s+|a\\s+|um\\s+|uma\\s+)?${ENTITY_LABEL[entity]}\\s+(.+?)(?=\\s+e\\s+(?:cadastre|cadastrar|crie|criar|registre|registrar|gere|gerar|emita|emitir|fa[cç]a|prepare|liste|relat[oó]rio|um\\s+pedido|uma\\s+nota|a\\s+nota|o\\s+produto|o\\s+cliente|o\\s+fornecedor)|[,.;]|$)`, "i")
    );
    const name = match?.[1] ? cleanName(match[1]) : "";
    if (name) {
      creations.push({ entity, name });
    }
  }
  return creations;
}

export function extractCatalogManagement(message: string):
  | { kind: "catalog.list"; entity: CatalogEntity; query: string | null; status: CatalogStatus | null }
  | { kind: "catalog.set_status"; entity: CatalogEntity; query: string; status: CatalogStatus }
  | { kind: "catalog.rename"; entity: CatalogEntity; query: string; nextName: string }
  | null {
  const normalized = normalizeText(message);
  const entity = mentionedEntity(normalized);
  if (!entity) {
    return null;
  }
  const status: CatalogStatus | null = /\b(inative|inativar|desative|desativar|bloqueie|bloquear|exclua|excluir|remova|remover|delete|deletar|apague|apagar|inativo|inativos)\b/.test(normalized)
    ? "inactive"
    : /\b(ative|ativar|ativo|ativos)\b/.test(normalized)
      ? "active"
      : null;
  if (/\b(liste|listar|mostre|mostrar|exiba|exibir|busque|buscar|procure|procurar)\b/.test(normalized)) {
    return { kind: "catalog.list", entity, query: extractCatalogQuery(message, entity), status };
  }
  if (status) {
    const query = extractCatalogQuery(message, entity);
    return query ? { kind: "catalog.set_status", entity, query, status } : null;
  }
  const renameMatch = message.match(/\b(?:renomeie|renomear|altere\s+o\s+nome\s+d[eo]?)\s+(?:o\s+|a\s+)?(?:produto|cliente|fornecedor)\s+(.+?)\s+(?:para|pra)\s+(.+)$/i);
  if (renameMatch?.[1] && renameMatch[2]) {
    return {
      kind: "catalog.rename",
      entity,
      query: cleanCatalogQuery(renameMatch[1]),
      nextName: cleanCatalogQuery(renameMatch[2])
    };
  }
  return null;
}

function extractCatalogQuery(message: string, entity: CatalogEntity) {
  const match = message.match(new RegExp(`\\b${ENTITY_LABEL[entity]}\\s+(.+?)(?:\\s+(?:ativo|ativos|inativo|inativos|bloqueado|bloqueados))?$`, "i"));
  return match?.[1] ? cleanCatalogQuery(match[1]) || null : null;
}

export function asksToListCustomers(message: string) {
  const normalized = normalizeText(message);
  return /\bclientes\b/.test(normalized)
    && !/\b(compraram|comprou|venderam|vendeu|faturamento|receita|pedido|pedidos)\b/.test(normalized);
}

export function inferCatalogStatus(message: string): "active" | "inactive" | null {
  const normalized = normalizeText(message);
  if (/\b(inativo|inativos|inativa|inativas|bloqueado|bloqueados|bloqueada|bloqueadas)\b/.test(normalized)) return "inactive";
  if (/\b(ativo|ativos|ativa|ativas)\b/.test(normalized)) return "active";
  return null;
}

/** "Atualize o preco/estoque do produto X para N". */
export function extractProductUpdate(message: string): {
  productQuery: string;
  field: "price" | "stock";
  value: number;
} | null {
  const match = message.match(/\b(?:atualize|atualizar|altere|alterar|mude|mudar|defina|definir|ajuste|ajustar)\s+(?:o\s+|a\s+)?(pre[cç]o|valor|estoque)\s+(?:do\s+|da\s+)?produto\s+(.+?)\s+(?:para|pra|por|em)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const productQuery = cleanEntityName(match[2] ?? "");
  const value = parsePtNumber(match[3] ?? "");
  if (!productQuery || value === null) {
    return null;
  }
  const field = normalizeText(match[1] ?? "") === "estoque" ? "stock" : "price";
  return { productQuery, field, value: field === "stock" ? Math.trunc(value) : value };
}
