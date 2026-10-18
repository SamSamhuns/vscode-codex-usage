import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The claude.ai login Claude Code stores after `/login` (CLI or the Claude Code
// VS Code extension). We only ever read it; we never refresh or rewrite it
// (refreshing rotates the refresh token, which would sign Claude Code out).
// An expired access token is left for Claude Code to renew the next time it runs.
export interface ClaudeAuth {
  accessToken: string;
  // Epoch milliseconds; null when the credential does not say.
  expiresAt: number | null;
  scopes: string[] | null;
  // Plan name (e.g. "max") and its tier (e.g. "default_claude_max_20x").
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

// macOS Keychain entry Claude Code uses for its default config directory.
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 5_000;

// The usage endpoint answers an expired token with a long 429 cooldown rather
// than a 401, so treat tokens as expired a little early and never send one.
const EXPIRY_SKEW_MS = 60_000;

// `CLAUDE_CONFIG_DIR` relocates Claude Code's config, including the
// `.credentials.json` login file used on Linux and Windows (and on macOS when
// the Keychain is unavailable).
function customConfigDir(): string | null {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!dir) return null;
  return dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

export function resolveClaudeConfigDir(): string {
  return customConfigDir() ?? path.join(os.homedir(), ".claude");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseCredentials(raw: string): ClaudeAuth | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const oauth = parsed?.claudeAiOauth;
  const accessToken = nonEmptyString(oauth?.accessToken);
  if (!accessToken) return null;

  return {
    accessToken,
    expiresAt:
      typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((s: unknown): s is string => typeof s === "string")
      : null,
    subscriptionType: nonEmptyString(oauth.subscriptionType),
    rateLimitTier: nonEmptyString(oauth.rateLimitTier),
  };
}

// `security -w` prints a secret that isn't plain text as hex.
function decodeKeychainSecret(secret: string): string {
  if (/^(?:[0-9a-f]{2})+$/i.test(secret)) {
    const decoded = Buffer.from(secret, "hex").toString("utf8");
    if (decoded.trimStart().startsWith("{")) return decoded;
  }
  return secret;
}

function readKeychainSecret(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const secret = err ? "" : stdout.trim();
        resolve(secret ? decodeKeychainSecret(secret) : null);
      },
    );
  });
}

// Returns the Claude Code login, or null when there is none (never logged in,
// logged out, or an API-key/third-party-provider setup with no claude.ai login).
export async function readClaudeAuth(): Promise<ClaudeAuth | null> {
  // With a custom CLAUDE_CONFIG_DIR, Claude Code keys its Keychain entry to that
  // directory, so the default entry may belong to a different login: only trust
  // the directory's own credentials file then.
  if (process.platform === "darwin" && !customConfigDir()) {
    const secret = await readKeychainSecret();
    const auth = secret ? parseCredentials(secret) : null;
    if (auth) return auth;
  }

  try {
    const file = path.join(resolveClaudeConfigDir(), ".credentials.json");
    return parseCredentials(await fs.promises.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export function isClaudeAuthExpired(auth: ClaudeAuth, now: number = Date.now()): boolean {
  return auth.expiresAt !== null && auth.expiresAt - EXPIRY_SKEW_MS <= now;
}

// Plan usage needs the `user:profile` scope. Long-lived `claude setup-token`
// tokens only carry `user:inference`, so they can't read it.
export function canReadClaudeUsage(auth: ClaudeAuth): boolean {
  return auth.scopes === null || auth.scopes.includes("user:profile");
}
