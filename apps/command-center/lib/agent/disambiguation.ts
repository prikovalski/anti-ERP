import type { ClarificationRequest, Customer, Product, Supplier } from "@anti-erp/shared";

export function createCustomerDisambiguation(query: string, matches: Customer[]): ClarificationRequest {
  return {
    kind: "customer",
    query,
    question: `Encontrei ${matches.length} clientes para "${query}". Qual deles devo usar?`,
    options: matches.map((customer) => ({
      id: customer.id,
      label: customer.name,
      description: [customer.city, customer.taxId, customer.status === "blocked" ? "bloqueado" : "ativo"]
        .filter(Boolean)
        .join(" | ")
    }))
  };
}

export function createProductDisambiguation(query: string, matches: Product[]): ClarificationRequest {
  return {
    kind: "product",
    query,
    question: `Encontrei ${matches.length} produtos para "${query}". Qual deles devo usar?`,
    options: matches.map((product) => ({
      id: product.id,
      label: product.name,
      description: `${product.sku} | estoque ${product.availableStock} | ${money(product.unitPrice)}`
    }))
  };
}

export function createSupplierDisambiguation(query: string, matches: Supplier[]): ClarificationRequest {
  return {
    kind: "supplier",
    query,
    question: `Encontrei ${matches.length} fornecedores para "${query}". Qual deles devo usar?`,
    options: matches.map((supplier) => ({
      id: supplier.id,
      label: supplier.name,
      description: supplier.status === "blocked" ? "inativo" : "ativo"
    }))
  };
}

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
}
