// Minimal 5-field cron evaluator for the frontend.
// Mirrors the backend implementation in scheduling/Scheduler.ts.
// minute hour dom month dow

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const lo = rangeStr === '*' ? min : parseInt(rangeStr.split('-')[0], 10);
      const hi = rangeStr === '*' ? max : (rangeStr.includes('-') ? parseInt(rangeStr.split('-')[1], 10) : lo);
      for (let v = lo; v <= hi; v += step) {
        if (v === value) return true;
      }
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mField, hField, domField, monField, dowField] = parts;
  return (
    matchField(mField,   date.getMinutes(),     0, 59) &&
    matchField(hField,   date.getHours(),       0, 23) &&
    matchField(domField, date.getDate(),        1, 31) &&
    matchField(monField, date.getMonth() + 1,  1, 12) &&
    matchField(dowField, date.getDay(),         0,  6)
  );
}

export function computeNextRunTs(expr: string, after: Date = new Date()): Date | null {
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(after);
  limit.setFullYear(limit.getFullYear() + 1);

  while (cursor < limit) {
    if (cronMatches(expr, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function humanCron(expr: string): string {
  const presets: Record<string, string> = {
    '0 * * * *':   'Every hour',
    '0 9 * * *':   'Daily at 9:00 AM',
    '0 9 * * 1-5': 'Weekdays at 9:00 AM',
    '0 20 * * 0':  'Sundays at 8:00 PM',
    '0 9 1 * *':   'Monthly on the 1st',
  };
  return presets[expr.trim()] ?? expr;
}
