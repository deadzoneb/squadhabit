"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidTimezone = isValidTimezone;
exports.getLocalDateString = getLocalDateString;
exports.getLocalHour = getLocalHour;
exports.getTimezoneOffsetMinutes = getTimezoneOffsetMinutes;
exports.getPreviousDateString = getPreviousDateString;
exports.getLastNDates = getLastNDates;
function assertValidDate(date) {
    if (Number.isNaN(date.getTime())) {
        throw new Error("Invalid date");
    }
}
function getDateTimeParts(date, timezone) {
    assertValidDate(date);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    return Object.fromEntries(parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]));
}
function isValidTimezone(timezone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        return true;
    }
    catch (error) {
        if (error instanceof RangeError) {
            return false;
        }
        throw error;
    }
}
function getLocalDateString(date = new Date(), timezone = "UTC") {
    const parts = getDateTimeParts(date, timezone);
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
function getLocalHour(date = new Date(), timezone = "UTC") {
    return getDateTimeParts(date, timezone).hour;
}
function getTimezoneOffsetMinutes(date = new Date(), timezone = "UTC") {
    const parts = getDateTimeParts(date, timezone);
    const localTimeAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((localTimeAsUtc - date.getTime()) / 60_000);
}
function getPreviousDateString(dateString) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        throw new Error(`Invalid date string: ${dateString}`);
    }
    const date = new Date(`${dateString}T00:00:00.000Z`);
    if (date.toISOString().slice(0, 10) !== dateString) {
        throw new Error(`Invalid date string: ${dateString}`);
    }
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}
function getLastNDates(count, timezone = "UTC", now = new Date()) {
    if (!Number.isInteger(count) || count < 0) {
        throw new Error("count must be a non-negative integer");
    }
    const dates = [];
    let date = getLocalDateString(now, timezone);
    for (let index = 0; index < count; index += 1) {
        dates.push(date);
        date = getPreviousDateString(date);
    }
    return dates;
}
