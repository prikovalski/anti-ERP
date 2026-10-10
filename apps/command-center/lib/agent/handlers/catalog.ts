import type { Customer, Product, Supplier } from "@anti-erp/shared";
import { recordAgentStep } from "../../observability/mcp-trace";
import { formatMoney } from "../agent-messages";
import { resolveCustomer, resolveProduct, resolveSupplier } from "../entity-resolution";
import type { CatalogEntity, CommandOf } from "../nlu/commands";
import { audit, proposalResponse, response, unresolvedResponse } from "../responses";
import type { AgentHandler, HandlerContext } from "./types";

type CatalogCommand = CommandOf<"catalog.create" | "catalog.list" | "catalog.set_status" | "catalog.rename" | "product.update_price">;

const LABEL: Record<CatalogEntity, string> = { customer: "cliente", product: "produto", supplier: "fornecedor" };

export const catalogHandler: AgentHandler<CatalogCommand> = {
  name: "catalog",
  match: (command): command is CatalogCommand => command.kind.startsWith("catalog.") || command.kind === "product.update_price",
  async execute(command, context) {
    switch (command.kind) {
      case "catalog.create":
        return create(command, context);
      case "catalog.list":
        return list(command, context);
      case "catalog.set_status":
        return setStatus(command, context);
      case "catalog.rename":
        return rename(command, context);
      case "product.update_price":
        return updatePrice(command, context);
    }
  }
};

async function create(command: CommandOf<"catalog.create">, { gateway }: HandlerContext) {
  try {
    const record = command.entity === "customer"
      ? await gateway.createCustomer({ name: command.name })
      : command.entity === "product"
        ? await gateway.createProduct({ name: command.name })
        : await gateway.createSupplier({ name: command.name });
    return response(`${record.name} cadastrado com sucesso.`, {
      auditEvents: [audit(`create_${command.entity}`, `Cadastro criado: ${record.name}.`)]
    });
  } catch (error) {
    if (error instanceof Error && /already exists/i.test(error.message)) {
      await recordAgentStep({
        name: "controlled_error.duplicate_catalog",
        kind: "error",
        status: "error",
        durationMs: 0,
        inputs: { entity: command.entity, name: command.name },
        error
      });
      return response(`Nao cadastrei ${command.name}, porque ja existe um ${LABEL[command.entity]} com exatamente esse nome.`);
    }
    throw error;
  }
}

async function list(command: CommandOf<"catalog.list">, { gateway }: HandlerContext) {
  const filters = { query: command.query, status: command.status, take: 25 };
  if (command.entity === "product") {
    const products = await gateway.listProducts(filters);
    return response(formatProductList(products), { auditEvents: [audit("list_products", `Listados ${products.length} produto(s).`)] });
  }
  if (command.entity === "supplier") {
    const suppliers = await gateway.listSuppliers(filters);
    return response(formatSupplierList(suppliers), { auditEvents: [audit("list_suppliers", `Listados ${suppliers.length} fornecedor(es).`)] });
  }
  const customers = await gateway.searchCustomersAdvanced(filters);
  return response(formatCustomerList(customers), { auditEvents: [audit("search_customers_advanced", `Listados ${customers.length} cliente(s).`)] });
}

async function setStatus(command: CommandOf<"catalog.set_status">, { gateway }: HandlerContext) {
  const activate = command.status === "active";
  const verb = activate ? "Ativar" : "Inativar";
  if (command.entity === "product") {
    const resolution = await resolveProduct(gateway, command.query);
    if (resolution.status !== "resolved") return unresolvedResponse(resolution, "produto", command.query);
    const product = resolution.entity;
    return proposalResponse({
      payload: { kind: "product.update", productId: product.id, status: activate ? "active" : "inactive" },
      title: `${verb} produto`,
      summary: `${verb} o produto ${product.name} (${product.sku}).`,
      details: [`Status atual: ${product.status === "active" ? "ativo" : "inativo"}`]
    });
  }
  if (command.entity === "supplier") {
    const resolution = await resolveSupplier(gateway, command.query);
    if (resolution.status !== "resolved") return unresolvedResponse(resolution, "fornecedor", command.query);
    const supplier = resolution.entity;
    return proposalResponse({
      payload: { kind: "supplier.update", supplierId: supplier.id, status: command.status },
      title: `${verb} fornecedor`,
      summary: `${verb} o fornecedor ${supplier.name}.`,
      details: [`Status atual: ${supplier.status === "active" ? "ativo" : "inativo"}`]
    });
  }
  const resolution = await resolveCustomer(gateway, command.query);
  if (resolution.status !== "resolved") return unresolvedResponse(resolution, "cliente", command.query);
  const customer = resolution.entity;
  return proposalResponse({
    payload: { kind: "customer.update", customerId: customer.id, status: command.status },
    title: `${verb} cliente`,
    summary: `${verb} o cliente ${customer.name} (${customer.taxId}).`,
    details: [`Status atual: ${customer.status === "active" ? "ativo" : "bloqueado"}`, `Cidade: ${customer.city}`]
  });
}

