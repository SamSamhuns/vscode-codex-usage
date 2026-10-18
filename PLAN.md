# vscode-codex-usage — Plan

A small VS Code extension that monitors OpenAI Codex CLI usage and surfaces
**current session (5h)** and **weekly** usage right inside the editor.

## Goals

- Show **current session usage** (Codex "primary" rate limit, ~5h window).
- Show **weekly usage** (Codex "secondary" rate limit, ~7d window).
- Stay out of the way: one status bar item with native hover/click details.
- Read-only: no network, no auth, no telemetry. Just parse local files.

Out of scope (for v1): per-model breakdown, cost tracking, historical
charts, multi-account, notifications/alerts.

## Claude Code usage (0.3.0)

Show Claude Code's **5-hour session** and **weekly** plan limits in a second
status bar item, immediately right of the Codex item (same alignment,
fractionally lower priority), with its own tooltip and menus.

- **Source:** `GET https://api.anthropic.com/api/oauth/usage` (the endpoint
  behind Claude Code's `/usage`) with the claude.ai OAuth token Claude Code
  stores in the macOS Keychain (`Claude Code-credentials`) or
  `~/.claude/.credentials.json`. Read-only; never refreshed. Rows of the
  `limits[]` array map by `kind`: `session` → primary (5h), `weekly_all` →
  secondary (weekly), anything else (e.g. `weekly_scoped` per-model caps) →
  `additional_limits`. Older flat `five_hour`/`seven_day` buckets are the
  fallback.
- **Why not a local source?** Claude Code documents no usage file, and its
  statusline `rate_limits` input only reaches a statusline command where one
  runs (the terminal CLI). The endpoint reports account-wide usage, covering the
  CLI, the Claude Code VS Code panel, claude.ai, and other devices alike.
- **Overhead budget:** the endpoint's rate limit is shared with Claude Code, so
  `ClaudeUsageService` shares one fetch across windows (state file in global
  storage), only fetches from a focused window and only when the shared data
  is older than `codexUsage.claude.refreshIntervalSeconds` (default 300s),
  never sends an expired token, backs off exponentially, and honours
  `Retry-After`/`429` for every window and manual refresh. The credential is
  cached in memory and only re-read when missing, expired, or rejected.

## Data source

Codex CLI writes rollout files at:

```
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

Each rollout is JSONL. The events we care about look like:

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "rate_limits": {
      "primary":   { "used_percent": 12.3, "window_minutes": 299,   "resets_in_seconds": 17940 },
      "secondary": { "used_percent": 22.0, "window_minutes": 10079, "resets_in_seconds": 351406 }
    }
  }
}
```

Strategy: walk `~/.codex/sessions/` back up to 7 days, find the most
recently modified `rollout-*.jsonl`, scan it from the end for the last
`token_count` event with a non-null `rate_limits`. That's the freshest
snapshot Codex has produced locally.

Edge cases to handle:
- `rate_limits` is sometimes `null` (e.g. exec mode) — skip and keep
  looking backwards.
- No rollout files yet → show "no data" state.
- `~/.codex` lives somewhere else → make the path configurable.

## UX

**Status bar (left)**, one item:

```
$(pulse) Codex 12% · 4h59m | Week 22% · 4d 2h
```

Color: none in the status bar by default (since 0.4.1). Per-window dots
(🟢 <50, 🟡 <75, 🟠 <90, 🔴 90+) via `codexUsage.colorIndicators` and the old
warning (`>= 75`) / error (`>= 90`) `backgroundColor` via
`codexUsage.warningBackground` are both opt-in. The hover and click menu are
always colour-coded.

Tooltip: current-session and weekly bars (light colours, by the same levels)
with a pastel `% used` badge and a `Resets in … · <date>` line. Extra metadata
stays behind a **More information** link.

Click → opens a native VS Code quick-pick style summary with both meters.
Selecting **More information** shows captured time, source file, and window
lengths without opening a webview.

## Commands

- `codexUsage.refresh` — re-scan and update.
- `codexUsage.showUsage` — show the native usage summary.
- `codexUsage.showMoreInformation` — show captured/source/window metadata.
- `codexUsage.openSessionsFolder` — reveal `~/.codex/sessions` in the OS.

## Settings (`contributes.configuration`)

- `codexUsage.codexHome` (string, default `""` → resolves to `~/.codex`).
- `codexUsage.refreshIntervalSeconds` (number, default `60`).
- `codexUsage.lookbackDays` (number, default `7`).

## Architecture

```
src/
  extension.ts        activate/deactivate, wires everything
  codexReader.ts      find latest rollout, parse last token_count
  codexAuth.ts        read ~/.codex/auth.json (online mode)
  codexApi.ts         live Codex usage endpoint (online mode)
  claudeAuth.ts       read Claude Code's claude.ai login (Keychain / file)
  claudeApi.ts        Claude usage endpoint + response normalisation
  claudeUsage.ts      cross-window cache, focus gating, backoff
  http.ts             shared read-only HTTPS GET
  statusBar.ts        one StatusBarItem per provider + native summary formatting
  format.ts           percent / duration helpers
  types.ts            RateLimits, Snapshot
```

`codexReader` exposes `readLatestSnapshot(opts): Promise<Snapshot | null>`.
It does NOT use `fs.watch` on JSONL (they grow fast and noisily); instead
the extension polls on `refreshIntervalSeconds`. Cheap because we only
read the tail of one file.

## Repo layout

```
package.json          extension manifest + contributes
tsconfig.json
.vscodeignore
src/...
README.md             usage, screenshots, limitations
PLAN.md               this file
```

Build: `tsc` to `out/`. No bundler needed for v1.

## Milestones

1. **Scaffold** — `package.json`, `tsconfig.json`, empty `extension.ts`,
   activates on startup.
2. **Reader** — `codexReader.ts` + a small unit-style smoke test driven
   by a fixture JSONL.
3. **Status bar** — wire reader → one combined status bar item with polling.
4. **Native details** — hover/click summary and More information metadata.
5. **Settings + commands** — configurable home dir, refresh, reveal.
6. **README** — install/run/limitations, note re: `null` rate_limits.

Commit the plan first, then land milestones 1–3 in this session.
