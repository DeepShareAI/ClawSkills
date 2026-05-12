"use strict";
/**
 * Google Calendar sync via gog CLI
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncEventToGoogleCalendar = syncEventToGoogleCalendar;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
function toRfc3339(input) {
    if (!input)
        return null;
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    return parsed.toISOString();
}
function buildDescription(event) {
    const parts = [];
    if (event.description) {
        parts.push(event.description.trim());
    }
    parts.push(`Luma: ${event.url}`);
    return parts.join('\n\n');
}
function resolveLocation(event) {
    if (event.location.type === 'virtual') {
        return event.location.virtual_link || 'Virtual event';
    }
    return event.location.address || event.location.name || 'See event page';
}
async function runGogCommand(args) {
    try {
        const result = await execFileAsync('gog', args, { encoding: 'utf8' });
        return { stdout: result.stdout, stderr: result.stderr ?? '' };
    }
    catch (error) {
        const stderr = error?.stderr || '';
        const stdout = error?.stdout || '';
        const message = error?.message || 'gog command failed';
        throw new Error(`${message}\n${stderr || stdout}`.trim());
    }
}
async function listGogAccounts() {
    try {
        const { stdout } = await runGogCommand(['auth', 'list', '--json']);
        const parsed = JSON.parse(stdout);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (error) {
        console.warn('[luma] Unable to list gog accounts:', error instanceof Error ? error.message : error);
        return [];
    }
}
async function resolveAccount(explicitAccount) {
    if (explicitAccount) {
        return explicitAccount;
    }
    const envAccount = process.env.GOG_ACCOUNT;
    if (envAccount) {
        return envAccount;
    }
    const accounts = await listGogAccounts();
    if (accounts.length === 1) {
        return accounts[0].email;
    }
    return null;
}
async function syncEventToGoogleCalendar(event, options = {}) {
    const account = await resolveAccount(options.account);
    if (!account) {
        return {
            success: false,
            message: 'Multiple or zero Google accounts found. Provide an account email or set GOG_ACCOUNT.',
        };
    }
    const calendarId = options.calendarId || 'primary';
    const start = toRfc3339(event.start_time);
    if (!start) {
        return {
            success: false,
            message: 'Event start time is missing or invalid. Cannot create calendar entry.',
            account,
            calendar_id: calendarId,
        };
    }
    const end = toRfc3339(event.end_time) || new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    const description = buildDescription(event);
    const location = resolveLocation(event);
    const args = [
        'calendar',
        'create',
        calendarId,
        '--summary',
        event.title,
        '--from',
        start,
        '--to',
        end,
        '--description',
        description,
        '--location',
        location,
        '--source-url',
        event.url,
        '--source-title',
        'Luma',
        '--send-updates',
        'none',
        '--account',
        account,
        '--json',
    ];
    try {
        const { stdout } = await runGogCommand(args);
        const payload = stdout ? JSON.parse(stdout) : {};
        return {
            success: true,
            message: `Added to Google Calendar (${calendarId}).`,
            event_id: payload.id,
            calendar_id: calendarId,
            account,
        };
    }
    catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Failed to create calendar entry.',
            account,
            calendar_id: calendarId,
        };
    }
}
//# sourceMappingURL=calendar.js.map