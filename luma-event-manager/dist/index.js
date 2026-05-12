"use strict";
/**
 * Luma Event Manager Skill for Clawdbot
 *
 * Manage Luma events as host or attendee via web scraping.
 * Geographic filtering, guest lists, RSVP, and calendar sync.
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
exports.tools = void 0;
exports.handleToolCall = handleToolCall;
const skill_types_1 = require("./skill-types");
Object.defineProperty(exports, "tools", { enumerable: true, get: function () { return skill_types_1.tools; } });
const scraper = __importStar(require("./scraper"));
const utils_1 = require("./utils");
const calendar_1 = require("./calendar");
const rsvp_1 = require("./rsvp");
// Main handler function
async function handleToolCall(toolName, args) {
    switch (toolName) {
        case 'luma_host_events':
            return handleHostEvents();
        case 'luma_host_event':
            return handleHostEvent(args.event_id || args.slug);
        case 'luma_host_guests':
            return handleHostGuests(args.event_id || args.slug);
        case 'luma_events_near':
            return handleEventsNear(args.location, args.radius_miles, args.start_date, args.end_date);
        case 'luma_search':
            return handleSearch(args.query, args.location);
        case 'luma_events_on':
            return handleEventsOnDate(args.date);
        case 'luma_my_events':
            return handleMyEvents();
        case 'luma_event_details':
            return handleEventDetails(args.event_id || args.slug);
        case 'luma_rsvp':
            return handleRSVP(args.event_id || args.slug, args.response);
        case 'luma_add_calendar':
            return handleAddCalendar(args.event_id || args.slug, args.account, args.calendar_id);
        case 'luma_configure':
            return handleConfigure();
        case 'luma_status':
            return handleStatus();
        case 'luma_help':
            return handleHelp();
        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}
// Handler implementations
async function handleHostEvents() {
    const cookies = await scraper.loadCookies();
    if (!cookies) {
        return {
            error: 'Not authenticated',
            message: "You need to set up Luma cookies first. Run 'luma configure' for instructions.",
        };
    }
    const events = await scraper.scrapeHostedEvents(cookies);
    if (events.length === 0) {
        return { message: "No hosted events found." };
    }
    return {
        count: events.length,
        events: events.map(e => ({
            slug: e.slug,
            title: e.title,
            url: e.url,
        })),
    };
}
async function handleHostEvent(slug) {
    if (!slug) {
        return { error: "Event slug is required" };
    }
    const event = await scraper.scrapeEvent(slug);
    if (!event) {
        return { error: `Event '${slug}' not found` };
    }
    return {
        title: event.title,
        description: event.description,
        date: event.start_time,
        location: event.location.address || event.location.type,
        host: event.host_name,
        url: event.url,
    };
}
async function handleHostGuests(slug) {
    if (!slug) {
        return { error: "Event slug is required" };
    }
    const cookies = await scraper.loadCookies();
    if (!cookies) {
        return {
            error: 'Not authenticated',
            message: "You need to set up Luma cookies to view guest lists. Run 'luma configure' for instructions.",
        };
    }
    const guests = await scraper.scrapeGuestList(slug, cookies);
    if (guests.length === 0) {
        return { message: "No guests found or unable to access guest list." };
    }
    return {
        count: guests.length,
        guests: guests.map(g => ({
            name: g.name,
            status: g.status,
        })),
    };
}
async function handleEventsNear(location, radiusMiles = 25, startDate, endDate) {
    if (!location) {
        return { error: "Location is required" };
    }
    // Geocode the location
    const coords = await (0, utils_1.geocodeLocation)(location);
    if (!coords) {
        return { error: `Could not find location: ${location}` };
    }
    // Scrape discover page with location
    const events = await scraper.scrapeDiscover({
        lat: coords.lat,
        lng: coords.lng,
    });
    if (events.length === 0) {
        return { message: `No events found near ${location}` };
    }
    return {
        location,
        coordinates: coords,
        radius: radiusMiles,
        count: events.length,
        events: events.slice(0, 10).map(e => ({
            title: e.title,
            slug: e.slug,
            url: e.url,
        })),
        note: "For more details, use 'luma event <slug>'",
    };
}
async function handleSearch(query, location) {
    if (!query) {
        return { error: "Search query is required" };
    }
    // Optionally geocode location for combined search
    let coords;
    if (location) {
        coords = await (0, utils_1.geocodeLocation)(location) || undefined;
    }
    const events = await scraper.scrapeDiscover({
        query,
        lat: coords?.lat,
        lng: coords?.lng,
    });
    if (events.length === 0) {
        return {
            message: `No events found for "${query}"${location ? ` near ${location}` : ''}`,
            suggestion: "Try broader terms or check lu.ma/discover directly",
        };
    }
    return {
        query,
        location: location || null,
        count: events.length,
        events: events.slice(0, 15).map(e => ({
            title: e.title,
            slug: e.slug,
            url: e.url,
        })),
        note: "For details, use 'luma event <slug>'",
    };
}
async function handleEventsOnDate(date) {
    // For now, just return discover results
    // TODO: Filter by date
    const events = await scraper.scrapeDiscover({});
    return {
        date,
        count: events.length,
        events: events.slice(0, 10).map(e => ({
            title: e.title,
            slug: e.slug,
            url: e.url,
        })),
        note: "Date filtering coming soon. Showing all upcoming events.",
    };
}
async function handleMyEvents() {
    const cookies = await scraper.loadCookies();
    if (!cookies) {
        return {
            error: 'Not authenticated',
            message: "You need to set up Luma cookies first. Run 'luma configure' for instructions.",
        };
    }
    const events = await scraper.scrapeMyEvents(cookies);
    if (events.length === 0) {
        return { message: "No upcoming RSVP'd events found." };
    }
    return {
        count: events.length,
        events: events.map(e => ({
            title: e.title,
            slug: e.slug,
            url: e.url,
        })),
    };
}
async function handleEventDetails(slug) {
    if (!slug) {
        return { error: "Event slug is required. Example: 'luma event ai-meetup-sf'" };
    }
    // Clean the slug (remove URL if full URL provided)
    const cleanSlug = slug.replace('https://lu.ma/', '').replace('http://lu.ma/', '').split('/')[0];
    const event = await scraper.scrapeEvent(cleanSlug);
    if (!event) {
        return { error: `Event '${cleanSlug}' not found. Check the event URL/slug.` };
    }
    return {
        title: event.title,
        description: event.description || 'No description available',
        date: event.start_time || 'Date not available',
        location: event.location.type === 'virtual'
            ? '🌐 Virtual Event'
            : `📍 ${event.location.address || 'Location on event page'}`,
        host: event.host_name || 'Unknown',
        url: event.url,
        image: event.cover_image,
    };
}
async function handleRSVP(slug, response) {
    if (!slug) {
        return { error: 'Event slug is required for RSVP.' };
    }
    if (!response) {
        return { error: 'RSVP response is required (yes, no, maybe, waitlist).' };
    }
    const cookies = await scraper.loadCookies();
    if (!cookies) {
        return {
            error: 'Not authenticated',
            message: "You need to set up Luma cookies to RSVP. Run 'luma configure' for instructions.",
        };
    }
    const cleanSlug = (0, utils_1.parseEventId)(slug);
    const result = await (0, rsvp_1.rsvpToEvent)(cleanSlug, response, cookies);
    if (!result.success) {
        return {
            error: 'RSVP failed',
            message: result.message,
            url: `https://lu.ma/${cleanSlug}`,
        };
    }
    return {
        message: result.message,
        url: `https://lu.ma/${cleanSlug}`,
    };
}
async function handleAddCalendar(slug, account, calendarId) {
    if (!slug) {
        return { error: 'Event slug is required.' };
    }
    const cleanSlug = (0, utils_1.parseEventId)(slug);
    const event = await scraper.scrapeEvent(cleanSlug);
    if (!event) {
        return { error: `Event '${cleanSlug}' not found` };
    }
    const result = await (0, calendar_1.syncEventToGoogleCalendar)(event, {
        account,
        calendarId,
    });
    if (!result.success) {
        return {
            error: 'Calendar sync failed',
            message: result.message,
            account: result.account,
            calendar_id: result.calendar_id,
        };
    }
    return {
        message: result.message,
        event: event.title,
        calendar_id: result.calendar_id,
        account: result.account,
        url: event.url,
    };
}
async function handleConfigure() {
    const isAuth = await scraper.isAuthenticated();
    return {
        authenticated: isAuth,
        message: isAuth
            ? "✅ Luma cookies are configured. You can access your events and guest lists."
            : "❌ Luma cookies not configured.",
        instructions: [
            "To set up authenticated access:",
            "",
            "1. Log into lu.ma in your browser",
            "2. Open DevTools (F12) → Application → Cookies → lu.ma",
            "3. Copy these cookie values:",
            "   - luma_session",
            "   - luma_user_id (or similar auth cookies)",
            "",
            "4. Run: pass insert luma/cookies",
            "5. Enter JSON format:",
            '   {"luma_session": "your_value", "luma_user_id": "your_value"}',
            "",
            "Without cookies, you can still discover public events.",
        ].join('\n'),
    };
}
async function handleStatus() {
    const isAuth = await scraper.isAuthenticated();
    // Test scraping with a simple request
    let scrapingWorks = false;
    try {
        const events = await scraper.scrapeDiscover({});
        scrapingWorks = events.length >= 0; // Even 0 events is OK if no error
    }
    catch {
        scrapingWorks = false;
    }
    return {
        status: scrapingWorks ? 'operational' : 'degraded',
        authenticated: isAuth,
        scraping: scrapingWorks ? 'working' : 'error',
        message: scrapingWorks
            ? `Luma skill is operational. ${isAuth ? 'Authenticated.' : 'Not authenticated (public access only).'}`
            : 'Luma scraping may be blocked or lu.ma is unavailable.',
    };
}
async function handleHelp() {
    return {
        message: `📅 Luma Event Manager Help

DISCOVER (no auth required):
  luma search <topic>          - Search by topic/theme/keyword
  luma events near <location>  - Find events nearby
  luma events on <date>        - Events on specific date
  luma event <slug>            - Event details

MY EVENTS (auth required):
  luma my events               - Your RSVP'd events
  luma host events             - Events you're hosting
  luma host guests <slug>      - View guest list
  luma rsvp <slug> <response>  - RSVP yes/no/maybe/waitlist

SETUP:
  luma configure               - Set up cookies
  luma status                  - Check connection
  luma help                    - Show this help
  luma add calendar <slug>     - Add event to Google Calendar (optional: account/calendar)

EXAMPLES:
  "luma search AI"
  "luma search startup near San Francisco"
  "luma events near San Francisco"
  "luma event ai-meetup-sf"
  "luma my events"
  "luma rsvp ai-meetup-sf yes"
  "luma add calendar ai-meetup-sf"

Note: For host features, you need to configure cookies first.`,
    };
}
//# sourceMappingURL=index.js.map