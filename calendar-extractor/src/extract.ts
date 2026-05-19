import { structuredCall } from "./llm";
import { ExtractionResult, CalendarEventCandidateT } from "./schema";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

const MIN_CONFIDENCE = Number(process.env.CALENDAR_MIN_CONFIDENCE ?? 0.6);

export interface ExtractArgs {
  transcript: string;
  user_timezone: string;
  session_started_at: string;
  runCompletion?: (system: string, user: string) => Promise<string>;
}

export async function extractCalendarEvents(args: ExtractArgs): Promise<CalendarEventCandidateT[]> {
  const result = await structuredCall({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt({
      transcript: args.transcript,
      user_timezone: args.user_timezone,
      session_started_at: args.session_started_at,
    }),
    schema: ExtractionResult,
    runCompletion: args.runCompletion,
  });
  // Zod .default([]) guarantees attendees/agenda_items are always arrays after parse;
  // cast to the concrete output type to satisfy the function return signature.
  return (result.events as CalendarEventCandidateT[]).filter(
    (e) => (e.confidence ?? 0) >= MIN_CONFIDENCE,
  );
}
