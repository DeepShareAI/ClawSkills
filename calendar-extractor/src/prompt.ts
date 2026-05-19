export const SYSTEM_PROMPT = `You extract calendar-relevant events from voice-recording transcripts.

A "calendar event" is a meeting, appointment, reservation, visit, or scheduled call discussed in the transcript — not idle planning or past events. Output strict JSON conforming to the supplied schema. If no calendar events are present, return {"events": []}.

Rules:
- Resolve relative dates ("Wednesday", "tomorrow", "next week") against SESSION_STARTED_AT in USER_TIMEZONE.
- Output all start_at/end_at as ISO 8601 with explicit UTC offset (e.g., 2026-05-20T21:00:00Z).
- source_quote MUST be a verbatim excerpt (≤300 chars) from the transcript.
- confidence: 0.9+ for "definite", 0.7–0.9 for "likely", below 0.6 for "speculative" (omit from output if <0.5).
- Be conservative — if a meeting wasn't actually scheduled (just discussed hypothetically), don't extract it.`;

export function buildUserPrompt(args: {
  transcript: string;
  user_timezone: string;
  session_started_at: string;
}): string {
  return [
    `SESSION_STARTED_AT: ${args.session_started_at}`,
    `USER_TIMEZONE: ${args.user_timezone}`,
    "",
    "TRANSCRIPT:",
    args.transcript,
    "",
    "Output JSON only.",
  ].join("\n");
}
