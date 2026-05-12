/**
 * Luma Web Scraper
 * Scrapes event data from lu.ma pages
 */

import * as cheerio from 'cheerio';
import { LumaEvent, Attendee, Location } from './index';
import { fetchWithBackoff, extractJsonScript, findFirstObjectWithKeys } from './utils';
import {
  LumaApi2Client,
  LumaApi2Error,
  Api2Event,
  Api2EventGeo,
} from './api2Client';

const LUMA_BASE_URL = 'https://lu.ma';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/**
 * Map a lu.ma api2 event payload to the internal LumaEvent shape.
 *
 * Field mapping is derived from R5 capture
 * (docs/superpowers/specs/r5-luma-api2-capture.md):
 *   api_id              → host_id (internal id we expose as the host_id slot)
 *   url                 → slug
 *   name                → title
 *   start_at / end_at   → start_time / end_time (already ISO 8601)
 *   timezone            → timezone
 *   cover_url           → cover_image
 *   location_type=offline / virtual / hybrid
 *   geo_address_info.{city_state, address, full_address} → location.address
 */
function api2EventToLumaEvent(ev: Api2Event): LumaEvent | null {
  const slug = typeof ev.url === 'string' ? ev.url : undefined;
  const title = typeof ev.name === 'string' ? ev.name : undefined;
  if (!slug || !title) {
    return null;
  }

  const locType = ((): 'physical' | 'virtual' | 'hybrid' => {
    const raw = (ev.location_type || '').toString().toLowerCase();
    if (raw === 'virtual' || raw === 'online') return 'virtual';
    if (raw === 'hybrid') return 'hybrid';
    return 'physical';
  })();

  const geo: Api2EventGeo = (ev.geo_address_info as Api2EventGeo) || {};
  const address =
    geo.full_address || geo.address || geo.city_state || geo.city || undefined;

  const coord = ev.coordinate as { latitude?: number; longitude?: number } | undefined;
  const coordinates =
    coord && typeof coord.latitude === 'number' && typeof coord.longitude === 'number'
      ? { lat: coord.latitude, lng: coord.longitude }
      : undefined;

  return {
    slug,
    title,
    description:
      typeof (ev as any).description === 'string' ? (ev as any).description : '',
    start_time: typeof ev.start_at === 'string' ? ev.start_at : '',
    end_time: typeof ev.end_at === 'string' ? ev.end_at : '',
    timezone: (typeof ev.timezone === 'string' && ev.timezone) || 'America/Los_Angeles',
    location: {
      type: locType,
      address,
      coordinates,
    },
    cover_image: typeof ev.cover_url === 'string' ? ev.cover_url : undefined,
    status: 'published',
    host_id: ev.api_id,
    host_name: typeof (ev as any).host_name === 'string' ? (ev as any).host_name : undefined,
    url: `${LUMA_BASE_URL}/${slug}`,
  };
}

const LUMA_BACKOFF_OPTIONS = {
  minIntervalMs: 1000,
  maxRetries: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  retryOnStatuses: [429, 500, 502, 503, 504],
};

/**
 * Fetch with rate limiting
 */
async function fetchHtml(url: string, cookies?: string, options: RequestInit = {}): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  
  if (cookies) {
    headers['Cookie'] = cookies;
  }
  
  const response = await fetchWithBackoff(
    url,
    {
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {}),
      },
    },
    LUMA_BACKOFF_OPTIONS
  );
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return response.text();
}

function selectText($: cheerio.CheerioAPI, selectors: string[], label: string): string {
  for (const selector of selectors) {
    const text = $(selector).first().text().trim();
    if (text) {
      return text;
    }
  }
  console.warn(`[luma] Selector failed for ${label}: ${selectors.join(', ')}`);
  return '';
}

function selectAttr(
  $: cheerio.CheerioAPI,
  selectors: string[],
  attr: string,
  label: string,
  warnOnFail: boolean = true
): string | undefined {
  for (const selector of selectors) {
    const value = $(selector).first().attr(attr);
    if (value) {
      return value.trim();
    }
  }
  if (warnOnFail) {
    console.warn(`[luma] Selector failed for ${label}: ${selectors.join(', ')}`);
  }
  return undefined;
}

