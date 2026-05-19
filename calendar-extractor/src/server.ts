import express, { Express } from "express";
import { internalTokenGuard } from "./middleware";

export function createServer(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // T18 fills in the real handler with transcript loading, LLM call, and sink POST.
  // This stub returns 501 so the contract is testable end-to-end before T18 lands.
  app.post("/run-for-session/:sessionId", internalTokenGuard, async (_req, res) => {
    res.status(501).json({ status: "failed", error: "not implemented" });
  });

  return app;
}
