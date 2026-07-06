import type { Customer, Product } from "@anti-erp/shared";

export const customers: Customer[] = [
  {
    id: "cus_acme",
    name: "ACME Industries",
    taxId: "12.345.678/0001-90",
    city: "Sao Paulo",
    status: "active"
  },
  {
    id: "cus_globo",
    name: "Globo Retail Labs",
    taxId: "98.765.432/0001-10",
    city: "Rio de Janeiro",
    status: "active"
  },
  {
    id: "cus_legacy",
    name: "Legacy Parts Ltda",
    taxId: "11.222.333/0001-44",
    city: "Curitiba",
    status: "blocked"
  }
];

export const products: Product[] = [
  {
    id: "prd_notebook_air",
    sku: "NB-AIR-14",
    name: "Notebook Air 14",
    unitPrice: 6200,
    availableStock: 37
  },
  {
    id: "prd_monitor_27",
    sku: "MON-27-4K",
    name: "Monitor 27 4K",
    unitPrice: 1950,
    availableStock: 18
  },
  {
    id: "prd_keyboard_pro",
    sku: "KEY-PRO-BR",
    name: "Teclado Pro ABNT2",
    unitPrice: 480,
    availableStock: 52
  }
];
