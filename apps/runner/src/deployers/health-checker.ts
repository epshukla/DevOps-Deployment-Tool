// ── Types ───────────────────────────────────────────────────────

export interface HealthCheckResult {
  readonly passed: boolean;
  readonly statusCode: number | null;
  readonly responseTimeMs: number;
  readonly error?: string;
}

export interface WaitForHealthyOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly intervalMs: number;
  readonly startPeriodMs?: number;
}

// ── Single Health Check ─────────────────────────────────────────

export async function checkHealth(
  url: string,
  timeoutMs: number,
): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      const responseTimeMs = Date.now() - start;
      const passed = response.status >= 200 && response.status < 400;

      return {
        passed,
        statusCode: response.status,
        responseTimeMs,
        error: passed ? undefined : `HTTP ${response.status}`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const message =
      err instanceof Error ? err.message : String(err);

    return {
      passed: false,
      statusCode: null,
      responseTimeMs,
      error: message,
    };
  }
}

// ── Wait for Healthy (Retry Loop) ───────────────────────────────

export async function waitForHealthy(
  options: WaitForHealthyOptions,
): Promise<HealthCheckResult> {
  const { url, timeoutMs, retries, intervalMs, startPeriodMs = 0 } = options;

  // Wait for start period before first check
  if (startPeriodMs > 0) {
    await sleep(startPeriodMs);
  }

  let lastResult: HealthCheckResult = {
    passed: false,
    statusCode: null,
    responseTimeMs: 0,
    error: "No checks performed",
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    lastResult = await checkHealth(url, timeoutMs);

    if (lastResult.passed) {
      return lastResult;
    }

    // Don't sleep after last attempt
    if (attempt < retries - 1) {
      await sleep(intervalMs);
    }
  }

  return {
    ...lastResult,
    error: `Failed after ${retries} attempts. Last error: ${lastResult.error}`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
