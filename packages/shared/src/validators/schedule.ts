import { z } from "zod";

// ── Cron Presets ──────────────────────────────────────────────

export const CRON_PRESETS = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 1",
  "every-6h": "0 */6 * * *",
  "every-12h": "0 */12 * * *",
} as const;

export type CronPresetKey = keyof typeof CRON_PRESETS;

// ── Cron Parser ───────────────────────────────────────────────

export interface CronParts {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dayOfMonth: readonly number[];
  readonly month: readonly number[];
  readonly dayOfWeek: readonly number[];
}

/**
 * Parses a single cron field into an array of matching values.
 * Supports: *, N, N-M, N/step, N-M/step, and comma-separated lists.
 */
function parseCronField(field: string, min: number, max: number): readonly number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // Handle step notation: */2, 1-5/2
    const [range, stepStr] = trimmed.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;

    if (isNaN(step) || step < 1) {
      throw new Error(`Invalid step value in '${trimmed}'`);
    }

    let start: number;
    let end: number;

    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [lo, hi] = range.split("-").map((s) => parseInt(s, 10));
      if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`Invalid range '${range}' (allowed: ${min}-${max})`);
      }
      start = lo;
      end = hi;
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Invalid value '${range}' (allowed: ${min}-${max})`);
      }
      if (step === 1) {
        values.add(val);
        continue;
      }
      start = val;
      end = max;
    }

    for (let i = start; i <= end; i += step) {
      values.add(i);
    }
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Parses a standard 5-field cron expression.
 * Format: minute hour dayOfMonth month dayOfWeek
 *
 * @throws {Error} if the expression is invalid
 */
export function parseCronExpression(expr: string): CronParts {
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, got ${fields.length}`);
  }

  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dayOfMonth: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12),
    dayOfWeek: parseCronField(fields[4], 0, 6),
  };
}

/**
 * Computes the next execution time for a cron expression after a given date.
 * Iterates minute-by-minute from `after` (max 366 days lookahead).
 */
/** True if `tz` is an IANA time zone this runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function utcWallClock(date: Date): WallClock {
  return {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    dayOfMonth: date.getUTCDate(),
    month: date.getUTCMonth() + 1, // JS months are 0-based
    dayOfWeek: date.getUTCDay(),
  };
}

function zonedWallClockReader(timeZone: string): (date: Date) => WallClock {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  });
  return (date) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((p) => [p.type, p.value]),
    );
    return {
      minute: Number(parts.minute),
      hour: Number(parts.hour),
      dayOfMonth: Number(parts.day),
      month: Number(parts.month),
      dayOfWeek: WEEKDAY_INDEX[parts.weekday] ?? 0,
    };
  };
}

/**
 * Next instant strictly after `after` whose wall-clock time in `timeZone`
 * (default UTC) matches the cron expression. Across DST transitions a skipped
 * local time never fires and a repeated local hour matches twice, like cron.
 */
export function getNextCronRun(
  expr: string,
  after: Date,
  timeZone: string = "UTC",
): Date {
  const parts = parseCronExpression(expr);
  const readClock =
    timeZone === "UTC" ? utcWallClock : zonedWallClockReader(timeZone);

  // Start from the next whole minute
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const maxIterations = 366 * 24 * 60; // 1 year of minutes
  for (let i = 0; i < maxIterations; i++) {
    const clock = readClock(candidate);

    if (
      parts.minute.includes(clock.minute) &&
      parts.hour.includes(clock.hour) &&
      parts.dayOfMonth.includes(clock.dayOfMonth) &&
      parts.month.includes(clock.month) &&
      parts.dayOfWeek.includes(clock.dayOfWeek)
    ) {
      return new Date(candidate);
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error("Could not find next run within 366 days");
}

/**
 * Returns a human-readable description of a cron expression.
 */
export function describeCron(expr: string): string {
  // Check presets first
  for (const [name, preset] of Object.entries(CRON_PRESETS)) {
    if (expr.trim() === preset) {
      switch (name) {
        case "hourly":
          return "Every hour at minute 0";
        case "daily":
          return "Every day at midnight UTC";
        case "weekly":
          return "Every Monday at midnight UTC";
        case "every-6h":
          return "Every 6 hours at minute 0";
        case "every-12h":
          return "Every 12 hours at minute 0";
      }
    }
  }

  try {
    const parts = parseCronExpression(expr);
    const minStr = parts.minute.length === 60 ? "*" : parts.minute.join(",");
    const hourStr = parts.hour.length === 24 ? "*" : parts.hour.join(",");
    return `At minute ${minStr}, hour ${hourStr} UTC`;
  } catch {
    return expr;
  }
}

// ── Zod Schemas ───────────────────────────────────────────────

const cronExpressionSchema = z
  .string()
  .trim()
  .min(9, "Cron expression is required")
  .max(100, "Cron expression too long")
  .refine(
    (val) => {
      try {
        parseCronExpression(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid cron expression" },
  );

export const CreateScheduleSchema = z.object({
  pipeline_definition_id: z.string().uuid("Invalid pipeline definition ID"),
  cron_expression: cronExpressionSchema,
  timezone: z
    .string()
    .max(50)
    .refine(isValidTimeZone, { message: "Unknown time zone" })
    .default("UTC"),
  git_branch: z.string().trim().max(255).optional().nullable(),
});

export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;

export const UpdateScheduleSchema = z.object({
  cron_expression: cronExpressionSchema.optional(),
  timezone: z
    .string()
    .max(50)
    .refine(isValidTimeZone, { message: "Unknown time zone" })
    .optional(),
  git_branch: z.string().trim().max(255).optional().nullable(),
});

export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;
