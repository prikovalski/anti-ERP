import { z } from "zod";
import type { CommandOf } from "./commands";
import { cleanProductQuery } from "./text";

const LlmOrderPlanSchema = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  entities: z.object({
    customer: z.object({ name: z.string().nullable() }).nullable().optional(),
    items: z.array(z.object({ product: z.string(), quantity: z.number().int().positive() })).default([]),
    wantsInvoice: z.boolean().default(false)
  }).default({ items: [], wantsInvoice: false })
});

export type LlmOrderResult =
  | { status: "skipped" }
  | { status: "failed"; reason: string }
  | { status: "ok"; command: CommandOf<"order.create">; confidence: number };

const SYSTEM_PROMPT =
  "Voce interpreta solicitacoes livres de um anti-ERP. Retorne somente JSON compacto valido. Nao execute nada. "
  + "Schema: {intent:'sales_order.create'|'unknown', confidence:number, entities:{customer:{name:string|null}|null, items:[{product:string,quantity:number}], wantsInvoice:boolean}}. "
  + "Para pedidos em portugues informal, extraia cliente e itens independentemente da ordem da frase. "
  + "wantsInvoice e false quando o usuario diz 'sem nota'. "
  + "Exemplo: 'crie um pedido com 1 monitor e 1 notebook para o cliente joao' => sales_order.create, customer.name='joao', items monitor/notebook.";

/**
 * Asks the model for a sales-order reading of a message the rules could not parse. Only reads; never executes.
 * Without OPENROUTER_API_KEY the model is not called at all.
 */
export async function inferOrderWithLlm(message: string): Promise<LlmOrderResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { status: "skipped" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENROUTER_TIMEOUT_MS ?? 3500));
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message }
        ]
      })
    });
    if (!response.ok) {
      return { status: "failed", reason: `http_${response.status}` };
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const json = payload.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0];
    if (!json) {
      return { status: "failed", reason: "no_json" };
    }
    const plan = LlmOrderPlanSchema.safeParse(JSON.parse(json));
    if (!plan.success || plan.data.intent !== "sales_order.create") {
      return { status: "failed", reason: plan.success ? "not_an_order" : "invalid_schema" };
    }
    return {
      status: "ok",
      confidence: plan.data.confidence,
      command: {
        kind: "order.create",
        customerQuery: plan.data.entities.customer?.name?.trim() || null,
        lines: plan.data.entities.items.map((item) => ({ productQuery: cleanProductQuery(item.product), quantity: item.quantity })),
        wantsInvoice: plan.data.entities.wantsInvoice,
        mentionsReservation: false
      }
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.name : "unknown_error" };
  } finally {
    clearTimeout(timeout);
  }
}
