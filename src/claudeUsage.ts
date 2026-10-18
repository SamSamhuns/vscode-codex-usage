import * as fs from "fs";
import * as path from "path";
import {
  canReadClaudeUsage,
  ClaudeAuth,
  isClaudeAuthExpired,
  readClaudeAuth,
} from "./claudeAuth";
import { CLAUDE_USAGE_URL, ClaudeApiError, fetchClaudeUsage } from "./claudeApi";
import { RateLimits, RateLimitWindow, Snapshot } from "./types";

// Claude Code's usage endpoint is rate limited per account, and Claude Code's
// own `/usage` draws on the same allowance, so this asks it as rarely as it can:
//  - one fetch serves every VS Code window, through a small state file in the
//    extension's global storage that all windows read;
//  - only a focused window (or an explicit Refresh) goes to the network;
//  - an expired token is never sent (the endpoint answers those with a long 429);
//  - failures back off exponentially, and a 429 pauses even manual refreshes.

const STATE_VERSION = 1;
// Floor between two network attempts from any window, so rapid window switches
// or Refresh clicks can't burst the endpoint.
const MIN_ATTEMPT_SPACING_MS = 15_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const MAX_SERVER_PAUSE_MS = 6 * 60 * 60_000;
// How soon to look for a usable credential again: Claude Code renews an expired
// token by itself whenever it runs, while a missing login needs the user.
const AUTH_RECHECK_EXPIRED_MS = 60_000;
const AUTH_RECHECK_MISSING_MS = 5 * 60_000;

interface SharedState {
  v: number;
  // Last successful fetch (epoch ms) and its result.
  fetchedAt: number;
  rateLimits: RateLimits | null;
  // Last network attempt from any window, successful or not.
  attemptedAt: number;
  // Consecutive failures and the earliest time to try again.
  failures: number;
  retryAt: number;
  // The pause came from a 429, so even a manual refresh waits it out.
  rateLimited: boolean;
  error: string | null;
  // `expiresAt` of the login the failure happened with. A renewed login gets a
  // fresh start instead of inheriting its predecessor's backoff.
  failedLogin: number | null;
}

const EMPTY_STATE: SharedState = {
  v: STATE_VERSION,
  fetchedAt: 0,
  rateLimits: null,
  attemptedAt: 0,
  failures: 0,
  retryAt: 0,
  rateLimited: false,
  error: null,
  failedLogin: null,
};

export interface ClaudeRefreshOptions {
  // An explicit Refresh: skips the interval and focus checks, but still waits
  // out a 429.
  force: boolean;
  focused: boolean;
  intervalMs: number;
}

export interface ClaudeUsageResult {
  // False when there is no Claude Code login; the status bar item hides.
  loggedIn: boolean;
  snapshot: Snapshot | null;
  note?: string;
}

export interface ClaudeUsageDeps {
  readAuth?: () => Promise<ClaudeAuth | null>;
  fetchUsage?: (auth: ClaudeAuth) => Promise<RateLimits>;
  now?: () => number;
}

export class ClaudeUsageService {
  private readonly readAuth: () => Promise<ClaudeAuth | null>;
  private readonly fetchUsage: (auth: ClaudeAuth) => Promise<RateLimits>;
  private readonly now: () => number;

  private auth: ClaudeAuth | null = null;
  private authCheckedAt: number | null = null;
  // The endpoint rejected the cached token; read the credential again.
  private authStale = false;
  // Last state this window saw or wrote, in case the state file is unwritable.
  private lastState: SharedState | null = null;
  private inFlight: Promise<ClaudeUsageResult> | null = null;

  constructor(
    private readonly stateFile: string,
    deps: ClaudeUsageDeps = {},
  ) {
    this.readAuth = deps.readAuth ?? readClaudeAuth;
    this.fetchUsage = deps.fetchUsage ?? fetchClaudeUsage;
    this.now = deps.now ?? Date.now;
  }

