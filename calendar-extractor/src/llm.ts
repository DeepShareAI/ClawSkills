import { ZodSchema } from "zod";
import OpenAI from "openai";

export interface StructuredCallArgs<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodSchema<T>;
  // Test seam — returns the raw model JSON string. Defaults to OpenAI chat completions.
  runCompletion?: (system: string, user: string) => Promise<string>;
  model?: string;
}

const _defaultRunCompletion = async (system: string, user: string): Promise<string> => {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
};

export async function structuredCall<T>(args: StructuredCallArgs<T>): Promise<T> {
  const runCompletion = args.runCompletion ?? _defaultRunCompletion;
  const raw = await runCompletion(args.systemPrompt, args.userPrompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM output parse error: ${err}`);
  }
  const result = args.schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`LLM output schema error: ${result.error.message}`);
  }
  return result.data;
}