async function rename(command: CommandOf<"catalog.rename">, { gateway }: HandlerContext) {
  if (command.entity === "product") {
    const resolution = await resolveProduct(gateway, command.query);
    if (resolution.status !== "resolved") return unresolvedResponse(resolution, "produto", command.query);
    return proposalResponse({
      payload: { kind: "product.update", productId: resolution.entity.id, name: command.nextName },
      title: "Renomear produto",
      summary: `Renomear o produto ${resolution.entity.name} para ${command.nextName}.`
    });
  }
  if (command.entity === "supplier") {
    const resolution = await resolveSupplier(gateway, command.query);
    if (resolution.status !== "resolved") return unresolvedResponse(resolution, "fornecedor", command.query);
    return proposalResponse({
      payload: { kind: "supplier.update", supplierId: resolution.entity.id, name: command.nextName },
      title: "Renomear fornecedor",
      summary: `Renomear o fornecedor ${resolution.entity.name} para ${command.nextName}.`
    });
  }
  const resolution = await resolveCustomer(gateway, command.query);
  if (resolution.status !== "resolved") return unresolvedResponse(resolution, "cliente", command.query);
  return proposalResponse({
    payload: { kind: "customer.update", customerId: resolution.entity.id, name: command.nextName },
    title: "Renomear cliente",
    summary: `Renomear o cliente ${resolution.entity.name} para ${command.nextName}.`
  });
}

async function updatePrice(command: CommandOf<"product.update_price">, { gateway }: HandlerContext) {
  const resolution = await resolveProduct(gateway, command.productQuery);
  if (resolution.status !== "resolved") return unresolvedResponse(resolution, "produto", command.productQuery);
  const product = resolution.entity;
  return proposalResponse({
    payload: { kind: "product.update", productId: product.id, unitPrice: command.unitPrice },
    title: "Atualizar produto",
    summary: `Atualizar o produto ${product.name} (${product.sku}): preco ${formatMoney(product.unitPrice)} -> ${formatMoney(command.unitPrice)}.`
  });
}

function formatCustomerList(customers: Customer[]) {
  if (!customers.length) return "Nao encontrei clientes para esses filtros.";
  return `Encontrei ${customers.length} cliente(s): ${customers
    .slice(0, 12)
    .map((customer) => `${customer.name} (${customer.city}, ${customer.status === "active" ? "ativo" : "inativo"})`)
    .join("; ")}.`;
}

function formatSupplierList(suppliers: Supplier[]) {
  if (!suppliers.length) return "Nao encontrei fornecedores para esses filtros.";
  return `Encontrei ${suppliers.length} fornecedor(es): ${suppliers
    .slice(0, 12)
    .map((supplier) => `${supplier.name} (${supplier.status === "active" ? "ativo" : "inativo"})`)
    .join("; ")}.`;
}

function formatProductList(products: Product[]) {
  if (!products.length) return "Nao encontrei produtos para esses filtros.";
  return `Encontrei ${products.length} produto(s): ${products
    .slice(0, 12)
    .map((product) => `${product.name} (${product.sku}, ${product.status === "inactive" ? "inativo" : "ativo"}, disponivel ${product.availableStock}, reservado ${product.reservedStock ?? 0}, preco ${formatMoney(product.unitPrice)})`)
    .join("; ")}.`;
}
