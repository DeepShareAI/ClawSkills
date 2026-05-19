import { z } from "zod";

export const Attendee = z.object({
  name: z.string(),
  role: z.string().nullable().optional(),
  contact: z.string().nullable().optional(),
});

export const AgendaItem = z.object({
  topic: z.string(),
  detail: z.string().nullable().optional(),
});

export const CalendarEventCandidate = z.object({
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  start_at: z.string(),      // ISO 8601 with offset
  end_at: z.string(),        // ISO 8601 with offset
  location: z.string().nullable().optional(),
  attendees: z.array(Attendee).default([]),
  agenda_items: z.array(AgendaItem).default([]),
  source_quote: z.string().max(300),
  confidence: z.number().min(0).max(1),
});

export const ExtractionResult = z.object({
  events: z.array(CalendarEventCandidate),
});

// Use output types so that .default([]) fields are non-optional after parsing.
export type CalendarEventCandidateT = z.infer<typeof CalendarEventCandidate>;
export type ExtractionResultT = z.infer<typeof ExtractionResult>;
