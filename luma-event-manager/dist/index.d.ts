/**
 * Luma Event Manager Skill for Clawdbot
 *
 * Manage Luma events as host or attendee via web scraping.
 * Geographic filtering, guest lists, RSVP, and calendar sync.
 */
import { tools } from './skill-types';
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
        coordinates?: {
            lat: number;
            lng: number;
        };
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
export { tools };
export declare function handleToolCall(toolName: string, args: Record<string, any>): Promise<any>;
//# sourceMappingURL=index.d.ts.map