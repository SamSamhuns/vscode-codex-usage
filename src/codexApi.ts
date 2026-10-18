import { readCodexAuth } from "./codexAuth";
import { httpGetJson, HttpResponse } from "./http";
import {
  AdditionalRateLimitSnapshot,
  CreditsSnapshot,
  RateLimitResetCredits,
  RateLimits,
  RateLimitWindow,
  Snapshot,
  SpendControlLimitSnapshot,
} from "./types";

// Undocumented ChatGPT/Codex backend endpoint the Codex CLI itself uses to
// report `/status`. Read-only GET. May change without notice; we normalise the
// response defensively and fall back to rollout files when it does not fit.
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;

export interface ApiReaderOptions {
  codexHome?: string;
  timeoutMs?: number;
}

export type ApiFailureReason = "not_logged_in" | "unauthorized" | "network" | "no_data";

export class CodexApiError extends Error {
  constructor(
    public readonly reason: ApiFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "CodexApiError";
  }
}

/**
 * Query the live Codex usage endpoint with the logged-in credential.
 * Throws {@link CodexApiError} so callers can decide how to fall back.
 */
export async function readApiSnapshot(opts: ApiReaderOptions = {}): Promise<Snapshot> {
  const auth = readCodexAuth(opts.codexHome);
  if (!auth) {
    throw new CodexApiError("not_logged_in", "No Codex login found (auth.json missing or has no tokens).");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    "User-Agent": "vscode-codex-usage",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

  let res: HttpResponse;
  try {
    res = await httpGetJson(USAGE_URL, headers, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  } catch (err) {
    throw new CodexApiError("network", `Codex usage request failed: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new CodexApiError(
      "unauthorized",
      `Codex usage request was rejected (HTTP ${res.status}). The login token may have expired; run 'codex login'.`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CodexApiError("network", `Codex usage request returned HTTP ${res.status}.`);
  }

  let json: any;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new CodexApiError("no_data", "Codex usage response was not valid JSON.");
  }

  const rateLimits = normalizeRateLimits(json);
  if (!rateLimits) {
    throw new CodexApiError("no_data", "Codex usage response did not contain rate-limit data.");
  }

  return {
    rateLimits,
    sourceFile: USAGE_URL,
    capturedAt: new Date(),
    source: "api",
  };
}

// ---------------------------------------------------------------------------
// Response normalisation
//
// The endpoint is undocumented and its shape has drifted between Codex
// releases, so we accept several layouts and map them onto the same
// `RateLimits` contract the rollout reader already produces.
// ---------------------------------------------------------------------------

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function normalizeWindow(raw: any): RateLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;

  const usedPercent = firstNumber(raw.used_percent, raw.usedPercent, raw.pct, raw.percent);
  if (usedPercent === undefined) return null;

  let windowMinutes = firstNumber(raw.window_minutes, raw.windowMinutes, raw.limit_window_minutes);
  const windowSeconds = firstNumber(raw.window_seconds, raw.limit_window_seconds, raw.windowSeconds);
  if (windowMinutes === undefined && windowSeconds !== undefined) {
    windowMinutes = windowSeconds / 60;
  }

  const resetsAt = firstNumber(raw.resets_at, raw.resetsAt, raw.reset_at, raw.resetAt);
  const resetsInSeconds = firstNumber(
    raw.resets_in_seconds,
    raw.resetsInSeconds,
    raw.reset_after_seconds,
    raw.resetAfterSeconds,
  );

  const window: RateLimitWindow = { used_percent: usedPercent };
  if (windowMinutes !== undefined) window.window_minutes = windowMinutes;
  if (resetsAt !== undefined) window.resets_at = resetsAt;
  if (resetsInSeconds !== undefined) window.resets_in_seconds = resetsInSeconds;
  return window;
}

function normalizeCredits(raw: any): CreditsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const hasCredits =
    typeof raw.has_credits === "boolean"
      ? raw.has_credits
      : typeof raw.hasCredits === "boolean"
        ? raw.hasCredits
        : undefined;
  const unlimited =
    typeof raw.unlimited === "boolean" ? raw.unlimited : undefined;
  const balance = firstString(raw.balance, raw.balance_display, raw.remaining);
  if (hasCredits === undefined && unlimited === undefined && balance === null) {
    return null;
  }
  const overageLimitReached =
    typeof raw.overage_limit_reached === "boolean"
      ? raw.overage_limit_reached
      : typeof raw.overageLimitReached === "boolean"
        ? raw.overageLimitReached
        : null;
  return {
    has_credits: hasCredits ?? balance !== null,
    unlimited: unlimited ?? false,
    balance,
    overage_limit_reached: overageLimitReached,
  };
}

// Credits that buy an early reset of a rate-limit window. The endpoint reports
// both how many the account holds and how many apply to the current windows.
function normalizeResetCredits(raw: any): RateLimitResetCredits | null {
  if (!raw || typeof raw !== "object") return null;
  const available = firstNumber(raw.available_count, raw.availableCount);
  if (available === undefined) return null;
  const applicable = firstNumber(raw.applicable_available_count, raw.applicableAvailableCount);
  return {
    available_count: available,
    applicable_available_count: applicable ?? null,
  };
}

function normalizeIndividualLimit(raw: any): SpendControlLimitSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const limit = firstString(raw.limit, raw.limit_display);
  const used = firstString(raw.used, raw.used_display);
  const remaining = firstNumber(raw.remaining_percent, raw.remainingPercent);
  const resetsAt = firstNumber(raw.resets_at, raw.resetsAt, raw.reset_at, raw.resetAt);
  if (limit === null || used === null || remaining === undefined || resetsAt === undefined) {
    return null;
  }
  return { limit, used, remaining_percent: remaining, resets_at: resetsAt };
}

// Some plans report additional, per-feature rate limits alongside the main
// "codex" one (a top-level `additional_rate_limits` array, each entry shaped
// like `{ limit_name, metered_feature, rate_limit: { primary_window,
// secondary_window } }`). Only the live usage endpoint sends these; rollout
// files only ever carry the single main snapshot.
function normalizeAdditionalRateLimits(raw: unknown): AdditionalRateLimitSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: AdditionalRateLimitSnapshot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const limitName = firstString(entry.limit_name, entry.limitName);
    // A limit with windows but no `metered_feature` is still worth showing, so
    // only require the name and default the feature label to empty.
    if (limitName === null) continue;
    const meteredFeature = firstString(entry.metered_feature, entry.meteredFeature) ?? "";
    const limit = normalizeNamedRateLimit(entry.rate_limit ?? entry.rateLimit ?? entry, limitName, meteredFeature);
    if (limit) out.push(limit);
  }
  return out;
}

// Builds one named per-feature limit from a rate-limit container. Accepts both
// the `{ primary_window, secondary_window }` container the endpoint uses and a
// bare window object, so an unexpected shape is skipped rather than mis-read.
function normalizeNamedRateLimit(
  raw: any,
  limitName: string,
  meteredFeature: string,
): AdditionalRateLimitSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const primary = normalizeWindow(raw.primary ?? raw.primary_window ?? raw.primaryWindow ?? raw);
  const secondary = normalizeWindow(raw.secondary ?? raw.secondary_window ?? raw.secondaryWindow);
  if (!primary && !secondary) return null;
  return { limit_name: limitName, metered_feature: meteredFeature, primary, secondary };
}

// `rate_limit_reached_type` comes back as an object (`{ "type": "..." }`) from
// the live usage endpoint, but as a plain string from the rollout-derived
// shape. Accept both.
function normalizeRateLimitReachedType(raw: unknown): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return firstString(obj.type, obj.kind);
  }
  return null;
}

function normalizeRateLimits(json: any): RateLimits | null {
  // The rate-limit block can live at a few different paths depending on the
  // Codex release. Probe the known containers in order of likelihood.
  const container =
    json?.rate_limits ??
    json?.rateLimits ??
    json?.rate_limit ??
    json?.usage?.rate_limits ??
    json;

  if (!container || typeof container !== "object") return null;

  const primary = normalizeWindow(
    container.primary ?? container.primary_window ?? container.primaryWindow,
  );
  const secondary = normalizeWindow(
    container.secondary ?? container.secondary_window ?? container.secondaryWindow,
  );
  const credits = normalizeCredits(container.credits ?? json?.credits);

  // The live usage endpoint reports spend-control state in a top-level
  // `spend_control` object (a sibling of `rate_limit`, not nested inside it):
  // `{ reached, individual_limit }`. Older/alternate shapes may still put
  // these directly on the rate-limit container, so keep that as a fallback.
  const spendControl = json?.spend_control ?? container.spend_control ?? null;
  const individualLimit = normalizeIndividualLimit(
    spendControl?.individual_limit ?? container.individual_limit ?? container.individualLimit,
  );

  if (!primary && !secondary && !credits) return null;

  const planType = firstString(
    container.plan_type,
    container.planType,
    json?.plan_type,
    json?.plan?.name,
    json?.plan,
  );

  const spendControlReached =
    typeof spendControl?.reached === "boolean"
      ? spendControl.reached
      : typeof container.spend_control_reached === "boolean"
        ? container.spend_control_reached
        : null;

  // Likewise, `rate_limit_reached_type` is a top-level sibling of
  // `rate_limit`, not nested inside it.
  const rateLimitReachedType = normalizeRateLimitReachedType(
    json?.rate_limit_reached_type ??
      json?.rateLimitReachedType ??
      container.rate_limit_reached_type ??
      container.rateLimitReachedType,
  );

  // `code_review_rate_limit` is a dedicated sibling of `rate_limit` for the
  // code-review feature. It carries no name of its own, so label it here and
  // list it alongside the `additional_rate_limits` entries.
  const additionalLimits = normalizeAdditionalRateLimits(
    json?.additional_rate_limits ?? json?.additionalRateLimits,
  );
  const codeReviewLimit = normalizeNamedRateLimit(
    json?.code_review_rate_limit ?? json?.codeReviewRateLimit,
    "Code review",
    "code_review",
  );
  if (codeReviewLimit) additionalLimits.push(codeReviewLimit);

  return {
    primary,
    secondary,
    credits,
    plan_type: planType,
    limit_id: firstString(container.limit_id, container.limitId),
    limit_name: firstString(container.limit_name, container.limitName),
    normal_model_slug: firstString(
      container.normal_model_slug,
      container.normalModelSlug,
      json?.normal_model_slug,
      json?.normalModelSlug,
    ),
    individual_limit: individualLimit,
    spend_control_reached: spendControlReached,
    rate_limit_reached_type: rateLimitReachedType,
    additional_limits: additionalLimits.length > 0 ? additionalLimits : null,
    limit_reached: typeof container.limit_reached === "boolean" ? container.limit_reached : null,
    rate_limit_reset_credits: normalizeResetCredits(
      json?.rate_limit_reset_credits ?? json?.rateLimitResetCredits,
    ),
  };
}
