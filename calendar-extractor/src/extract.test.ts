import { describe, it, expect, vi } from "vitest";
import { extractCalendarEvents } from "./extract";

const transcript = `
[spk1] So when can we meet next?
[spk2] How about Wednesday afternoon? I can show you the facility.
[spk1] Wednesday works. Two PM Pacific?
[spk2] Perfect.
`;

describe("extractCalendarEvents", () => {
  it("returns parsed candidates anchored on session date", async () => {
    const fakeCompletion = vi.fn().mockResolvedValue(JSON.stringify({
      events: [{
        title: "Facility visit",
        subtitle: "Tour with spk2",
        start_at: "2026-05-20T21:00:00Z",
        end_at: "2026-05-20T22:00:00Z",
        location: "Healthcare facility",
        attendees: [{ name: "spk2" }],
        agenda_items: [{ topic: "Facility tour" }],
        source_quote: "Wednesday works. Two PM Pacific?",
        confidence: 0.85,
      }],
    }));
    const out = await extractCalendarEvents({
      transcript,
      user_timezone: "America/Los_Angeles",
      session_started_at: "2026-05-19T04:13:00Z",
      runCompletion: fakeCompletion,
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Facility visit");
  });

  it("filters out below confidence threshold", async () => {
    const fakeCompletion = vi.fn().mockResolvedValue(JSON.stringify({
      events: [{
        title: "Maybe dentist",
        start_at: "2026-05-22T17:00:00Z",
        end_at: "2026-05-22T18:00:00Z",
        attendees: [], agenda_items: [],
        source_quote: "speaker mentioned a dentist",
        confidence: 0.4,
      }],
    }));
    const out = await extractCalendarEvents({
      transcript: "x", user_timezone: "UTC", session_started_at: "2026-05-19T00:00:00Z",
      runCompletion: fakeCompletion,
    });
    expect(out).toHaveLength(0);
  });

  it("returns [] when LLM finds no events", async () => {
    const fakeCompletion = vi.fn().mockResolvedValue(JSON.stringify({ events: [] }));
    const out = await extractCalendarEvents({
      transcript: "x", user_timezone: "UTC", session_started_at: "2026-05-19T00:00:00Z",
      runCompletion: fakeCompletion,
    });
    expect(out).toEqual([]);
  });

  it("passes the anchoring inputs into the user prompt", async () => {
    const fakeCompletion = vi.fn().mockImplementation((_system: string, user: string) => {
      // Verify the user prompt contains the anchoring info
      expect(user).toContain("SESSION_STARTED_AT: 2026-05-19T04:13:00Z");
      expect(user).toContain("USER_TIMEZONE: America/Los_Angeles");
      return Promise.resolve(JSON.stringify({ events: [] }));
    });
    await extractCalendarEvents({
      transcript: "anything",
      user_timezone: "America/Los_Angeles",
      session_started_at: "2026-05-19T04:13:00Z",
      runCompletion: fakeCompletion,
    });
    expect(fakeCompletion).toHaveBeenCalled();
  });
});
