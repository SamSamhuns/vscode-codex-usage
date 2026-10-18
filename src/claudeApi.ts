import { ClaudeAuth } from "./claudeAuth";
import { httpGetJson, HttpResponse } from "./http";
import {
  AdditionalRateLimitSnapshot,
  ExtraUsageSnapshot,
  RateLimits,
  RateLimitWindow,
} from "./types";

// Undocumented endpoint behind Claude Code's `/usage` (claude.ai plan limits).
// Read-only GET. Its rate limit is strict and shared with Claude Code itself,
// so nothing here retries: ClaudeUsageService decides when it may be called.
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 10_000;

const MINUTES_5H = 5 * 60;
const MINUTES_DAY = 24 * 60;
const MINUTES_WEEK = 7 * MINUTES_DAY;

export type ClaudeApiFailureReason = "unauthorized" | "rate_limited" | "network" | "no_data";

export class ClaudeApiError extends Error {
  constructor(
    public readonly reason: ClaudeApiFailureReason,
    message: string,
    // Server-requested wait before the next attempt, when it sent one.
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClaudeApiError";
  }
}

/**
 * Query Claude Code's plan usage with the logged-in claude.ai credential.
 * Throws {@link ClaudeApiError} so the caller can decide how to back off.
 */
export async function fetchClaudeUsage(
  auth: ClaudeAuth,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<RateLimits> {
  let res: HttpResponse;
  try {
    res = await httpGetJson(
      CLAUDE_USAGE_URL,
      {
        Authorization: `Bearer ${auth.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
        "User-Agent": "vscode-codex-usage",
      },
      timeoutMs,
    );
  } catch (err) {
    throw new ClaudeApiError("network", `Claude usage request failed: ${(err as Error).message}`);
  }

  const rateLimits = parseClaudeUsageResponse(res);
  rateLimits.plan_type = formatPlan(auth.subscriptionType, auth.rateLimitTier);
  return rateLimits;
}

export function parseClaudeUsageResponse(res: HttpResponse, now: number = Date.now()): RateLimits {
  const retryAfter = parseRetryAfter(res.headers["retry-after"], now);
  if (res.status === 429) {
    throw new ClaudeApiError(
      "rate_limited",
      "Claude usage endpoint is rate limiting requests (HTTP 429).",
      retryAfter,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ClaudeApiError(
      "unauthorized",
      `Claude usage request was rejected (HTTP ${res.status}). Open Claude Code to refresh its login, or run /login.`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ClaudeApiError("network", `Claude usage request returned HTTP ${res.status}.`, retryAfter);
  }

  let json: any;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new ClaudeApiError("no_data", "Claude usage response was not valid JSON.");
  }

  // Errors can also arrive in-band, in a 200 body: `{ "error": { "type": ... } }`.
  if (json && typeof json === "object" && json.error) {
    const type = nonEmptyString(json.error?.type) ?? nonEmptyString(json.error);
    if (type === "rate_limit_error") {
      throw new ClaudeApiError(
        "rate_limited",
        "Claude usage endpoint is rate limiting requests.",
        retryAfter,
      );
    }
    throw new ClaudeApiError("no_data", `Claude usage response reported an error${type ? `: ${type}` : ""}.`);
  }

  const rateLimits = normalizeClaudeUsage(json);
  if (!rateLimits) {
    throw new ClaudeApiError(
      "no_data",
      "Claude usage response had no plan limits. They apply to claude.ai Pro, Max, Team, and Enterprise logins.",
    );
  }
  return rateLimits;
}

// `Retry-After` is either delta-seconds or an HTTP-date. A value of 0, which
// this endpoint has been seen sending with persistent 429s, counts as absent.
export function parseRetryAfter(
  value: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : undefined;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? seconds : undefined;
}

// ---------------------------------------------------------------------------
// Response normalisation
//
// Current servers send self-describing `limits[]` rows, e.g.
//   { kind: "session" | "weekly_all" | "weekly_scoped", group: "session" | "weekly",
//     percent: 0-100, resets_at: ISO 8601 | null,
//     scope: { model: { display_name } } | null, severity, is_active }
// Rows are classified by `kind`, never by a label. Older servers only send flat
// `five_hour` / `seven_day` buckets of `{ utilization, resets_at }`, which
// current servers still mirror for the two headline windows.
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toEpochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  return undefined;
}

function makeWindow(
  usedPercent: unknown,
  resetsAt: unknown,
  windowMinutes: number | undefined,
): RateLimitWindow | null {
  const used = finiteNumber(usedPercent);
  if (used === null) return null;
  const window: RateLimitWindow = { used_percent: used };
  if (windowMinutes !== undefined) window.window_minutes = windowMinutes;
  const reset = toEpochSeconds(resetsAt);
  if (reset !== undefined) window.resets_at = reset;
  return window;
}

// Rows carry no duration, so derive the window length from how the server
// classifies them; the session window is Claude's rolling 5 hours.
function rowWindowMinutes(kind: string, group: string): number | undefined {
  if (kind === "session" || group === "session") return MINUTES_5H;
  if (kind.startsWith("weekly") || group === "weekly") return MINUTES_WEEK;
  if (kind.startsWith("daily") || group === "daily") return MINUTES_DAY;
  return undefined;
}

function humanize(id: string): string {
  const words = id.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "Opus weekly" for a model-scoped weekly row; the humanized kind otherwise.
function rowLabel(row: any, kind: string, group: string): string {
  const scope =
    nonEmptyString(row.scope?.model?.display_name) ?? nonEmptyString(row.scope?.surface?.display_name);
  if (!scope) return humanize(kind || group || "limit");
  const period = group || kind.split("_")[0];
  return period ? `${scope} ${period}` : scope;
}

function flatWindow(raw: any, windowMinutes: number): RateLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  return makeWindow(raw.utilization, raw.resets_at, windowMinutes);
}

function normalizeExtraUsage(raw: any): ExtraUsageSnapshot | null {
  if (!raw || typeof raw !== "object" || typeof raw.is_enabled !== "boolean") return null;
  return {
    is_enabled: raw.is_enabled,
    monthly_limit: finiteNumber(raw.monthly_limit),
    used_credits: finiteNumber(raw.used_credits),
    utilization: finiteNumber(raw.utilization),
    currency: nonEmptyString(raw.currency),
  };
}

export function normalizeClaudeUsage(json: any): RateLimits | null {
  if (!json || typeof json !== "object") return null;

  let primary: RateLimitWindow | null = null;
  let secondary: RateLimitWindow | null = null;
  const additional: AdditionalRateLimitSnapshot[] = [];

  const rows: unknown[] | null = Array.isArray(json.limits) ? json.limits : null;
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    const r = row as any;
    const kind = nonEmptyString(r.kind) ?? "";
    const group = nonEmptyString(r.group) ?? "";
    const window = makeWindow(r.percent, r.resets_at, rowWindowMinutes(kind, group));
    if (!window) continue;
    if (kind === "session" && !primary) {
      primary = window;
    } else if (kind === "weekly_all" && !secondary) {
      secondary = window;
    } else {
      additional.push({
        limit_name: rowLabel(r, kind, group),
        metered_feature: kind,
        primary: window,
        secondary: null,
      });
    }
  }

  primary ??= flatWindow(json.five_hour, MINUTES_5H);
  secondary ??= flatWindow(json.seven_day, MINUTES_WEEK);
  if (!rows) {
    // Per-model weekly caps before `limits[]` existed.
    for (const [key, label] of [
      ["seven_day_opus", "Opus weekly"],
      ["seven_day_sonnet", "Sonnet weekly"],
    ] as const) {
      const window = flatWindow(json[key], MINUTES_WEEK);
      if (window) {
        additional.push({ limit_name: label, metered_feature: key, primary: window, secondary: null });
      }
    }
  }

  if (!primary && !secondary && additional.length === 0) return null;

  return {
    primary,
    secondary,
    additional_limits: additional.length > 0 ? additional : null,
    extra_usage: normalizeExtraUsage(json.extra_usage),
  };
}

// "max" + "default_claude_max_20x" -> "Max 20x".
function formatPlan(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  if (!subscriptionType) return null;
  const name = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const multiplier = rateLimitTier?.match(/_(\d+x)$/)?.[1];
  return multiplier ? `${name} ${multiplier}` : name;
}
