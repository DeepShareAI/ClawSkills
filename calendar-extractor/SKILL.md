---
name: calendar-extractor
description: Background session extractor — turns recording transcripts into calendar events. Not user-callable; dispatched by the javis-server pipeline.
metadata: {}
---

# calendar-extractor

This skill is invoked **automatically** by the javis-server session-extraction pipeline whenever a finalized recording session has no existing extraction log row for `(user_id, session_id, "calendar", "v1")`.

There are NO user-facing verbs for this skill. The pipeline calls `POST /run-for-session/:sessionId` over HTTP with a shared internal token.

See `/Users/samuelwei/GoogleDrive/LLM/javis.is/docs/superpowers/specs/2026-05-19-javis-calendar-skill-design.md` for the full architecture.
