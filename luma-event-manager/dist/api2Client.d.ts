/**
 * LumaApi2Client — thin wrapper around fetch() against api2.luma.com.
 *
 * lu.ma's web app talks to api2.luma.com on the side (separate subdomain)
 * with cookie-only auth + a small set of `x-luma-*` client headers. The
 * read endpoints accept cookie auth with no CSRF (verified in R5 probe;
 * see docs/superpowers/specs/r5-luma-api2-capture.md).
 *
 * The matching Python constant lives in
 * javis-server/javis_mcp/providers/luma.py:LUMA_API_HEADERS — bump both in
 * sync if lu.ma rolls x-luma-client-version (typically surfaces as
 * HTTP 410 / 426).
 */
export declare const LUMA_API_HEADERS: Record<string, string>;
export declare class LumaApi2Error extends Error {
    readonly status: number;
    readonly bodyText: string;
    constructor(status: number, bodyText: string);
}
export interface Api2EventGeo {
    mode?: string;
    city?: string;
    city_state?: string;
    region?: string;
    country?: string;
    address?: string;
    full_address?: string;
    place_id?: string;
}
export interface Api2Event {
    api_id: string;
    calendar_api_id?: string;
    cover_url?: string;
    start_at?: string;
    end_at?: string;
    event_type?: string;
    hide_rsvp?: boolean;
    location_type?: string;
    name?: string;
    show_guest_list?: boolean;
    timezone?: string;
    url?: string;
    visibility?: string;
    geo_address_info?: Api2EventGeo;
    coordinate?: {
        latitude?: number;
        longitude?: number;
    };
    [k: string]: unknown;
}
export interface SearchResults {
    query?: string;
    calendars?: unknown[];
    events?: Array<{
        api_id: string;
        event: Api2Event;
        [k: string]: unknown;
    }>;
    [k: string]: unknown;
}
export interface CalendarInfo {
    calendar?: {
        api_id: string;
        name?: string;
        slug?: string | null;
        personal_user_api_id?: string | null;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}
export interface CalendarListResponse {
    infos?: CalendarInfo[];
    [k: string]: unknown;
}
export interface CalendarItemsResponse {
    entries?: Array<{
        event: Api2Event;
        [k: string]: unknown;
    }>;
    has_more?: boolean;
    next_cursor?: string;
    [k: string]: unknown;
}
/**
 * Shape of /home/get-events. Each entry carries a richer envelope than
 * /calendar/get-items (host info, guest counts, role) but the nested
 * `.event` is the same Api2Event shape used everywhere else.
 */
export interface HomeEventsResponse {
    entries?: Array<{
        api_id?: string;
        event: Api2Event;
        role?: string;
        guest_count?: number;
        [k: string]: unknown;
    }>;
    has_more?: boolean;
    next_cursor?: string;
    [k: string]: unknown;
}
export declare class LumaApi2Client {
    private readonly cookieHeader;
    constructor(cookieHeader: string);
    private request;
    search(query: string): Promise<SearchResults>;
    listCalendars(): Promise<CalendarListResponse>;
    /**
     * Fetch the user's home feed — RSVP'd events + invites + events they're
     * hosting, all interleaved. This is what the lu.ma web app calls when it
     * renders `/home`. Each entry's `.event` is api2-shaped (same as search
     * results).
     *
     * Unlike `/calendar/get-items`, this endpoint takes no calendar_api_id —
     * lu.ma scopes by cookie. The R5-discovered `/calendar/get-items` path
     * only returns events tied to a *specific* calendar (e.g. cal-CDoX2WaI5IHD5xs
     * for "event subs") and misses anything outside that calendar, which is
     * why the personal calendar query previously came back empty.
     */
    myEvents(period?: 'future' | 'past', paginationLimit?: number): Promise<HomeEventsResponse>;
    /**
     * Register the current user for an event — lu.ma's RSVP write path.
     *
     * Payload shape captured from a real Chrome DevTools session against the
     * lu.ma web app. The request body has a lot of optional crypto/payment
     * fields that we send as null for free events. Required for the call to
     * succeed: `event_api_id`, `ticket_type_to_selection` (at least one
     * ticket type, count=1 for solo registration), and the cookie auth.
     *
     * User PII fields (name, email, phone, etc.) are server-filled from the
     * cookie session when omitted, so the caller doesn't need to fetch them
     * up-front. For events that ask additional registration questions
     * (employer, role, terms-of-service checkbox, etc.) lu.ma rejects the
     * call with a validation error; callers should surface that to the user
     * with a "complete registration at lu.ma/<slug>" prompt.
     */
    register(opts: RegisterOptions): Promise<RegisterResponse>;
}
export interface RegisterAnswer {
    question_id: string;
    question_type: string;
    label?: string;
    value: unknown;
}
export interface RegisterOptions {
    eventApiId: string;
    forWaitlist?: boolean;
    /** A ticket-type api_id (prefix `evtticktyp-`). Required by most events. */
    ticketTypeApiId?: string;
    ticketCount?: number;
    /** Invite-token api_id, only when registering via an invite link. */
    eventInviteApiId?: string;
    /** Lu.ma's UI uses this to attribute the registration source. */
    openedFrom?: {
        source: string;
    };
    /** Answers to event-specific registration questions, if any. */
    registrationAnswers?: RegisterAnswer[];
    /**
     * Optional user PII override. Normally omitted — lu.ma fills these from
     * the cookie session. Provide only if the server complains.
     */
    user?: {
        name?: string;
        firstName?: string;
        lastName?: string;
        email?: string;
        phoneNumber?: string;
    };
}
export interface RegisterResponse {
    ticket?: {
        api_id?: string;
        ticket_key?: string;
        [k: string]: unknown;
    };
    guest_status?: string;
    registration_status?: string;
    [k: string]: unknown;
}
//# sourceMappingURL=api2Client.d.ts.map