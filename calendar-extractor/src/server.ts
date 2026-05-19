import express, { Express } from "express";
import { internalTokenGuard } from "./middleware";
import { loadTranscript } from "./transcript";
import { extractCalendarEvents } from "./extract";
import { writeCalendarEvents } from "./sink";

export function createServer(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.post("/run-for-session/:sessionId", internalTokenGuard, async (req, res) => {
    const sessionId = req.params.sessionId;
    const { log_id, user_id, user_timezone, session_started_at } = req.body ?? {};
    if (!log_id || !user_id || !user_timezone || !session_started_at) {
      return res.status(400).json({ status: "failed", error: "missing required fields" });
    }
    try {
      const transcript = await loadTranscript(sessionId);
      const events = await extractCalendarEvents({
        transcript: transcript.combinedText,
        user_timezone,
        session_started_at,
      });
      if (events.length === 0) {
        return res.json({ status: "skipped", result_count: 0 });
      }
      await writeCalendarEvents({
        log_id, user_id, source_session_id: sessionId, events,
      });
      return res.json({ status: "succeeded", result_count: events.length });
    } catch (err: any) {
      return res.status(500).json({ status: "failed", error: String(err?.message ?? err) });
    }
  });

  return app;
}
