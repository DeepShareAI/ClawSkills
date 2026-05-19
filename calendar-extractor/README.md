# 📅 calendar-extractor

A Javis session-extractor skill. Listens for `POST /run-for-session/:sessionId` from the
javis-server pipeline worker, loads the recording's transcript via `javis_mcp`, runs a
structured-output LLM extraction, and POSTs the discovered calendar events to the
javis-server sink endpoint.

## Run locally

```bash
npm install
npm run dev   # tsx watch
```

Required env vars:
- `OPENAI_API_KEY` (or compatible LLM gateway)
- `JAVIS_SERVER_URL` (e.g. http://javis-server:8000)
- `INTERNAL_SHARED_TOKEN` (must match javis-server's)
- `PORT` (default 8080)
