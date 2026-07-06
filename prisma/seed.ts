import { PrismaClient } from "@prisma/client";
import { demoCustomers, demoProducts } from "@anti-erp/shared";

const prisma = new PrismaClient();

function toCents(value: number) {
  return Math.round(value * 100);
}

async function main() {
  await Promise.all([
    ...demoCustomers.map((customer) =>
      prisma.customer.upsert({
        where: { id: customer.id },
        update: {
          name: customer.name,
          taxId: customer.taxId,
          city: customer.city,
          status: customer.status
        },
        create: customer
      })
    ),
    ...demoProducts.map((product) =>
      prisma.product.upsert({
        where: { id: product.id },
        update: {
          sku: product.sku,
          name: product.name,
          unitPriceCents: toCents(product.unitPrice),
          availableStock: product.availableStock
        },
        create: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          unitPriceCents: toCents(product.unitPrice),
          availableStock: product.availableStock
        }
      })
    ),
    prisma.sequenceCounter.upsert({
      where: { name: "sales_order" },
      update: {},
      create: {
        name: "sales_order",
        nextValue: 1001
      }
    }),
    prisma.sequenceCounter.upsert({
      where: { name: "concept_invoice" },
      update: {},
      create: {
        name: "concept_invoice",
        nextValue: 5001
      }
    })
  ]);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
