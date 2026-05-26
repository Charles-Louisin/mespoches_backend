/** Début du jour civil en UTC (00:00:00.000Z). */
export function getUtcDayStart(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Parse une date saisie (YYYY-MM-DD ou ISO) en jour UTC. */
export function parseToUtcDay(dateInput: string | Date): Date {
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    const [y, m, day] = dateInput.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day));
  }
  const d = new Date(dateInput);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function isFutureUtcDay(dateInput: string | Date): boolean {
  const day = parseToUtcDay(dateInput);
  return day.getTime() > getUtcDayStart().getTime();
}

export function isTodayUtcDay(dateInput: string | Date): boolean {
  const day = parseToUtcDay(dateInput);
  return day.getTime() === getUtcDayStart().getTime();
}

/** Jour UTC suivant. */
export function getNextUtcDay(day: Date): Date {
  const next = new Date(day);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
