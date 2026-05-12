---
name: luma-event-manager
description: Luma Event Manager — Discover events by topic or location, RSVP, view guest lists, and sync to Google Calendar. Authenticates via in-chat WebView (or email+OTP fallback) using the platform's skill_credentials service. Fork of mariovallereyes/luma-event-manager rewired for HiJavis.
homepage: https://github.com/mariovallereyes/luma-skill
metadata: {"clawdbot":{"emoji":"📅"}}
---

# Luma Event Manager

Manage Luma events through lu.ma's web-app JSON API (`api2.luma.com`). Public discovery works without auth. Personal-calendar / RSVP / host features need cookies stored in skill_credentials.

## Configure (the user wants to connect their Luma account)

When the user types `luma configure`, `luma connect`, `luma signin`, or any command that requires auth and `skill_credentials_status` returns not-configured:

### Step 1 — Check current state

**REQUIRED ACTION:** Call `skill_credentials_status({"provider": "luma"})`.
- If the result is `{configured: true, ...}`, reply `✅ Luma is already connected.` and stop the turn.
- For any other result (`configured: false`, missing, null, or an error envelope), proceed to Step 2.

Do not skip this check — Step 2's tool call depends on knowing the current state.

### Step 2 — Open the in-app sign-in

**REQUIRED ACTION:** Call `skill_credentials_request_external_auth({"provider": "luma"})`. You MUST call this tool before replying any text. The tool returns immediately and the iOS app intercepts the result to open a WebView modal at `https://luma.com/signin`.

**After the tool call succeeds**, reply with a short bubble like `Opening lu.ma sign-in…` and **stop the turn**. Do NOT call any further tools in this turn — wait for the user's next message (which will be one of the control tokens listed in Step 3).

> ⚠️ Do not skip the tool call. The reply text by itself does NOT open the modal — only the tool result does. If you reply without calling the tool, the user sees your message but the WebView never opens and the flow stalls.

### Step 3 — Wait for the user's next turn

