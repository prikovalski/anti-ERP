import { z } from "zod";
import {
  extractCustomerQuery,
  extractFiscalIntent,
  extractOrderLines,
  normalizeText
} from "./entity-extractor";

const SemanticPlanSchema = z.object({
  intent: z.enum([
    "sales_order.create",
    "invoice.create",
    "catalog.create",
    "catalog.update",
    "inventory.move",
    "report.query",
    "unknown"
  ]),
  confidence: z.number().min(0).max(1),
  entities: z.object({
    customer: z.object({
      name: z.string().nullable()
    }).nullable().optional(),
    items: z.array(
      z.object({
        product: z.string(),
        quantity: z.number().int().positive()
      })
    ).default([]),
    wantsInvoice: z.boolean().default(false)
  }).default({ items: [], wantsInvoice: false }),
  steps: z.array(z.enum([
    "resolve_customer",
    "resolve_products",
    "validate_stock",
    "prepare_sales_order",
    "create_invoice",
    "ask_clarification"
  ])).default([])
});

export type SemanticPlan = z.infer<typeof SemanticPlanSchema>;

export async function buildSemanticPlan(message: string): Promise<SemanticPlan | null> {
  const local = buildLocalSemanticPlan(message);
  if (local && local.confidence >= 0.82) {
    return local;
  }

  const remote = await inferSemanticPlanWithOpenRouter(message);
  return remote ?? local;
}

export function buildLocalSemanticPlan(message: string): SemanticPlan | null {
  const normalized = normalizeText(message);
  const mentionsOrder = /\b(pedido|venda|order)\b/.test(normalized);
  const lines = extractOrderLines(message).map((line) => ({
    product: line.productQuery,
    quantity: line.quantity
  }));
  const customerName = extractCustomerQuery(message);
  const wantsInvoice = extractFiscalIntent(message);

  if (!mentionsOrder && !lines.length) {
    return null;
  }

  const steps: SemanticPlan["steps"] = [];
  if (customerName) steps.push("resolve_customer");
  if (lines.length) steps.push("resolve_products", "validate_stock");
  if (customerName && lines.length) steps.push("prepare_sales_order");
  if (wantsInvoice) steps.push("create_invoice");
  if (!customerName || !lines.length) steps.push("ask_clarification");

  return SemanticPlanSchema.parse({
    intent: "sales_order.create",
    confidence: customerName && lines.length ? 0.9 : 0.62,
    entities: {
      customer: { name: customerName },
      items: lines,
      wantsInvoice
    },
    steps
  });
}

async function inferSemanticPlanWithOpenRouter(message: string): Promise<SemanticPlan | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS ?? 3500);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
        "X-OpenRouter-Title": "anti-ERP"
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL ?? "openrouter/free",
        temperature: 0,
        max_tokens: 360,
        messages: [
          {
            role: "system",
            content:
              "Voce interpreta solicitacoes livres de um anti-ERP. Retorne somente JSON compacto valido. Nao execute nada. Schema: {intent:'sales_order.create'|'invoice.create'|'catalog.create'|'catalog.update'|'inventory.move'|'report.query'|'unknown', confidence:number, entities:{customer:{name:string|null}|null, items:[{product:string,quantity:number}], wantsInvoice:boolean}, steps:string[]}. Para pedidos em portugues informal, extraia cliente e itens independentemente da ordem da frase. Exemplo: 'crie um pedido com 1 monitor e 1 notebook para o cliente joao' => sales_order.create, customer.name='joao', items monitor/notebook."
          },
          { role: "user", content: message }
        ]
      })
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  const jsonMatch = content?.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    return SemanticPlanSchema.parse(JSON.parse(jsonMatch[0]));
  } catch {
    return null;
  }
}
