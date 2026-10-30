// Ported from T3 Code `resolveSnoozePresets`; see src/features/threads/UPSTREAM.md.

const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = 'hour' | 'three-hours' | 'evening' | 'tomorrow' | 'next-week';

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  /** Complements the label: "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". */
  whenLabel: string;
  /** Wake time in unix seconds, the snooze ledger's unit. */
  until: number;
}

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar days, not 24h offsets, so DST changes land on the right local day.
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * "This evening" only shows while evening is more than an hour away. On Sundays
 * "Tomorrow" and "Next week" are both Monday morning, so only "Tomorrow" shows.
 */
export function resolveSnoozePresets(now: Date): SnoozePreset[] {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    { id: 'hour', label: 'In 1 hour', whenLabel: timeLabel(inAnHour), until: seconds(inAnHour) },
    { id: 'three-hours', label: 'In 3 hours', whenLabel: timeLabel(inThreeHours), until: seconds(inThreeHours) },
  ];
  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({ id: 'evening', label: 'This evening', whenLabel: timeLabel(evening), until: seconds(evening) });
  }
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({ id: 'tomorrow', label: 'Tomorrow', whenLabel: timeLabel(tomorrow), until: seconds(tomorrow) });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({ id: 'next-week', label: 'Next week', whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: 'short' })} ${timeLabel(nextWeek)}`, until: seconds(nextWeek) });
  }
  return presets;
}

/** A custom wake time in unix seconds, or undefined when it is not in the future. */
export function customSnoozeUntil(date: Date, now: Date): number | undefined {
  const until = seconds(date);
  return Number.isFinite(until) && until > seconds(now) ? until : undefined;
}
