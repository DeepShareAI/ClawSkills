"use strict";
/**
 * Luma Web Scraper
 * Scrapes event data from lu.ma pages
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveEventForRsvp = resolveEventForRsvp;
exports.scrapeEvent = scrapeEvent;
exports.scrapeDiscover = scrapeDiscover;
exports.scrapeMyEvents = scrapeMyEvents;
exports.scrapeHostedEvents = scrapeHostedEvents;
exports.scrapeGuestList = scrapeGuestList;
exports.loadCookies = loadCookies;
exports.isAuthenticated = isAuthenticated;
const cheerio = __importStar(require("cheerio"));
const utils_1 = require("./utils");
const api2Client_1 = require("./api2Client");
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
function api2EventToLumaEvent(ev) {
    const slug = typeof ev.url === 'string' ? ev.url : undefined;
    const title = typeof ev.name === 'string' ? ev.name : undefined;
    if (!slug || !title) {
        return null;
    }
    const locType = (() => {
        const raw = (ev.location_type || '').toString().toLowerCase();
        if (raw === 'virtual' || raw === 'online')
            return 'virtual';
        if (raw === 'hybrid')
            return 'hybrid';
        return 'physical';
    })();
    const geo = ev.geo_address_info || {};
    const address = geo.full_address || geo.address || geo.city_state || geo.city || undefined;
    const coord = ev.coordinate;
    const coordinates = coord && typeof coord.latitude === 'number' && typeof coord.longitude === 'number'
        ? { lat: coord.latitude, lng: coord.longitude }
        : undefined;
    return {
        slug,
        title,
        description: typeof ev.description === 'string' ? ev.description : '',
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
        host_name: typeof ev.host_name === 'string' ? ev.host_name : undefined,
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
async function fetchHtml(url, cookies, options = {}) {
    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
    };
    if (cookies) {
        headers['Cookie'] = cookies;
    }
    const response = await (0, utils_1.fetchWithBackoff)(url, {
        ...options,
        headers: {
            ...headers,
            ...(options.headers || {}),
        },
    }, LUMA_BACKOFF_OPTIONS);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
}
function selectText($, selectors, label) {
    for (const selector of selectors) {
        const text = $(selector).first().text().trim();
        if (text) {
            return text;
        }
    }
    console.warn(`[luma] Selector failed for ${label}: ${selectors.join(', ')}`);
    return '';
}
function selectAttr($, selectors, attr, label, warnOnFail = true) {
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
function getString(value) {
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
function findApi2EventInNextData(value, slug) {
    if (!value || typeof value !== 'object')
        return null;
    if (!Array.isArray(value)) {
        const obj = value;
        const apiId = obj.api_id;
        const url = typeof obj.url === 'string' ? obj.url : undefined;
        const name = obj.name;
        if (typeof apiId === 'string' && url === slug && typeof name === 'string') {
            return obj;
        }
    }
    const entries = Array.isArray(value)
        ? value
        : Object.values(value);
    for (const entry of entries) {
        const found = findApi2EventInNextData(entry, slug);
        if (found)
            return found;
    }
    return null;
}
function findTicketTypesInNextData(value, seen = new Set(), out = []) {
    if (!value || typeof value !== 'object')
        return out;
    if (!Array.isArray(value)) {
        const obj = value;
        const apiId = obj.api_id;
        if (typeof apiId === 'string' && apiId.startsWith('evtticktyp-') && !seen.has(apiId)) {
            seen.add(apiId);
            out.push(obj);
        }
    }
    const entries = Array.isArray(value) ? value : Object.values(value);
    for (const entry of entries)
        findTicketTypesInNextData(entry, seen, out);
    return out;
}
function pickFreeTicketType(types) {
    // Prefer explicit is_free === true OR price_cents === 0; fall back to first
    // available, then absolute first.
    const free = types.find((t) => t.is_free === true || t.price_cents === 0);
    if (free)
        return free;
    const available = types.find((t) => !t.is_sold_out);
    return available ?? types[0];
}
/**
 * Public: resolve a slug to the event's api2 fields needed for RSVP —
 * event api_id + a usable ticket_type api_id. Used by rsvp.ts.
 */
