/**
 * Turn the way people name a stretch of time ("yesterday", "last week", "in March",
 * "3 weeks ago", "2026-10-14") into a [from, to) range in local time. The memory tools take
 * these words from the model, which is more reliable for a small local model than working out
 * ISO timestamps itself. Weeks start on Monday.
 */

export interface Period {
  from: Date;
  to: Date;
}

const DAY_MS = 86_400_000;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const UNITS: Record<string, 'day' | 'week' | 'month' | 'year'> = {
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  fortnight: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, few: 3,
};

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

function monthRange(year: number, month: number): Period {
  return { from: new Date(year, month, 1), to: new Date(year, month + 1, 1) };
}

function unitRange(unit: 'day' | 'week' | 'month' | 'year', anchor: Date): Period {
  switch (unit) {
    case 'day':
      return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
    case 'week': {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 7) };
    }
    case 'month':
      return monthRange(anchor.getFullYear(), anchor.getMonth());
    case 'year':
      return { from: new Date(anchor.getFullYear(), 0, 1), to: new Date(anchor.getFullYear() + 1, 0, 1) };
  }
}

function shift(unit: 'day' | 'week' | 'month' | 'year', anchor: Date, count: number): Date {
  switch (unit) {
    case 'day':
      return addDays(anchor, count);
    case 'week':
      return addDays(anchor, 7 * count);
    case 'month':
      return new Date(anchor.getFullYear(), anchor.getMonth() + count, Math.min(anchor.getDate(), 28));
    case 'year':
      return new Date(anchor.getFullYear() + count, anchor.getMonth(), Math.min(anchor.getDate(), 28));
  }
}

function parseNumber(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

function parseDate(text: string): Period | null {
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    const from = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(from.getTime()) ? null : { from, to: addDays(from, 1) };
  }
  match = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (match) return monthRange(Number(match[1]), Number(match[2]) - 1);
  match = /^(\d{4})$/.exec(text);
  if (match) return unitRange('year', new Date(Number(match[1]), 0, 1));
  return null;
}

export function parsePeriod(input: string, now: Date = new Date()): Period | null {
  const text = input.trim().toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').replace(/^(in|on|during|from|over) /, '').trim();
  if (!text) return null;

  const range = /^(.+?) (?:to|until|through|\.\.|-) (.+)$/.exec(text) ?? /^(\S+)\.\.(\S+)$/.exec(text);
  if (range) {
    const start = parsePeriod(range[1], now);
    const end = parsePeriod(range[2], now);
    if (start && end && end.to > start.from) return { from: start.from, to: end.to };
  }

  const exact = parseDate(text);
  if (exact) return exact;

  if (text === 'today') return unitRange('day', now);
  if (text === 'yesterday') return unitRange('day', addDays(now, -1));
  if (text === 'recently' || text === 'lately') return { from: addDays(startOfDay(now), -14), to: addDays(startOfDay(now), 1) };

  let match = /^(this|last|previous|past) (day|week|fortnight|month|year)$/.exec(text);
  if (match) {
    const unit = UNITS[match[2]];
    if (match[2] === 'fortnight') {
      const from = addDays(startOfWeek(now), match[1] === 'this' ? -7 : -14);
      return { from, to: addDays(from, 14) };
    }
    return unitRange(unit, match[1] === 'this' ? now : shift(unit, now, -1));
  }

  // "the last 3 days", "past two weeks": a rolling window up to now.
  match = /^(?:the )?(?:last|past) (\S+) (days?|weeks?|months?|years?)$/.exec(text);
  if (match) {
    const count = parseNumber(match[1]);
    if (count !== null) {
      const unit = UNITS[match[2]];
      return { from: startOfDay(shift(unit, now, -count)), to: addDays(startOfDay(now), 1) };
    }
  }

  // "3 weeks ago", "a couple of months ago": that whole day, week or month.
  match = /^(?:about |around )?(?:a )?(\S+)(?: of)? (days?|weeks?|months?|years?) ago$/.exec(text);
  if (match) {
    const count = parseNumber(match[1]);
    if (count !== null) {
      const unit = UNITS[match[2]];
      return unitRange(unit, shift(unit, now, -count));
    }
  }

  // "march", "march 2025", "last march": the most recent one that has started.
  match = /^(?:last )?([a-z]+)(?: (\d{4}))?$/.exec(text);
  if (match) {
    const word = match[1];
    const month = MONTHS.findIndex((name) => name === word || name.slice(0, 3) === word);
    if (month >= 0) {
      if (match[2]) return monthRange(Number(match[2]), month);
      const before = month > now.getMonth() || (text.startsWith('last ') && month === now.getMonth());
      return monthRange(now.getFullYear() - (before ? 1 : 0), month);
    }
    // "tuesday", "last tuesday": the most recent one before today.
    const weekday = WEEKDAYS.findIndex((name) => name === word || name.slice(0, 3) === word);
    if (weekday >= 0 && !match[2]) {
      const back = (now.getDay() - weekday + 7) % 7 || 7;
      return unitRange('day', addDays(now, -back));
    }
  }

  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) {
    const day = new Date(parsed);
    return unitRange('day', day);
  }
  return null;
}

/** "today", "yesterday", "3 days ago", "2 weeks ago", "4 months ago", "a year ago". */
export function describeAgo(when: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(when).getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}
