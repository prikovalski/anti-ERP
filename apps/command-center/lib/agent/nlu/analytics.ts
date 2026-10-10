import type { AnalyticsDateRange, AnalyticsGroupBy, AnalyticsMetric } from "@anti-erp/shared";
import { inferDateRange } from "./dates";
import { cleanEntityName, cleanProductQuery, normalizeText } from "./text";

export type ExtractedAnalytics = {
  metric: AnalyticsMetric;
  groupBy: AnalyticsGroupBy | null;
  dateRange: AnalyticsDateRange;
  productQueries: string[];
  customerQuery: string | null;
};

export function extractAnalytics(message: string): ExtractedAnalytics {
  const normalized = normalizeText(message);
  return {
    metric: inferMetric(normalized),
    groupBy: inferGroupBy(normalized),
    dateRange: inferDateRange(message),
    productQueries: inferProductQueries(normalized),
    customerQuery: inferCustomerFilter(normalized)
  };
}

/** Questions answered by the intelligent report (SQL over the semantic catalog). */
export function isManagerialReportRequest(message: string) {
  const normalized = normalizeText(message);
  if (!/\b(relatorio|gerencial|analise|indicadores|dashboard|ranking|tendencia|evolucao|margem|lucro|rentabilidade|ruptura|estoque baixo|clientes ativos|produto mais vendido|produtos mais vendidos|produto|produtos|vendido|vendidos|faturamento|receita|valor total|totalize|totalizar|vendas)\b/.test(normalized)) {
    return false;
  }
  return /\b(venda|vendas|vendido|vendidos|faturamento|receita|valor total|totalize|totalizar|ranking|tendencia|evolucao|margem|lucro|rentabilidade|ruptura|estoque baixo|clientes ativos|produto mais vendido|produtos mais vendidos|top|periodo|hoje|semana|mes|30 dias|trinta dias)\b/.test(normalized);
}

export function isVagueReportRequest(message: string) {
  const normalized = normalizeText(message);
  return /\b(relatorio|relatorios|dashboard|analise|indicadores)\b/.test(normalized)
    && !/\b(venda|vendas|pedido|pedidos|faturamento|receita|ranking|tendencia|evolucao|margem|lucro|rentabilidade|ruptura|estoque|cliente|clientes|produto|produtos|mais vendido|top|hoje|semana|mes|periodo)\b/.test(normalized);
}

export function asksAnalytics(message: string) {
  return /\b(quantos|quanto|qual|quais|ranking|vendemos|vendidos|vendeu|venderam|saindo|saiu|comprou|compraram|faturamento|faturamos|receita|relatorio|resumo|analise|indicadores)\b/.test(normalizeText(message));
}

export function asksTraditionalFlow(message: string) {
  return /\b(tradicional|erp classico|erp tradicional)\b/.test(normalizeText(message));
}

function inferMetric(normalized: string): AnalyticsMetric {
  if (/\b(pedidos|pedido)\b/.test(normalized) && /\b(quantos|quantidade|total)\b/.test(normalized)) {
    return "order_count";
  }
  if (/\b(faturamento|faturamos|faturado|receita|valor|quanto|ticket)\b/.test(normalized) && !/\bquantos\b/.test(normalized)) {
    return "revenue";
  }
  return "units_sold";
}

function inferGroupBy(normalized: string): AnalyticsGroupBy | null {
  if (/\b(compare|comparar|comparativo|versus|vs\.?|contra|entre)\b/.test(normalized)) return "product";
  if (/\bpor\s+cliente\b|\bclientes\b/.test(normalized)) return "customer";
  if (/\bpor\s+produto\b|\bprodutos\b|\branking\b|\bmais\s+(venderam|vendeu|sairam|saiu)\b|\bo\s+que\s+mais\s+saiu\b/.test(normalized)) return "product";
  if (/\bpor\s+dia\b|\bdia\s+a\s+dia\b|\bdiario\b/.test(normalized)) return "day";
  return null;
}

// Product words of the demo catalog plus an explicit "produto X" filter.
function inferProductQueries(normalized: string) {
  const known = [
    /\bmonitores?\b/.test(normalized) ? "monitor" : null,
    /\bnotebooks?\b/.test(normalized) ? "notebook" : null,
    /\bteclados?\b/.test(normalized) ? "teclado" : null,
    /\bmouses?\b/.test(normalized) ? "mouse" : null
  ].filter((product): product is string => Boolean(product));
  const explicit = normalized.match(/\b(?:produto|item)\s+([a-z0-9][a-z0-9\s-]+?)(?=\s+(?:hoje|na\s+semana|no\s+mes|por|para|$))/);
  if (explicit?.[1]) {
    known.push(cleanProductQuery(explicit[1]));
  }
  return Array.from(new Set(known));
}

function inferCustomerFilter(normalized: string) {
  const match = normalized.match(/\b(?:cliente|para|da|do)\s+([a-z0-9][a-z0-9\s-]+?)(?=\s+(?:hoje|na\s+semana|no\s+mes|por|$))/);
  const value = match?.[1] ? cleanEntityName(match[1]) : null;
  // "do mes", "da semana" are periods, not customers.
  return value && !/^(mes|semana|dia|periodo|ano)$/.test(value) ? value : null;
}
