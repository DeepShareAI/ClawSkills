import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { structuredCall } from "./llm";

const schema = z.object({
  events: z.array(z.object({ title: z.string(), confidence: z.number() })),
});

describe("structuredCall", () => {
  it("parses well-formed model output", async () => {
    const fakeCompletion = vi.fn().mockResolvedValue(
      JSON.stringify({ events: [{ title: "Demo", confidence: 0.9 }] }),
    );
    const out = await structuredCall({
      systemPrompt: "extract", userPrompt: "x",
      schema, runCompletion: fakeCompletion,
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0].title).toBe("Demo");
  });

  it("throws on invalid JSON", async () => {
    const runCompletion = vi.fn().mockResolvedValue("not json");
    await expect(structuredCall({
      systemPrompt: "x", userPrompt: "y", schema, runCompletion,
    })).rejects.toThrow(/parse/i);
  });

  it("throws on schema mismatch", async () => {
    const runCompletion = vi.fn().mockResolvedValue(
      JSON.stringify({ events: [{ title: 1, confidence: "high" }] }),
    );
    await expect(structuredCall({
      systemPrompt: "x", userPrompt: "y", schema, runCompletion,
    })).rejects.toThrow(/schema/i);
  });

  it("passes prompts to runCompletion", async () => {
    const runCompletion = vi.fn().mockResolvedValue(
      JSON.stringify({ events: [] }),
    );
    await structuredCall({
      systemPrompt: "SYSTEM", userPrompt: "USER",
      schema, runCompletion,
    });
    expect(runCompletion).toHaveBeenCalledWith("SYSTEM", "USER");
  });
});