It will be one of three control tokens (you will receive these as the user's next message; treat them as signals, never echo them back to the user):

- `<luma-connected>` → user signed in successfully and cookies have been uploaded. Call `skill_credentials_status` to confirm, then either: (a) resume any pending Luma intent from earlier in the conversation (e.g. they originally said "luma rsvp X"), or (b) reply `✅ Luma connected. What would you like to do?` if there's no pending intent.
- `<luma-cancelled>` → user closed the modal. Reply `OK, lu.ma not connected. Let me know if you want to try again.` Do NOT call any tool.
- `<luma-save-failed>` → cookies were captured but failed to persist. Reply `Hit a snag saving — please tap retry on the toast.` Do NOT call any tool.

## Configure — fallback for non-iOS clients

If `skill_credentials_request_external_auth` returns `{ok: false, error: "provider_unsupported"}` OR no iOS handler picks up the action (no `<luma-connected>` / `<luma-cancelled>` token arrives within ~120s), fall back to email-OTP:

1. Ask the user for their email.
2. Call `skill_credentials_request_otp({"provider": "luma", "email": "<email>"})`.
3. Wait for the 6-digit code in the user's reply.
4. Call `skill_credentials_verify_otp({"provider": "luma", "email": "<email>", "code": "<code>"})`.
5. On success: "✅ Luma connected." On `bot_challenge` error: "Lu.ma is blocking the OTP request. Please try again from the iOS app where the WebView flow can sign you in directly." On `invalid_code`: "That code didn't match. Please try again." On `rate_limited`: wait the suggested seconds before retrying.

## Disconnect

When the user types `luma disconnect`, `luma logout`, or `forget my luma`:
1. Call `skill_credentials_clear({"provider": "luma"})`.
2. Reply "✅ Luma disconnected. Run `luma configure` to reconnect."

## Status

When the user types `luma status` or `am i connected to luma`:
1. Call `skill_credentials_status({"provider": "luma"})`.
2. If configured → "✅ Luma is connected." (omit `expires_at` if null).
3. If not → "❌ Not connected. Run `luma configure` to log in."

## Auto-configure on first use of an auth-required command

If the user invokes any of `luma my events`, `luma rsvp`, `luma host events`, `luma host guests`, `luma add calendar` AND `skill_credentials_status` says not-configured:
1. Hold their original request in memory.
2. Run the **Configure** flow above (external_auth path).
3. After successful `<luma-connected>`, **resume the original request**.

## Public commands (no auth)

- `luma search <topic>` / `luma search <topic> near <city>` / `luma events near <city>` / `luma event <slug>` — work without configure.

## Auth-required commands (auto-configure if needed)

- `luma my events` — events you've RSVP'd to
- `luma rsvp <slug> <yes|waitlist>` — see "RSVP semantics" below
- `luma host events` / `luma host guests <slug>`
- `luma add calendar <slug>` (also requires `gog` CLI)

## RSVP semantics

Lu.ma's model is **register**, not a yes/no/maybe spectrum. A user is either registered for an event or they're not — there's no "maybe" or "soft no". The skill maps the legacy verbs:

- `yes` / `going` / `register` → `POST /event/register` with `for_waitlist: false`
- `waitlist` / `waitlisted` → `POST /event/register` with `for_waitlist: true` (use for sold-out events)
- `no` / `maybe` → not supported; the user-facing reply explains this and asks the user to either say `yes` or skip RSVP'ing

Events with custom registration questions (employer, role, terms-of-service checkboxes, paid tickets, invite-only entry) cannot be RSVP'd from chat — the skill returns a "register at https://lu.ma/&lt;slug&gt;" message. **Don't promise the user we'll fill out the form for them.**

When the RSVP succeeds, the response message will say "Registered for &lt;slug&gt;." or "Joined the waitlist for &lt;slug&gt;." Surface that directly. Don't add prose about "ticket on the way" or "confirmation email" — lu.ma handles those out-of-band.

### CRITICAL: do NOT retry `luma_rsvp` within the same turn

Lu.ma's `/event/register` endpoint has aggressive anti-spam rate limiting. Each retry **extends** the cooldown window — meaning if you retry "to see if it cleared," you make the problem worse. The skill returns these statuses you must respect:

- `status: "rate_limited"` (HTTP 429) — **STOP. Do not call `luma_rsvp` again this turn for any slug.** The response message already tells the user to wait ~15 min or RSVP manually. Just surface it.
- `status: "auth"` (401/403) — cookies expired. Tell the user to reconnect; do not retry.
- `status: "needs_questions"` — event requires manual form-filling. Surface the lu.ma URL; do not retry.
- `status: "registered"` / `"waitlisted"` — success. Surface the message.
- `status: "rejected"` (unsupported verb like "no"/"maybe") — surface the rejection; do not retry.
- `status: "unknown"` — unexpected lu.ma error. Surface the message; do not retry within the same turn.

In all failure cases, **call `luma_rsvp` at most ONCE per chat turn.** If the user re-sends the request in a new turn, that's their choice — but never decide to retry on your own.

## Authentication source of truth

Cookies are loaded from env vars set by javis-server's `gateway_manager` after credentials land in `skill_credentials` (via either external_auth or OTP) and the openclaw container recycles. The skill code (`scraper.ts`) reads:

- `LUMA_AUTH_SESSION_KEY` + `LUMA_DID` — WebView flow (current path)
- `LUMA_SESSION` + `LUMA_USER_ID` — legacy OTP flow (kept for in-flight rows)

No fallback to `pass` (the upstream's CLI tool).

## Data layer (how reads actually work)

The skill calls `api2.luma.com` directly with the user's stored cookies — **not HTML scraping**. Read endpoints return clean JSON with no CSRF:

| Skill operation | Endpoint |
|---|---|
| `luma search <q>` | `GET /search/get-results?query=<q>` |
| `luma my events` | `GET /calendar/admin/list` → pick personal calendar → `GET /calendar/get-items?calendar_api_id=...&period=future` |
| `luma event <slug>` | Fetches `https://lu.ma/<slug>` and parses the embedded `__NEXT_DATA__` JSON (lu.ma renders event detail via SSR; no discrete api2 call) |

**When a read returns no results, that's a truthful answer — not a scraping limitation.** Lu.ma is not rendered behind a JavaScript wall for these reads; the data is JSON. If `luma my events` reports zero events, the user genuinely has zero upcoming RSVPs on the connected account. Don't fabricate "JS-rendering" / "scraper noise" / "page structure changed" explanations.

If a request 401s, `scraper.ts` catches it silently and returns an empty array — the user-facing failure mode looks the same as a true-empty. If the user insists they have events and we got zero, that usually means cookies are stale; suggest `luma disconnect` then `luma configure`.

## Critical: control tokens

The three tokens `<luma-connected>`, `<luma-cancelled>`, `<luma-save-failed>` are platform-internal signals from the iOS app. **Never display them in your replies to the user** — the iOS render layer strips them as defense-in-depth, but you must also avoid echoing them. They are not natural language; treat them strictly as enum values that arrive as user turns.
