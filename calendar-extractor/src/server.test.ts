import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./transcript", () => ({
  loadTranscript: vi.fn().mockResolvedValue({
    segments: [{ start_time: 0, end_time: 1, text: "hello" }],
    combinedText: "[?] hello",
  }),
}));
vi.mock("./extract", () => ({
  extractCalendarEvents: vi.fn().mockResolvedValue([{
    title: "Demo",
    start_at: "2026-05-20T00:00:00Z",
    end_at: "2026-05-20T01:00:00Z",
    source_quote: "q",
    confidence: 0.9,
    attendees: [],
    agenda_items: [],
  }]),
}));
vi.mock("./sink", () => ({
  writeCalendarEvents: vi.fn().mockResolvedValue({ inserted: 1 }),
}));

import { createServer } from "./server";

describe("POST /run-for-session/:id", () => {
  beforeEach(() => {
    process.env.INTERNAL_SHARED_TOKEN = "secret";
  });

  it("returns succeeded with result_count when events are extracted", async () => {
    const app = createServer();
    const r = await request(app)
      .post("/run-for-session/sess-1")
      .set("x-internal-token", "secret")
      .send({
        log_id: "L1",
        attempt: 1,
        user_id: "u1",
        user_timezone: "UTC",
        session_started_at: "2026-05-19T00:00:00Z",
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "succeeded", result_count: 1 });
  });

  it("returns skipped when extractor finds nothing", async () => {
    const { extractCalendarEvents } = await import("./extract");
    (extractCalendarEvents as any).mockResolvedValueOnce([]);
    const app = createServer();
    const r = await request(app)
      .post("/run-for-session/sess-2")
      .set("x-internal-token", "secret")
      .send({
        log_id: "L2", attempt: 1, user_id: "u1",
        user_timezone: "UTC", session_started_at: "2026-05-19T00:00:00Z",
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "skipped", result_count: 0 });
  });

  it("returns 500 with status:failed on extractor crash", async () => {
    const { extractCalendarEvents } = await import("./extract");
    (extractCalendarEvents as any).mockRejectedValueOnce(new Error("LLM down"));
    const app = createServer();
    const r = await request(app)
      .post("/run-for-session/sess-3")
      .set("x-internal-token", "secret")
      .send({
        log_id: "L3", attempt: 1, user_id: "u1",
        user_timezone: "UTC", session_started_at: "2026-05-19T00:00:00Z",
      });
    expect(r.status).toBe(500);
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toContain("LLM down");
  });

  it("400s on missing required body fields", async () => {
    const app = createServer();
    const r = await request(app)
      .post("/run-for-session/sess-4")
      .set("x-internal-token", "secret")
      .send({ log_id: "L4" });  // missing user_id, user_timezone, session_started_at
    expect(r.status).toBe(400);
    expect(r.body.status).toBe("failed");
  });

  it("rejects without the internal token (401)", async () => {
    const app = createServer();
    const r = await request(app)
      .post("/run-for-session/sess-5")
      .send({
        log_id: "L5", user_id: "u", user_timezone: "UTC",
        session_started_at: "2026-05-19T00:00:00Z",
      });
    expect(r.status).toBe(401);
  });
});
