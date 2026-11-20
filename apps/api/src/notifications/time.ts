// Local time for notifications: "today" for an air date, and quiet hours.

/** Quiet hours: from 23:00 to 08:00 local time, push messages wait. */
const QUIET_FROM = 23;
const QUIET_UNTIL = 8;

export interface LocalTime {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
}

export function localTime(now: number, timeZone: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** When a notification made at `now` may be pushed: now, or 08:00 after quiet hours. */
export function afterQuietHours(now: number, timeZone: string): number {
  const { hour, minute } = localTime(now, timeZone);
  if (hour >= QUIET_FROM || hour < QUIET_UNTIL) {
    const minutes = (QUIET_UNTIL * 60 - (hour * 60 + minute) + 24 * 60) % (24 * 60);
    // On the minute: the clock may be a little past (seconds).
    return now - (now % 60_000) + minutes * 60_000;
  }
  return now;
}
