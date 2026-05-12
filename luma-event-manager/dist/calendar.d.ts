/**
 * Google Calendar sync via gog CLI
 */
import { LumaEvent } from './index';
interface CalendarSyncOptions {
    account?: string;
    calendarId?: string;
}
export declare function syncEventToGoogleCalendar(event: LumaEvent, options?: CalendarSyncOptions): Promise<{
    success: boolean;
    message: string;
    event_id?: string;
    calendar_id?: string;
    account?: string;
}>;
export {};
//# sourceMappingURL=calendar.d.ts.map