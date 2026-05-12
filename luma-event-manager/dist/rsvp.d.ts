/**
 * RSVP support via api2.luma.com/event/register.
 *
 * Lu.ma's actual model is "register" — a single registration record per user
 * per event, not a yes/no/maybe spectrum. Mapping for the legacy SKILL.md
 * vocabulary:
 *
 *   "yes" / "going" / "interested" → register (for_waitlist=false)
 *   "waitlist" / "waitlisted"      → register (for_waitlist=true)
 *   "no" / "maybe"                 → not supported (no API analogue)
 *
 * The captured wire shape (DevTools capture, 2026-05-11) includes a lot of
 * optional fields for paid events, crypto payments, and event-specific
 * registration questions. The minimal path here covers free events with no
 * additional questions; events that require employer/role/tos answers
 * surface as a "register at lu.ma directly" error.
 */
export interface RsvpResult {
    success: boolean;
    message: string;
    status?: 'registered' | 'waitlisted' | 'rejected' | 'needs_questions' | 'auth' | 'rate_limited' | 'unknown';
    /** When status is rate_limited, seconds to wait before any caller retries. */
    retry_after_seconds?: number;
    details?: string;
}
export declare function rsvpToEvent(slug: string, response: string, cookies: string): Promise<RsvpResult>;
//# sourceMappingURL=rsvp.d.ts.map