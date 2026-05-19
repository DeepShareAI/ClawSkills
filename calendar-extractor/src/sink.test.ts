import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeCalendarEvents } from "./sink";

describe("writeCalendarEvents", () => {
  beforeEach(() => {
    process.env.JAVIS_SERVER_URL = "http://srv";
    process.env.INTERNAL_SHARED_TOKEN = "secret";
  });

  it("POSTs the payload with the internal token header and returns parsed JSON", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ inserted: 2 }),
    } as any);

    const out = await writeCalendarEvents(
      {
        log_id: "log-1", user_id: "u1", source_session_id: "sess-1",
        events: [{
          title: "A",
          start_at: "2026-05-20T00:00:00Z",
          end_at: "2026-05-20T01:00:00Z",
          source_quote: "q",
          confidence: 0.9,
          attendees: [],
          agenda_items: [],
        }] as any,
      },
      { fetcher: fakeFetch },
    );

    expect(out.inserted).toBe(2);
    expect(fakeFetch).toHaveBeenCalledWith(
      "http://srv/api/internal/calendar/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-internal-token": "secret",
          "content-type": "application/json",
        }),
      }),
    );
    const init = fakeFetch.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({
      log_id: "log-1",
      user_id: "u1",
      source_session_id: "sess-1",
      events: expect.any(Array),
    });
  });

  it("throws on non-ok HTTP response", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ detail: "boom" }),
    } as any);
    await expect(writeCalendarEvents(
      { log_id: "l", user_id: "u", source_session_id: "s", events: [] as any },
      { fetcher: fakeFetch },
    )).rejects.toThrow(/sink HTTP 500/i);
  });

  it("strips trailing slash from JAVIS_SERVER_URL", async () => {
    process.env.JAVIS_SERVER_URL = "http://srv/";
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ inserted: 0 }),
    } as any);
    await writeCalendarEvents(
      { log_id: "l", user_id: "u", source_session_id: "s", events: [] as any },
      { fetcher: fakeFetch },
    );
    expect(fakeFetch.mock.calls[0][0]).toBe("http://srv/api/internal/calendar/events");
  });
});
