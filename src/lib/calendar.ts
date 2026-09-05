import { type Job, type Run, occurrencesBetween } from './jobs.ts';

export interface CalendarEntry {
  readonly at: Date;
  readonly job: Job;
  /** Present when the occurrence already fired and produced a run. */
  readonly run?: Run;
}

export interface CalendarDay {
  readonly date: Date;
  readonly iso: string;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly entries: readonly CalendarEntry[];
}

export interface CalendarMonth {
  readonly year: number;
  readonly month: number; // 1-12
  readonly title: string;
  readonly weeks: readonly (readonly CalendarDay[])[];
  readonly previous: { readonly year: number; readonly month: number };
  readonly next: { readonly year: number; readonly month: number };
}

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Compute the grid (Monday-first, 6 rows max) for a month with job occurrences and past runs placed by local day. */
export const buildMonth = (year: number, month: number, jobs: readonly Job[], runs: readonly Run[], today = new Date()): CalendarMonth => {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const startOffset = (first.getDay() + 6) % 7; // Monday = 0
  const gridStart = new Date(year, month - 1, 1 - startOffset);
  const daysInGrid = Math.ceil((startOffset + last.getDate()) / 7) * 7;
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + daysInGrid);

  const runsByJobAndDay = new Map<string, Run[]>();
  for (const run of runs) {
    const key = `${run.jobId}|${isoDate(new Date(run.firedAt))}`;
    runsByJobAndDay.set(key, [...(runsByJobAndDay.get(key) ?? []), run]);
  }

  const entriesByDay = new Map<string, CalendarEntry[]>();
  const push = (day: string, entry: CalendarEntry): void => {
    entriesByDay.set(day, [...(entriesByDay.get(day) ?? []), entry]);
  };
  for (const job of jobs) {
    if (!job.enabled) continue;
    for (const at of occurrencesBetween(job.schedule, gridStart, gridEnd)) {
      const day = isoDate(at);
      const key = `${job.id}|${day}`;
      const matching = runsByJobAndDay.get(key) ?? [];
      // Pair each occurrence with the closest run on that day, if it already fired.
      const run = at <= today ? matching.shift() : undefined;
      push(day, { at, job, run });
    }
  }
  // Manual runs and runs whose schedule has since changed still show up.
  const jobsById = new Map(jobs.map((j) => [j.id, j] as const));
  for (const [key, leftovers] of runsByJobAndDay) {
    const [jobId, day] = key.split('|');
    const job = jobsById.get(jobId);
    if (!job) continue;
    for (const run of leftovers) push(day, { at: new Date(run.firedAt), job, run });
  }

  const todayIso = isoDate(today);
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < daysInGrid; i += 1) {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const iso = isoDate(date);
    const day: CalendarDay = {
      date,
      iso,
      inMonth: date.getMonth() === month - 1,
      isToday: iso === todayIso,
      entries: (entriesByDay.get(iso) ?? []).sort((a, b) => a.at.getTime() - b.at.getTime()),
    };
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push(day);
  }

  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return { year, month, title: first.toLocaleString('en-US', { month: 'long', year: 'numeric' }), weeks, previous, next };
};
