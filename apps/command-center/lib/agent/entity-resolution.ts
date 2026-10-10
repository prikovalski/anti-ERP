import { normalizeText, type ClarificationRequest, type Customer, type Product, type Supplier } from "@anti-erp/shared";
import type { CapabilityGateway } from "../capabilities";
import { createCustomerDisambiguation, createProductDisambiguation, createSupplierDisambiguation } from "./disambiguation";

const MAX_OPTIONS = 8;

export type EntityResolution<T> =
  | { status: "resolved"; entity: T }
  | { status: "not_found" }
  | { status: "ambiguous"; clarification: ClarificationRequest };

type Resolvable = { id: string; name: string; sku?: string; taxId?: string };

function isExactMatch(candidate: Resolvable, query: string) {
  const normalizedQuery = normalizeText(query);
  return normalizeText(candidate.name) === normalizedQuery
    || Boolean(candidate.sku && normalizeText(candidate.sku) === normalizedQuery)
    || Boolean(candidate.taxId && candidate.taxId === query.trim());
}

/**
 * Picks one entity only when the choice is unambiguous: a single exact match, or a single candidate.
 * Several partial matches (e.g. "la" -> "Northstar Labs" and "Globo Retail Labs") become a question.
 */
export function resolveCandidates<T extends Resolvable>(
  query: string,
  candidates: T[],
  toClarification: (query: string, matches: T[]) => ClarificationRequest
): EntityResolution<T> {
  const unique = Array.from(new Map(candidates.map((candidate) => [candidate.id, candidate])).values());
  if (!unique.length) {
    return { status: "not_found" };
  }
  const exact = unique.filter((candidate) => isExactMatch(candidate, query));
  if (exact.length === 1) {
    return { status: "resolved", entity: exact[0]! };
  }
  if (unique.length === 1) {
    return { status: "resolved", entity: unique[0]! };
  }
  const options = (exact.length > 1 ? exact : unique).slice(0, MAX_OPTIONS);
  return { status: "ambiguous", clarification: toClarification(query, options) };
}

export async function resolveCustomer(gateway: CapabilityGateway, query: string): Promise<EntityResolution<Customer>> {
  return resolveCandidates(query, await gateway.searchCustomer({ query }), createCustomerDisambiguation);
}

export async function resolveProduct(gateway: CapabilityGateway, query: string): Promise<EntityResolution<Product>> {
  return resolveCandidates(query, await gateway.searchProduct({ query }), createProductDisambiguation);
}

export async function resolveSupplier(gateway: CapabilityGateway, query: string): Promise<EntityResolution<Supplier>> {
  return resolveCandidates(query, await gateway.searchSupplier({ query }), createSupplierDisambiguation);
}

export function describeClarification(clarification: ClarificationRequest) {
  const options = clarification.options.map((option) => option.label).join("; ");
  return `${clarification.question} Opcoes: ${options}. Repita o comando com o nome completo.`;
}