function getString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Walk __NEXT_DATA__ looking for the api2-shaped Event object for `slug`.
 * R5 capture confirmed event detail is embedded in lu.ma's SSR HTML rather
 * than fetched via a discrete api2 call, so we hunt for the same field
 * shape we'd otherwise see on the wire (api_id, name, start_at, url=slug).
 */
function findApi2EventInNextData(value: unknown, slug: string): Api2Event | null {
  if (!value || typeof value !== 'object') return null;

  if (!Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const apiId = obj.api_id;
    const url = typeof obj.url === 'string' ? obj.url : undefined;
    const name = obj.name;
    if (typeof apiId === 'string' && url === slug && typeof name === 'string') {
      return obj as Api2Event;
    }
  }

  const entries = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const found = findApi2EventInNextData(entry, slug);
    if (found) return found;
  }
  return null;
}

/**
 * Walk __NEXT_DATA__ collecting every ticket-type object (objects whose
 * api_id starts with `evtticktyp-`). Returns deduped + ordered with free
 * ticket types first — caller almost always wants the cheapest.
 */
interface NextDataTicketType {
  api_id: string;
  price_cents?: number;
  is_free?: boolean;
  is_sold_out?: boolean;
  name?: string;
  [k: string]: unknown;
}

function findTicketTypesInNextData(value: unknown, seen: Set<string> = new Set(), out: NextDataTicketType[] = []): NextDataTicketType[] {
  if (!value || typeof value !== 'object') return out;
  if (!Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const apiId = obj.api_id;
    if (typeof apiId === 'string' && apiId.startsWith('evtticktyp-') && !seen.has(apiId)) {
      seen.add(apiId);
      out.push(obj as unknown as NextDataTicketType);
    }
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) findTicketTypesInNextData(entry, seen, out);
  return out;
}

function pickFreeTicketType(types: NextDataTicketType[]): NextDataTicketType | undefined {
  // Prefer explicit is_free === true OR price_cents === 0; fall back to first
  // available, then absolute first.
  const free = types.find((t) => t.is_free === true || t.price_cents === 0);
  if (free) return free;
  const available = types.find((t) => !t.is_sold_out);
  return available ?? types[0];
}

/**
 * Public: resolve a slug to the event's api2 fields needed for RSVP —
 * event api_id + a usable ticket_type api_id. Used by rsvp.ts.
 */
export async function resolveEventForRsvp(slug: string): Promise<{
  eventApiId: string;
  ticketTypeApiId?: string;
  ticketTypeName?: string;
  isWaitlistOnly?: boolean;
} | null> {
  try {
    const url = `${LUMA_BASE_URL}/${slug}`;
    const html = await fetchHtml(url);
    const nextData = extractJsonScript(html, '__NEXT_DATA__');
    if (!nextData) return null;
    const ev = findApi2EventInNextData(nextData, slug);
    if (!ev) return null;

    const ticketTypes = findTicketTypesInNextData(nextData);
    const chosen = pickFreeTicketType(ticketTypes);

    return {
      eventApiId: ev.api_id,
      ticketTypeApiId: chosen?.api_id,
      ticketTypeName: chosen?.name,
      isWaitlistOnly: ticketTypes.every((t) => t.is_sold_out) && ticketTypes.length > 0,
    };
  } catch (error) {
    console.error(`[luma] resolveEventForRsvp(${slug}) failed:`, error);
    return null;
  }
}

