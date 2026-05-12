/**
 * Luma Web Scraper
 * Scrapes event data from lu.ma pages
 */
import { LumaEvent, Attendee } from './index';
/**
 * Public: resolve a slug to the event's api2 fields needed for RSVP —
 * event api_id + a usable ticket_type api_id. Used by rsvp.ts.
 */
export declare function resolveEventForRsvp(slug: string): Promise<{
    eventApiId: string;
    ticketTypeApiId?: string;
    ticketTypeName?: string;
    isWaitlistOnly?: boolean;
} | null>;
/**
 * Get event details for a single slug.
 *
 * v1.1 Path B: lu.ma serves event pages via Next.js SSR with the full event
 * object embedded in __NEXT_DATA__ — no discrete api2 call is made when the
 * web client renders the page (confirmed by R5 capture). We fetch the HTML
 * and pull the event object out by its api2-shaped fields.
 *
 * The HTML page is publicly accessible; no cookies required. We still pass
 * a User-Agent + Accept-Language to look like a normal browser.
 *
 * If R6's follow-up surfaces a real GET endpoint (e.g.
 * /events/get-event?slug=...) we can switch to Path A here without touching
 * the public signature.
 */
export declare function scrapeEvent(slug: string): Promise<LumaEvent | null>;
/**
 * Discover / search events.
 *
 * v1.1: api2.luma.com/search/get-results is the primary discover endpoint.
 * It accepts cookie auth (logged-in user) or works anonymously with no
 * cookies — both return real event JSON. Anonymous use is fine here because
 * the underlying data is public.
 *
 * Pre-v1.1 this scraped lu.ma/discover HTML and fell back to __NEXT_DATA__.
 * That path stopped working when lu.ma moved discover to a fully client-
 * rendered SPA — see the v1.1 plan for context.
 */
export declare function scrapeDiscover(params: {
    lat?: number;
    lng?: number;
    query?: string;
}): Promise<LumaEvent[]>;
/**
 * List the user's RSVP'd / invited / hosted events — the same feed lu.ma
 * renders on its `/home` page.
 *
 * Uses `/home/get-events` (cookie-scoped, no calendar_api_id needed). This
 * supersedes the earlier two-step `/calendar/admin/list` →
 * `/calendar/get-items` path, which only returned events on a *specific*
 * calendar and missed the user's broader feed — see live-probe results in
 * the v1.1 plan's L3 follow-up.
 */
export declare function scrapeMyEvents(cookies: string): Promise<LumaEvent[]>;
/**
 * Scrape hosted events (requires auth)
 */
export declare function scrapeHostedEvents(cookies: string): Promise<LumaEvent[]>;
/**
 * Scrape guest list (requires auth)
 */
export declare function scrapeGuestList(slug: string, cookies: string): Promise<Attendee[]>;
/**
 * Load cookies — env vars first (set by javis-server after the WebView
 * capture or OTP flow via the skill_credentials service), then fall back to
 * `pass show luma/cookies` for local-dev environments.
 *
 * The current WebView flow sets `luma.auth-session-key` + `luma.did`; the
 * legacy OTP flow sets `luma_session` + `luma_user_id`. Both are sent if
 * present so api2.luma.com sees the cookies its web client sends.
 */
export declare function loadCookies(): Promise<string | null>;
/**
 * Check if authenticated
 */
export declare function isAuthenticated(): Promise<boolean>;
//# sourceMappingURL=scraper.d.ts.map