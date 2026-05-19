import type { CalendarEventCandidateT } from "./schema";

export interface SinkPayload {
  log_id: string;
  user_id: string;
  source_session_id: string;
  events: CalendarEventCandidateT[];
}

type FetchLike = (url: string, init: any) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
}>;

export async function writeCalendarEvents(
  payload: SinkPayload,
  opts: { fetcher?: FetchLike } = {},
): Promise<{ inserted: number }> {
  const fetcher = opts.fetcher ?? (globalThis.fetch as FetchLike);
  const base = (process.env.JAVIS_SERVER_URL ?? "").replace(/\/$/, "");
  const token = process.env.INTERNAL_SHARED_TOKEN ?? "";
  const r = await fetcher(`${base}/api/internal/calendar/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": token,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`sink HTTP ${r.status}`);
  return (await r.json()) as { inserted: number };
}
