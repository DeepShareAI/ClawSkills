"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LumaApi2Client = exports.LumaApi2Error = exports.LUMA_API_HEADERS = void 0;
const LUMA_API2_BASE = 'https://api2.luma.com';
exports.LUMA_API_HEADERS = {
    accept: '*/*',
    'accept-language': 'en',
    'content-type': 'application/json',
    origin: 'https://luma.com',
    referer: 'https://luma.com/',
    'x-luma-client-type': 'luma-web',
    'x-luma-client-version': '2026-05-09T22:06:52Z|a8352d2255b7',
    'x-luma-timezone': 'America/Los_Angeles',
    'x-luma-web-url': 'https://luma.com/signin',
};
class LumaApi2Error extends Error {
    constructor(status, bodyText) {
        super(`api2.luma.com ${status}: ${bodyText.slice(0, 200)}`);
        this.status = status;
        this.bodyText = bodyText;
        this.name = 'LumaApi2Error';
    }
}
exports.LumaApi2Error = LumaApi2Error;
class LumaApi2Client {
    constructor(cookieHeader) {
        this.cookieHeader = cookieHeader;
    }
    async request(path, init = {}) {
        const url = `${LUMA_API2_BASE}${path}`;
        const headers = {
            ...exports.LUMA_API_HEADERS,
            Cookie: this.cookieHeader,
            ...(init.headers ?? {}),
        };
        const resp = await fetch(url, { ...init, headers });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new LumaApi2Error(resp.status, text);
        }
        return (await resp.json());
    }
    async search(query) {
        const q = encodeURIComponent(query);
        return this.request(`/search/get-results?query=${q}`);
    }
    async listCalendars() {
        return this.request(`/calendar/admin/list`);
    }
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
    async myEvents(period = 'future', paginationLimit = 20) {
        const params = new URLSearchParams({
            pagination_limit: String(paginationLimit),
            period,
        });
        return this.request(`/home/get-events?${params.toString()}`);
    }
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
    async register(opts) {
        const body = {
            event_api_id: opts.eventApiId,
            for_waitlist: opts.forWaitlist ?? false,
            payment_method: null,
            payment_currency: null,
            coupon_code: null,
            token_gate_info: null,
            eth_address_info: null,
            solana_address_info: null,
            solana_address: null,
            solana_wallet_type: null,
            expected_amount_cents: 0,
            expected_amount_tax: 0,
            currency: null,
            opened_from: opts.openedFrom ?? { source: 'home' },
            registration_answers: opts.registrationAnswers ?? [],
        };
        if (opts.ticketTypeApiId) {
            body.ticket_type_to_selection = {
                [opts.ticketTypeApiId]: { count: opts.ticketCount ?? 1, amount: 0 },
            };
        }
        if (opts.eventInviteApiId)
            body.event_invite_api_id = opts.eventInviteApiId;
        if (opts.user?.name)
            body.name = opts.user.name;
        if (opts.user?.firstName)
            body.first_name = opts.user.firstName;
        if (opts.user?.lastName)
            body.last_name = opts.user.lastName;
        if (opts.user?.email)
            body.email = opts.user.email;
        if (opts.user?.phoneNumber)
            body.phone_number = opts.user.phoneNumber;
        return this.request('/event/register', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
}
exports.LumaApi2Client = LumaApi2Client;
//# sourceMappingURL=api2Client.js.map