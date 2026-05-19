import express, { Express } from "express";

export function createServer(): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}
