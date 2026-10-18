export interface RateLimitWindow {
  used_percent: number;
  // Optional in current Codex releases; older releases always set it.
  window_minutes?: number | null;
  // Legacy field from older Codex releases (relative to capture time).
  resets_in_seconds?: number;
  // Current Codex releases: absolute Unix timestamp in seconds.
  resets_at?: number | null;
}

export interface CreditsSnapshot {
  has_credits: boolean;
  unlimited: boolean;
  balance?: string | null;
  // Live API only: the account has hit its overage (pay-as-you-go) ceiling.
  overage_limit_reached?: boolean | null;
}

// Live API only: credits that can be spent to reset a rate-limit window early.
// `applicable_available_count` is how many apply to the current windows.
export interface RateLimitResetCredits {
  available_count: number;
  applicable_available_count?: number | null;
}

// A separate spend-control limit some plans report alongside the primary/
// secondary rate-limit windows (e.g. a workspace budget).
export interface SpendControlLimitSnapshot {
  limit: string;
  used: string;
  remaining_percent: number;
  resets_at: number;
}

// A per-feature rate limit reported alongside the main "codex" one (e.g. a
// metered feature with its own 5h/weekly budget). Only sent by the live API;
// rollout files only ever carry the single main snapshot.
export interface AdditionalRateLimitSnapshot {
  limit_name: string;
  metered_feature: string;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

// Claude Code only: pay-as-you-go spend once plan limits run out. Amounts are
// in minor units of `currency` (cents for USD), as the usage endpoint sends them.
export interface ExtraUsageSnapshot {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface RateLimits {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: CreditsSnapshot | null;
  extra_usage?: ExtraUsageSnapshot | null;
  plan_type?: string | null;
  limit_id?: string | null;
  limit_name?: string | null;
  // Set when this snapshot is a quota alias (e.g. the "Luna Reserve" fallback
  // budget offered once ordinary usage is exhausted): the model the alias's
  // budget is tied to, never a replacement for the request model itself.
  normal_model_slug?: string | null;
  individual_limit?: SpendControlLimitSnapshot | null;
  spend_control_reached?: boolean | null;
  // e.g. "rate_limit_reached", "workspace_owner_credits_depleted", ...
  rate_limit_reached_type?: string | null;
  additional_limits?: AdditionalRateLimitSnapshot[] | null;
  // Live API only: the main rate limit is currently exhausted.
  limit_reached?: boolean | null;
  rate_limit_reset_credits?: RateLimitResetCredits | null;
}

// Where a snapshot came from: the local rollout JSONL files (offline) or a
// live query against the provider's backend using the logged-in credential.
export type SnapshotSource = "rollout" | "api";

export interface Snapshot {
  rateLimits: RateLimits;
  // Human-readable origin of the snapshot. For rollout snapshots this is the
  // JSONL path; for API snapshots it is the endpoint URL.
  sourceFile: string;
  capturedAt: Date;
  // Distinguishes an offline rollout read from a live API query so the UI can
  // label the source and pick the right fallback behaviour.
  source: SnapshotSource;
}
