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

import { LumaApi2Client, LumaApi2Error } from './api2Client';
import { resolveEventForRsvp } from './scraper';

/**
 * In-process per-cookie cooldown. After any 429 from /event/register we
 * refuse to re-call lu.ma for this many milliseconds. Each retry inside the
 * cooldown window extends lu.ma's anti-spam timer server-side, so the
 * polite thing is to abstain locally and let it clear. Lost on container
 * restart, but that's fine — restarts take longer than the window.
 */
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const lastRateLimitedAt = new Map<string, number>();

export interface RsvpResult {
  success: boolean;
  message: string;
  status?: 'registered' | 'waitlisted' | 'rejected' | 'needs_questions' | 'auth' | 'rate_limited' | 'unknown';
  /** When status is rate_limited, seconds to wait before any caller retries. */
  retry_after_seconds?: number;
  details?: string;
}

function normalizeResponse(response: string): { kind: 'register' | 'waitlist' | 'unsupported'; original: string } {
  const r = response.toLowerCase().trim();
  if (['yes', 'going', 'y', 'true', 'interested', 'register'].includes(r)) {
    return { kind: 'register', original: r };
  }
  if (['waitlist', 'waitlisted'].includes(r)) {
    return { kind: 'waitlist', original: r };
  }
  return { kind: 'unsupported', original: r };
}

export async function rsvpToEvent(
  slug: string,
  response: string,
  cookies: string,
): Promise<RsvpResult> {
  const norm = normalizeResponse(response);
  if (norm.kind === 'unsupported') {
    return {
      success: false,
      status: 'rejected',
      message:
        `lu.ma doesn't support "${norm.original}" — registrations are a single yes/no action. ` +
        `Try "yes" to register, or "waitlist" if the event is full.`,
    };
  }

  const resolved = await resolveEventForRsvp(slug);
  if (!resolved) {
    return {
      success: false,
      status: 'unknown',
      message: `Could not find event "${slug}". Check the URL or slug.`,
    };
  }

  if (!resolved.ticketTypeApiId) {
    return {
      success: false,
      status: 'needs_questions',
      message:
        `Event "${slug}" doesn't expose a public ticket type via the page. ` +
        `It may be invite-only or require manual registration — please RSVP at https://lu.ma/${slug}.`,
    };
  }

  const forWaitlist = norm.kind === 'waitlist' || Boolean(resolved.isWaitlistOnly);

  // Honor any pending cooldown before we hit lu.ma. Sliding-window: each
  // hit just slides the window forward by RATE_LIMIT_COOLDOWN_MS.
  const lastBlock = lastRateLimitedAt.get(cookies);
  if (lastBlock !== undefined) {
    const elapsed = Date.now() - lastBlock;
    if (elapsed < RATE_LIMIT_COOLDOWN_MS) {
      const remaining = Math.ceil((RATE_LIMIT_COOLDOWN_MS - elapsed) / 1000);
      return {
        success: false,
        status: 'rate_limited',
        retry_after_seconds: remaining,
        message:
          `Skipping the lu.ma call — we got a 429 recently and each retry extends the cooldown. ` +
          `Wait ~${remaining}s before trying again, or RSVP manually at https://lu.ma/${slug}.`,
      };
    }
  }

  try {
    const client = new LumaApi2Client(cookies);
    const result = await client.register({
      eventApiId: resolved.eventApiId,
      ticketTypeApiId: resolved.ticketTypeApiId,
      forWaitlist,
      openedFrom: { source: 'home' },
    });

    const status = forWaitlist ? 'waitlisted' as const : 'registered' as const;
    const verb = forWaitlist ? 'Joined the waitlist' : 'Registered';
    return {
      success: true,
      status,
      message: `${verb} for ${slug}.`,
      details: typeof result?.guest_status === 'string' ? result.guest_status : undefined,
    };
  } catch (error) {
    if (error instanceof LumaApi2Error) {
      const text = (error.bodyText || '').toLowerCase();
      // 429 — lu.ma anti-spam. Treat as terminal for the current turn:
      // each retry extends lu.ma's cooldown window, so callers (LLM included)
      // MUST NOT retry within the same chat turn.
      if (error.status === 429) {
        lastRateLimitedAt.set(cookies, Date.now());
        return {
          success: false,
          status: 'rate_limited',
          retry_after_seconds: 900, // 15 min — observed cooldown when hit hard
          message:
            `lu.ma rate-limited the request (429). DO NOT retry — each retry extends the cooldown. ` +
            `Tell the user to either RSVP manually at https://lu.ma/${slug} or wait ~15 minutes before trying again from chat.`,
          details: error.bodyText.slice(0, 300),
        };
      }
      // Common validation paths: event with custom questions, expired/invalid
      // cookies, or events that need an invite.
      if (error.status === 401 || error.status === 403) {
        return {
          success: false,
          status: 'auth',
          message:
            `lu.ma rejected the request (${error.status}). Your session may have expired — ` +
            `try \`luma disconnect\` then \`luma configure\` to reconnect.`,
          details: error.bodyText.slice(0, 300),
        };
      }
      if (
        text.includes('registration_answers') ||
        text.includes('question') ||
        text.includes('terms') ||
        text.includes('invite')
      ) {
        return {
          success: false,
          status: 'needs_questions',
          message:
            `This event requires additional info (registration questions, terms, or an invite). ` +
            `Please complete it at https://lu.ma/${slug}.`,
          details: error.bodyText.slice(0, 300),
        };
      }
      return {
        success: false,
        status: 'unknown',
        message: `lu.ma rejected the request (${error.status}). Try again at https://lu.ma/${slug} if this persists.`,
        details: error.bodyText.slice(0, 300),
      };
    }
    console.error(`[luma] rsvp ${slug} failed:`, error);
    return {
      success: false,
      status: 'unknown',
      message: `Something went wrong submitting the RSVP. Try https://lu.ma/${slug} directly.`,
    };
  }
}
