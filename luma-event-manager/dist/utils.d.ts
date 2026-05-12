/**
 * Utility functions for Luma skill
 */
import { Location } from './index';
export interface BackoffOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    minIntervalMs?: number;
    retryOnStatuses?: number[];
}
export declare function fetchWithBackoff(url: string, options?: RequestInit, backoffOptions?: BackoffOptions): Promise<Response>;
export declare function extractJsonScript(html: string, scriptId: string): unknown | null;
export declare function findFirstObjectWithKeys(value: unknown, keys: string[], predicate?: (candidate: Record<string, unknown>) => boolean): Record<string, unknown> | null;
/**
 * Geocode a location string to coordinates
 * Uses Nominatim (OpenStreetMap) - free, no API key required
 */
export declare function geocodeLocation(location: string): Promise<Location | null>;
/**
 * Calculate distance between two coordinates (Haversine formula)
 */
export declare function calculateDistance(loc1: Location, loc2: Location, unit?: 'miles' | 'km'): number;
/**
 * Format date for display
 */
export declare function formatDate(dateString: string): string;
/**
 * Parse relative date to ISO string
 */
export declare function parseRelativeDate(dateStr: string): string;
/**
 * Format event for display
 */
export declare function formatEventForDisplay(event: {
    id: string;
    title: string;
    start_time: string;
    location: {
        type: string;
        address?: string;
    };
}): string;
/**
 * Parse Luma event ID from URL or string
 */
export declare function parseEventId(input: string): string;
/**
 * Check if Luma API key is configured
 */
export declare function isConfigured(): Promise<boolean>;
//# sourceMappingURL=utils.d.ts.map