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

const LUMA_API2_BASE = 'https://api2.luma.com';

export const LUMA_API_HEADERS: Record<string, string> = {
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

export class LumaApi2Error extends Error {
  constructor(public readonly status: number, public readonly bodyText: string) {
    super(`api2.luma.com ${status}: ${bodyText.slice(0, 200)}`);
    this.name = 'LumaApi2Error';
  }
}

// Partial response shapes — captured fields only. Unknown fields kept as
// `unknown` so lu.ma schema rolls don't break compilation.
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
  url?: string;             // the slug, relative to lu.ma/
  visibility?: string;
  geo_address_info?: Api2EventGeo;
  coordinate?: { latitude?: number; longitude?: number };
  [k: string]: unknown;
}

export interface SearchResults {
  query?: string;
  calendars?: unknown[];
  events?: Array<{ api_id: string; event: Api2Event; [k: string]: unknown }>;
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
  entries?: Array<{ event: Api2Event; [k: string]: unknown }>;
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
    role?: string;          // "manager" / "guest" / "invited" / ...
    guest_count?: number;
    [k: string]: unknown;
  }>;
  has_more?: boolean;
  next_cursor?: string;
  [k: string]: unknown;
}

export class LumaApi2Client {
  constructor(private readonly cookieHeader: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${LUMA_API2_BASE}${path}`;
    const headers: Record<string, string> = {
      ...LUMA_API_HEADERS,
      Cookie: this.cookieHeader,
      ...((init.headers as Record<string, string>) ?? {}),
    };

    const resp = await fetch(url, { ...init, headers });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new LumaApi2Error(resp.status, text);
    }

    return (await resp.json()) as T;
  }

  async search(query: string): Promise<SearchResults> {
    const q = encodeURIComponent(query);
    return this.request<SearchResults>(`/search/get-results?query=${q}`);
  }

  async listCalendars(): Promise<CalendarListResponse> {
    return this.request<CalendarListResponse>(`/calendar/admin/list`);
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
  async myEvents(
    period: 'future' | 'past' = 'future',
    paginationLimit: number = 20,
  ): Promise<HomeEventsResponse> {
    const params = new URLSearchParams({
      pagination_limit: String(paginationLimit),
      period,
    });
    return this.request<HomeEventsResponse>(`/home/get-events?${params.toString()}`);
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
  async register(opts: RegisterOptions): Promise<RegisterResponse> {
    const body: Record<string, unknown> = {
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
    if (opts.eventInviteApiId) body.event_invite_api_id = opts.eventInviteApiId;
    if (opts.user?.name) body.name = opts.user.name;
    if (opts.user?.firstName) body.first_name = opts.user.firstName;
    if (opts.user?.lastName) body.last_name = opts.user.lastName;
    if (opts.user?.email) body.email = opts.user.email;
    if (opts.user?.phoneNumber) body.phone_number = opts.user.phoneNumber;

    return this.request<RegisterResponse>('/event/register', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
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
  openedFrom?: { source: string };
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
  ticket?: { api_id?: string; ticket_key?: string; [k: string]: unknown };
  guest_status?: string;
  registration_status?: string;
  [k: string]: unknown;
}