function findEventList(value: unknown): Array<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    const isEventList = value.length > 0 && value.every(item => {
      return item && typeof item === 'object'
        && ('slug' in item)
        && (typeof (item as Record<string, unknown>).slug === 'string');
    });
    if (isEventList) {
      return value as Array<Record<string, unknown>>;
    }
  }

  const entries = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);

  for (const entry of entries) {
    const found = findEventList(entry);
    if (found) {
      return found;
    }
  }

  return null;
}

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
export async function scrapeEvent(slug: string): Promise<LumaEvent | null> {
  try {
    const url = `${LUMA_BASE_URL}/${slug}`;
    const html = await fetchHtml(url);
    const nextData = extractJsonScript(html, '__NEXT_DATA__');
    const ev = nextData ? findApi2EventInNextData(nextData, slug) : null;
    if (!ev) {
      console.warn(`[luma] No __NEXT_DATA__ event match for slug ${slug}`);
      return null;
    }

    const mapped = api2EventToLumaEvent(ev);
    if (!mapped) {
      console.warn(`[luma] __NEXT_DATA__ event for ${slug} missing name/url.`);
      return null;
    }
    return mapped;
  } catch (error) {
    console.error(`Error scraping event ${slug}:`, error);
    return null;
  }
}

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
export async function scrapeDiscover(params: {
  lat?: number;
  lng?: number;
  query?: string;
}): Promise<LumaEvent[]> {
  try {
    // The api2 client takes the same cookies a logged-in user has. We may
    // not have any (discover is public), so pass an empty header in that
    // case — lu.ma still returns results.
    const cookies = (await loadCookies()) || '';
    const client = new LumaApi2Client(cookies);

    // For now we always use the search endpoint. Empty query returns a
    // generic feed; specifying a city via lat/lng would require the
    // discover/bootstrap-page endpoint (featured_place_api_id discovery is
    // out of scope for v1.1). Callers that need pure geographic discovery
    // can pass a city name as `query`.
    const query = (params.query || '').trim();
    const result = await client.search(query);

    const apiEvents = Array.isArray(result.events) ? result.events : [];
    const events: LumaEvent[] = [];
    const seen = new Set<string>();

    for (const entry of apiEvents) {
      const inner = (entry && (entry as any).event) as Api2Event | undefined;
      if (!inner) continue;
      const mapped = api2EventToLumaEvent(inner);
      if (!mapped || seen.has(mapped.slug)) continue;
      seen.add(mapped.slug);
      events.push(mapped);
    }

    return events;
  } catch (error) {
    if (error instanceof LumaApi2Error) {
      console.error(`[luma] discover via api2 failed (${error.status}):`, error.bodyText.slice(0, 200));
    } else {
      console.error('Error scraping discover page:', error);
    }
    return [];
  }
}

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
export async function scrapeMyEvents(cookies: string): Promise<LumaEvent[]> {
  try {
    const client = new LumaApi2Client(cookies);
    const result = await client.myEvents('future', 20);
    const entries = Array.isArray(result.entries) ? result.entries : [];

    const events: LumaEvent[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const ev = entry?.event;
      if (!ev) continue;
      const mapped = api2EventToLumaEvent(ev);
      if (!mapped || seen.has(mapped.slug)) continue;
      seen.add(mapped.slug);
      events.push(mapped);
    }
    return events;
  } catch (error) {
    if (error instanceof LumaApi2Error) {
      console.error(`[luma] my events via api2 failed (${error.status}):`, error.bodyText.slice(0, 200));
    } else {
      console.error('Error scraping my events:', error);
    }
    return [];
  }
}

/**
 * Scrape hosted events (requires auth)
 */
