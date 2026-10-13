const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses YYYY-MM-DD into a Date at UTC midnight. */
export function parseIsoDate(value: string): Date {
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new RangeError(`Invalid date: ${value}`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`Invalid date: ${value}`);
  }
  return date;
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Number of nights between check-in and check-out (check-out day not counted). */
export function nightsBetween(checkIn: Date, checkOut: Date): number {
  const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);
  if (nights < 1) {
    throw new RangeError("checkOut must be after checkIn");
  }
  return nights;
}

/** Every calendar day from start to end, both included. */
export function eachDay(start: Date, end: Date): Date[] {
  if (end.getTime() < start.getTime()) {
    throw new RangeError("end must not be before start");
  }
  const days: Date[] = [];
  for (let day = start; day.getTime() < end.getTime(); day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

export interface DateRange {
  start: Date;
  end: Date;
}

/** True when two inclusive date ranges share at least one day. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start.getTime() <= b.end.getTime() && b.start.getTime() <= a.end.getTime();
}
