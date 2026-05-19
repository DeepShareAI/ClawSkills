export interface TranscriptSegment {
  start_time: number;
  end_time: number;
  speaker_id?: string;
  text: string;
  emotion?: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  combinedText: string;
}

type Fetcher = (sessionId: string) => Promise<{ segments: TranscriptSegment[] }>;

const defaultFetcher: Fetcher = async (sessionId) => {
  const base = (process.env.JAVIS_SERVER_URL ?? "").replace(/\/$/, "");
  const url = `${base}/api/transcription/${encodeURIComponent(sessionId)}`;
  const headers: Record<string, string> = {};
  const token = process.env.INTERNAL_SHARED_TOKEN;
  if (token) headers["x-internal-token"] = token;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`transcript fetch ${r.status}`);
  const raw = (await r.json()) as TranscriptSegment[];
  return { segments: raw };
};

export async function loadTranscript(
  sessionId: string,
  opts: { fetcher?: Fetcher } = {},
): Promise<Transcript> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const raw = await fetcher(sessionId);
  if (!raw || !Array.isArray(raw.segments)) {
    throw new Error(`transcript response invalid for session ${sessionId}`);
  }
  if (raw.segments.length === 0) {
    throw new Error(`transcript empty for session ${sessionId}`);
  }
  const combinedText = raw.segments
    .map((s) => `[${s.speaker_id ?? "?"}] ${s.text}`)
    .join("\n");
  return { segments: raw.segments, combinedText };
}