export async function scrapeHostedEvents(cookies: string): Promise<LumaEvent[]> {
  try {
    const html = await fetchHtml(`${LUMA_BASE_URL}/home/manage`, cookies);
    const $ = cheerio.load(html);
    
    const events: LumaEvent[] = [];
    
    // Similar parsing logic
    $('a[href^="/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      
      const slug = href.replace('/', '');
      const title = $(el).find('h3, h4').first().text().trim();
      
      if (title && slug && !slug.includes('/')) {
        events.push({
          slug,
          title,
          description: '',
          start_time: '',
          end_time: '',
          timezone: 'America/Los_Angeles',
          location: { type: 'physical' },
          status: 'published',
          host_id: '',
          host_name: '',
          url: `${LUMA_BASE_URL}/${slug}`,
        });
      }
    });
    
    if (events.length === 0) {
      console.warn('[luma] No hosted events found with primary selectors. Trying Next.js data...');
      const nextData = extractJsonScript(html, '__NEXT_DATA__');
      const eventList = nextData ? findEventList(nextData) : null;
      if (eventList) {
        for (const item of eventList) {
          const slugValue = getString(item.slug);
          const titleValue = getString(item.title) || getString(item.name) || getString(item.event_name);
          if (!slugValue || !titleValue) continue;
          events.push({
            slug: slugValue,
            title: titleValue,
            description: '',
            start_time: getString(item.start_time) || getString(item.start_at) || '',
            end_time: getString(item.end_time) || getString(item.end_at) || '',
            timezone: getString(item.timezone) || 'America/Los_Angeles',
            location: { type: 'physical' },
            status: 'published',
            host_id: '',
            host_name: getString(item.host_name) || '',
            url: `${LUMA_BASE_URL}/${slugValue}`,
          });
        }
      }
    }

    return events;
  } catch (error) {
    console.error('Error scraping hosted events:', error);
    return [];
  }
}

/**
 * Scrape guest list (requires auth)
 */
export async function scrapeGuestList(slug: string, cookies: string): Promise<Attendee[]> {
  try {
    const html = await fetchHtml(`${LUMA_BASE_URL}/${slug}/guests`, cookies);
    const $ = cheerio.load(html);
    
    const guests: Attendee[] = [];
    
    // Parse guest entries
    $('[data-testid="guest-row"], [class*="guest"], [data-testid="attendee-row"]').each((i, el) => {
      const name = $(el).find('[class*="name"], [data-testid="guest-name"]').first().text().trim();
      const avatar = $(el).find('img').attr('src');
      
      if (name) {
        guests.push({
          name,
          avatar,
          status: 'going',
        });
      }
    });

    if (guests.length === 0) {
      console.warn(`[luma] Guest list selectors failed for ${slug}.`);
    }

    return guests;
  } catch (error) {
    console.error(`Error scraping guest list for ${slug}:`, error);
    return [];
  }
}

/**
 * Load cookies — env vars first (set by javis-server after the WebView
 * capture or OTP flow via the skill_credentials service), then fall back to
 * `pass show luma/cookies` for local-dev environments.
 *
 * The current WebView flow sets `luma.auth-session-key` + `luma.did`; the
 * legacy OTP flow sets `luma_session` + `luma_user_id`. Both are sent if
 * present so api2.luma.com sees the cookies its web client sends.
 */
export async function loadCookies(): Promise<string | null> {
  const parts: string[] = [];

  // WebView flow (current). The cookie names contain dots so they must be
  // passed literally — api2.luma.com looks for `luma.auth-session-key`.
  const authSessionKey = process.env.LUMA_AUTH_SESSION_KEY;
  const did = process.env.LUMA_DID;
  if (authSessionKey) parts.push(`luma.auth-session-key=${authSessionKey}`);
  if (did) parts.push(`luma.did=${did}`);

  // OTP / paste flow (legacy). Kept for stored rows from earlier versions.
  const envSession = process.env.LUMA_SESSION;
  const envUserId = process.env.LUMA_USER_ID;
  if (envSession) parts.push(`luma_session=${envSession}`);
  if (envUserId) parts.push(`luma_user_id=${envUserId}`);

  if (parts.length > 0) {
    return parts.join('; ');
  }

  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const { stdout } = await execAsync('pass show luma/cookies 2>/dev/null', {
      encoding: 'utf8',
    });

    const cookiesJson = stdout.trim();
    if (!cookiesJson) {
      return null;
    }

    // Parse JSON and convert to cookie string
    const cookies = JSON.parse(cookiesJson);
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  } catch (error) {
    return null;
  }
}

/**
 * Check if authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  const cookies = await loadCookies();
  return cookies !== null;
}