  // Concurrent callers (timer, window focus, Refresh) share one pass.
  refresh(opts: ClaudeRefreshOptions): Promise<ClaudeUsageResult> {
    this.inFlight ??= this.run(opts).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(opts: ClaudeRefreshOptions): Promise<ClaudeUsageResult> {
    let state = this.readState();
    const now = this.now();

    // The credential (a Keychain read on macOS) is only needed when this pass
    // may go to the network, or once at startup to learn whether there is a
    // Claude Code login at all.
    const due = opts.force || (opts.focused && now - state.fetchedAt >= opts.intervalMs);
    if (due || this.authCheckedAt === null) {
      await this.loadAuth(now, opts.force);
    }
    const auth = this.auth;
    if (!auth) return { loggedIn: false, snapshot: null };

    let note: string | undefined;
    if (due) {
      if (isClaudeAuthExpired(auth, now)) {
        note = "Claude Code's login token has expired. Claude Code renews it the next time it runs.";
      } else if (!canReadClaudeUsage(auth)) {
        note =
          "This Claude Code login can't read plan usage (it lacks the user:profile scope). Run /login in Claude Code.";
      } else if (this.mayAttempt(state, auth, now, opts.force)) {
        state = await this.fetchAndStore(state, auth, opts.intervalMs);
      }
    }

    const at = this.now();
    note ??= failureNote(state, at);
    const snapshot: Snapshot | null = state.rateLimits
      ? {
          rateLimits: rollOverElapsedWindows(state.rateLimits, at),
          sourceFile: CLAUDE_USAGE_URL,
          capturedAt: new Date(state.fetchedAt),
          source: "api",
        }
      : null;
    if (note && snapshot) {
      note += ` Showing usage from ${snapshot.capturedAt.toLocaleString()}.`;
    }
    return { loggedIn: true, snapshot, note };
  }

  private async loadAuth(now: number, force: boolean): Promise<void> {
    const current = this.auth;
    if (current && !this.authStale && !isClaudeAuthExpired(current, now)) return;
    if (this.authCheckedAt !== null && !force) {
      const wait = current ? AUTH_RECHECK_EXPIRED_MS : AUTH_RECHECK_MISSING_MS;
      if (now - this.authCheckedAt < wait) return;
    }
    this.authCheckedAt = now;
    this.authStale = false;
    try {
      this.auth = await this.readAuth();
    } catch (err) {
      console.warn("[codex-usage] could not read the Claude Code login:", err);
      this.auth = null;
    }
  }

  private mayAttempt(state: SharedState, auth: ClaudeAuth, now: number, force: boolean): boolean {
    if (now - state.attemptedAt < MIN_ATTEMPT_SPACING_MS) return false;
    const paused = now < state.retryAt && state.failedLogin === auth.expiresAt;
    return !paused || (force && !state.rateLimited);
  }

  private async fetchAndStore(
    state: SharedState,
    auth: ClaudeAuth,
    intervalMs: number,
  ): Promise<SharedState> {
    // Claim the attempt first so other windows don't send the same request.
    this.writeState({ ...state, attemptedAt: this.now() });

    let next: SharedState;
    try {
      const rateLimits = await this.fetchUsage(auth);
      const at = this.now();
      next = { ...EMPTY_STATE, fetchedAt: at, attemptedAt: at, rateLimits };
    } catch (err) {
      const apiErr = err instanceof ClaudeApiError ? err : null;
      if (apiErr?.reason === "unauthorized") this.authStale = true;
      const failures = (state.failedLogin === auth.expiresAt ? state.failures : 0) + 1;
      const backoff = Math.min(intervalMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
      const serverPause = Math.min((apiErr?.retryAfterSeconds ?? 0) * 1000, MAX_SERVER_PAUSE_MS);
      const at = this.now();
      next = {
        ...state,
        attemptedAt: at,
        failures,
        retryAt: at + Math.max(backoff, serverPause),
        rateLimited: apiErr?.reason === "rate_limited",
        error: apiErr?.message ?? `Claude usage request failed: ${String(err)}`,
        failedLogin: auth.expiresAt,
      };
    }
    this.writeState(next);
    return next;
  }

  private readState(): SharedState {
    let fromFile: SharedState | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (parsed && parsed.v === STATE_VERSION) fromFile = { ...EMPTY_STATE, ...parsed };
    } catch {
      // Missing or unreadable: fall back to what this window last saw.
    }
    const mine = this.lastState;
    const latest = fromFile && (!mine || fromFile.attemptedAt >= mine.attemptedAt) ? fromFile : mine;
    return latest ? { ...latest } : { ...EMPTY_STATE };
  }

  private writeState(state: SharedState): void {
    this.lastState = state;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      // Write then rename, so other windows never read a half-written file.
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      console.warn("[codex-usage] could not save Claude usage state:", err);
    }
  }
}

function failureNote(state: SharedState, now: number): string | undefined {
  if (!state.error) return undefined;
  const retry =
    state.retryAt > now ? ` Next attempt after ${new Date(state.retryAt).toLocaleTimeString()}.` : "";
  return `${state.error}${retry}`;
}

// A window whose reset time has passed has rolled over, and nothing is used in
// the new one yet. Matters for old data, e.g. while the login token is expired
// because Claude Code hasn't run for a while.
function rollOverElapsedWindows(rateLimits: RateLimits, now: number): RateLimits {
  const nowSeconds = now / 1000;
  const roll = (w: RateLimitWindow | null | undefined) =>
    w && typeof w.resets_at === "number" && w.resets_at <= nowSeconds ? { ...w, used_percent: 0 } : w;
  return {
    ...rateLimits,
    primary: roll(rateLimits.primary),
    secondary: roll(rateLimits.secondary),
    additional_limits:
      rateLimits.additional_limits?.map((l) => ({
        ...l,
        primary: roll(l.primary),
        secondary: roll(l.secondary),
      })) ?? null,
  };
}
