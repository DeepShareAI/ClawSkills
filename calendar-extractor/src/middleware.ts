import type { RequestHandler } from "express";

export const internalTokenGuard: RequestHandler = (req, res, next) => {
  const expected = process.env.INTERNAL_SHARED_TOKEN ?? "";
  const got = req.header("x-internal-token") ?? "";
  if (!expected || got !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
};
