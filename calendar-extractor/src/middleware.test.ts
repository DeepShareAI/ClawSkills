import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { internalTokenGuard } from "./middleware";

describe("internalTokenGuard", () => {
  let app: express.Express;
  beforeEach(() => {
    process.env.INTERNAL_SHARED_TOKEN = "secret";
    app = express();
    app.use(internalTokenGuard);
    app.get("/x", (_req, res) => res.json({ ok: true }));
  });

  it("rejects missing token", async () => {
    const r = await request(app).get("/x");
    expect(r.status).toBe(401);
  });

  it("rejects wrong token", async () => {
    const r = await request(app).get("/x").set("x-internal-token", "wrong");
    expect(r.status).toBe(401);
  });

  it("accepts correct token", async () => {
    const r = await request(app).get("/x").set("x-internal-token", "secret");
    expect(r.status).toBe(200);
  });

  it("rejects when env var is unset", async () => {
    delete process.env.INTERNAL_SHARED_TOKEN;
    const r = await request(app).get("/x").set("x-internal-token", "anything");
    expect(r.status).toBe(401);
  });
});
