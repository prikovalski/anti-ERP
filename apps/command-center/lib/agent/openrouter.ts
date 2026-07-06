import { z } from "zod";

const IntentSchema = z.object({
  intent: z.enum(["create_order", "create_invoice", "list_orders", "traditional_flow", "unknown"]),
  customerQuery: z.string().nullable(),
  productQuery: z.string().nullable(),
  quantity: z.number().int().positive().nullable(),
  wantsInvoice: z.boolean(),
  confidence: z.number().min(0).max(1)
});

export type AgentIntent = z.infer<typeof IntentSchema>;

export async function inferIntentWithOpenRouter(message: string): Promise<AgentIntent | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = process.env.OPENROUTER_MODEL ?? "openrouter/free";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-OpenRouter-Title": "anti-ERP"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You classify user intent for an MCP-native ERP demo. Return only compact JSON with keys: intent, customerQuery, productQuery, quantity, wantsInvoice, confidence. Supported intents: create_order, create_invoice, list_orders, traditional_flow, unknown. Never execute actions."
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 220
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    return null;
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  return IntentSchema.parse(JSON.parse(jsonMatch[0]));
}
