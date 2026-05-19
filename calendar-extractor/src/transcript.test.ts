import { describe, it, expect, vi } from "vitest";
import { loadTranscript } from "./transcript";

describe("loadTranscript", () => {
  it("concatenates segments into combinedText", async () => {
    const fakeFetcher = vi.fn().mockResolvedValue({
      segments: [
        { start_time: 100, end_time: 105, speaker_id: "spk1", text: "hello" },
        { start_time: 105, end_time: 110, speaker_id: "spk2", text: "world" },
      ],
    });
    const out = await loadTranscript("sess-1", { fetcher: fakeFetcher });
    expect(out.segments).toHaveLength(2);
    expect(out.combinedText).toContain("hello");
    expect(out.combinedText).toContain("world");
    expect(out.combinedText).toContain("spk1");
    expect(out.combinedText).toContain("spk2");
    expect(fakeFetcher).toHaveBeenCalledWith("sess-1");
  });

  it("throws when transcript is empty", async () => {
    const fakeFetcher = vi.fn().mockResolvedValue({ segments: [] });
    await expect(loadTranscript("sess-x", { fetcher: fakeFetcher })).rejects.toThrow(/empty/i);
  });

  it("throws when segments field is missing", async () => {
    const fakeFetcher = vi.fn().mockResolvedValue({});
    await expect(loadTranscript("sess-y", { fetcher: fakeFetcher })).rejects.toThrow();
  });

  it("includes '?' as speaker label when speaker_id is missing", async () => {
    const fakeFetcher = vi.fn().mockResolvedValue({
      segments: [{ start_time: 0, end_time: 1, text: "anon" }],
    });
    const out = await loadTranscript("sess-z", { fetcher: fakeFetcher });
    expect(out.combinedText).toContain("[?] anon");
  });
});