async function resolveEventForRsvp(slug) {
    try {
        const url = `${LUMA_BASE_URL}/${slug}`;
        const html = await fetchHtml(url);
        const nextData = (0, utils_1.extractJsonScript)(html, '__NEXT_DATA__');
        if (!nextData)
            return null;
        const ev = findApi2EventInNextData(nextData, slug);
        if (!ev)
            return null;
        const ticketTypes = findTicketTypesInNextData(nextData);
        const chosen = pickFreeTicketType(ticketTypes);
        return {
            eventApiId: ev.api_id,
            ticketTypeApiId: chosen?.api_id,
            ticketTypeName: chosen?.name,
            isWaitlistOnly: ticketTypes.every((t) => t.is_sold_out) && ticketTypes.length > 0,
        };
    }
    catch (error) {
        console.error(`[luma] resolveEventForRsvp(${slug}) failed:`, error);
        return null;
    }
}
function findEventList(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    if (Array.isArray(value)) {
        const isEventList = value.length > 0 && value.every(item => {
            return item && typeof item === 'object'
                && ('slug' in item)
                && (typeof item.slug === 'string');
        });
        if (isEventList) {
            return value;
        }
    }
    const entries = Array.isArray(value)
        ? value
        : Object.values(value);
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
async function scrapeEvent(slug) {
    try {
        const url = `${LUMA_BASE_URL}/${slug}`;
        const html = await fetchHtml(url);
        const nextData = (0, utils_1.extractJsonScript)(html, '__NEXT_DATA__');
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
    }
    catch (error) {
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
async function scrapeDiscover(params) {
    try {
        // The api2 client takes the same cookies a logged-in user has. We may
        // not have any (discover is public), so pass an empty header in that
        // case — lu.ma still returns results.
        const cookies = (await loadCookies()) || '';
        const client = new api2Client_1.LumaApi2Client(cookies);
        // For now we always use the search endpoint. Empty query returns a
        // generic feed; specifying a city via lat/lng would require the
        // discover/bootstrap-page endpoint (featured_place_api_id discovery is
        // out of scope for v1.1). Callers that need pure geographic discovery
        // can pass a city name as `query`.
        const query = (params.query || '').trim();
        const result = await client.search(query);
        const apiEvents = Array.isArray(result.events) ? result.events : [];
        const events = [];
        const seen = new Set();
        for (const entry of apiEvents) {
            const inner = (entry && entry.event);
            if (!inner)
                continue;
            const mapped = api2EventToLumaEvent(inner);
            if (!mapped || seen.has(mapped.slug))
                continue;
            seen.add(mapped.slug);
            events.push(mapped);
        }
        return events;
    }
    catch (error) {
        if (error instanceof api2Client_1.LumaApi2Error) {
            console.error(`[luma] discover via api2 failed (${error.status}):`, error.bodyText.slice(0, 200));
        }
        else {
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
async function scrapeMyEvents(cookies) {
    try {
        const client = new api2Client_1.LumaApi2Client(cookies);
        const result = await client.myEvents('future', 20);
        const entries = Array.isArray(result.entries) ? result.entries : [];
        const events = [];
        const seen = new Set();
        for (const entry of entries) {
            const ev = entry?.event;
            if (!ev)
                continue;
            const mapped = api2EventToLumaEvent(ev);
            if (!mapped || seen.has(mapped.slug))
                continue;
            seen.add(mapped.slug);
            events.push(mapped);
        }
        return events;
    }
    catch (error) {
        if (error instanceof api2Client_1.LumaApi2Error) {
            console.error(`[luma] my events via api2 failed (${error.status}):`, error.bodyText.slice(0, 200));
        }
        else {
            console.error('Error scraping my events:', error);
        }
        return [];
    }
}
/**
 * Scrape hosted events (requires auth)
 */
async function scrapeHostedEvents(cookies) {
    try {
        const html = await fetchHtml(`${LUMA_BASE_URL}/home/manage`, cookies);
        const $ = cheerio.load(html);
        const events = [];
        // Similar parsing logic
        $('a[href^="/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (!href)
                return;
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
            const nextData = (0, utils_1.extractJsonScript)(html, '__NEXT_DATA__');
            const eventList = nextData ? findEventList(nextData) : null;
            if (eventList) {
                for (const item of eventList) {
                    const slugValue = getString(item.slug);
                    const titleValue = getString(item.title) || getString(item.name) || getString(item.event_name);
                    if (!slugValue || !titleValue)
                        continue;
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
    }
    catch (error) {
        console.error('Error scraping hosted events:', error);
        return [];
    }
}
/**
 * Scrape guest list (requires auth)
 */
async function scrapeGuestList(slug, cookies) {
    try {
        const html = await fetchHtml(`${LUMA_BASE_URL}/${slug}/guests`, cookies);
        const $ = cheerio.load(html);
        const guests = [];
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
    }
    catch (error) {
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
async function loadCookies() {
    const parts = [];
    // WebView flow (current). The cookie names contain dots so they must be
    // passed literally — api2.luma.com looks for `luma.auth-session-key`.
    const authSessionKey = process.env.LUMA_AUTH_SESSION_KEY;
    const did = process.env.LUMA_DID;
    if (authSessionKey)
        parts.push(`luma.auth-session-key=${authSessionKey}`);
    if (did)
        parts.push(`luma.did=${did}`);
    // OTP / paste flow (legacy). Kept for stored rows from earlier versions.
    const envSession = process.env.LUMA_SESSION;
    const envUserId = process.env.LUMA_USER_ID;
    if (envSession)
        parts.push(`luma_session=${envSession}`);
    if (envUserId)
        parts.push(`luma_user_id=${envUserId}`);
    if (parts.length > 0) {
        return parts.join('; ');
    }
    try {
        const { exec } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const { promisify } = await Promise.resolve().then(() => __importStar(require('util')));
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
    }
    catch (error) {
        return null;
    }
}
/**
 * Check if authenticated
 */
async function isAuthenticated() {
    const cookies = await loadCookies();
    return cookies !== null;
}
//# sourceMappingURL=scraper.js.map