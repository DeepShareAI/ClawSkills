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

## Deployment

This skill runs as a Node.js container. Build:

```bash
docker build -t calendar-extractor .
```

Required env vars in production:
- `OPENAI_API_KEY` — LLM API key
- `OPENAI_MODEL` — optional, default `gpt-4o-mini`
- `JAVIS_SERVER_URL` — e.g. `http://javis-server:8000` (must be reachable from inside the container)
- `INTERNAL_SHARED_TOKEN` — shared secret with javis-server; must match the value set in the server's env (used to authenticate the sink callback)
- `PORT` — default `8080`

The javis-server pipeline worker dispatches to this skill when `CALENDAR_EXTRACTOR_URL` is set on the server's env. See `javis-server/app/config/extractors.py` for the registry mechanism.

**Deploy topology note:** There is no existing docker-compose or Ansible playbook that covers ClawSkills services (luma-event-manager is in the same situation). When this skill is ready for production, a service entry should be added to either:
- `DeepShareIAC/javis-server/playbook.yaml` (as a sidecar container task), or
- A new `DeepShareIAC/calendar-extractor/playbook.yaml` following the pattern of `DeepShareIAC/pet-translator/playbook.yaml`.

Skeleton compose entry for reference:

```yaml
calendar-extractor:
  build: ./ClawSkills/calendar-extractor
  environment:
    PORT: "8080"
    JAVIS_SERVER_URL: "http://javis-server:8000"
    OPENAI_API_KEY: "${OPENAI_API_KEY}"
    OPENAI_MODEL: "${OPENAI_MODEL:-gpt-4o-mini}"
    INTERNAL_SHARED_TOKEN: "${INTERNAL_SHARED_TOKEN}"
  depends_on:
    - javis-server
  restart: unless-stopped
```
