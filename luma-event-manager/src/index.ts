/**
 * Luma Event Manager — type definitions only.
 *
 * The handleToolCall / handle* dispatch switch that used to live here was the
 * clawdbot integration shape. openclaw never read it (see the 2026-05-12
 * workspace-skill loader bug: openclaw injects SKILL.md but does not register
 * declared tools). The dispatch was removed in the openclaw plugin redesign;
 * Task 9 of that plan copies the api2Client/rsvp/scraper code into
 * openclaw/extensions/luma-event-manager/ where tools register via the
 * native @openclaw/plugin-sdk surface.
 *
 * Until that migration lands, these interfaces remain as the shared shape
 * used by scraper.ts + rsvp.ts + api2Client.ts in this directory.
 */

export interface LumaEvent {
  slug: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  timezone: string;
  location: {
    type: 'physical' | 'virtual' | 'hybrid';
    name?: string;
    address?: string;
    coordinates?: { lat: number; lng: number };
    virtual_link?: string;
  };
  cover_image?: string;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  host_id: string;
  host_name?: string;
  url: string;
}

export interface Attendee {
  name: string;
  avatar?: string;
  status: 'going' | 'maybe' | 'waitlisted';
}

export interface Location {
  lat: number;
  lng: number;
}
