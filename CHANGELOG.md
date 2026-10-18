# Changelog

## 0.3.0

- Add **Claude Code usage** side by side with Codex. A second status bar
  item, right next to the Codex one, shows Claude Code's 5-hour session and
  weekly plan limits (and per-model weekly caps such as Opus, when the plan
  has them), with the same hover bars, usage menu, More information view,
  compact chip, remaining-percent mode, alignment, and warning colours.
  - Data comes from `https://api.anthropic.com/api/oauth/usage`, the endpoint
    behind Claude Code's `/usage`, using the claude.ai login Claude Code
    already stores (macOS Keychain `Claude Code-credentials`, or
    `~/.claude/.credentials.json`). Read-only: the login is never refreshed or
    rewritten. Both the current `limits[]` response and the older flat
    `five_hour`/`seven_day` fields are understood.
  - That endpoint's rate limit is shared with Claude Code itself, so one
    fetch is shared by all VS Code windows, only a focused window fetches (at
    most every 5 minutes by default), expired tokens are never sent, failures
    back off exponentially, and a `429` pauses every window (manual refreshes
    included) for as long as the server asks.
  - The item appears only when Claude Code is signed in with a claude.ai plan.
    More information also shows the plan (e.g. "Max 20x") and extra-usage spend.
- Add the `codexUsage.claude.enabled` and
  `codexUsage.claude.refreshIntervalSeconds` settings, and the
  **Show Claude Code Usage** / **Show Claude Code More Information** commands.
  **Refresh** now refreshes both providers.
- Give each status bar item its own id, so either one can be hidden from the
  status bar's context menu.
- The empty-state tooltip now includes the reason when there is one.
- Publish this fork as `samsamhuns.vscode-codex-usage` from
  SamSamhuns/vscode-codex-usage. Uninstall the original
  `ganymede404.vscode-codex-usage` before installing it, since both register
  the same commands and settings.

## 0.2.4

- Add `codexUsage.showRemaining` setting to show remaining usage
  ("% remaining", counting down from 100% or "% used" counting up from 0%)
  like the Codex CLI instead of used usage (#14).

## 0.2.3

- Decode `normal_model_slug`, a field Codex added to the rollout `token_count`
  event's `rate_limits` payload (`RateLimitSnapshot` in `codex-rs/protocol`)
  to support the "Luna Reserve" fallback quota: when ordinary usage is
  exhausted and the CLI falls back to a reserve budget, this names the model
  the reserve budget is tied to. The extension didn't parse this field at
  all, so it was silently dropped; it now shows as "Reserve for" in
  `More information` when present. Rollout-file snapshots are the primary
  source (the live `wham/usage` endpoint's checked-in OpenAPI models don't
  carry this field yet), but the live-API normalizer now probes for it too,
  consistent with this extension's existing defensive parsing.

## 0.2.2

- Fix **rollout-file** reading (`codexUsage.source: "rollout"`/`auto` fallback)
  silently losing history: Codex now compresses local rollout files older than
  about a week in place, renaming `rollout-*.jsonl` to `rollout-*.jsonl.zst`
  (zstd). The extension only matched the plain `.jsonl` suffix, so once a
  file was compressed it dropped out of the lookback scan entirely — on a
  machine that hadn't opened Codex recently this could mean "no data" instead
  of the last known usage. Rollout discovery now also matches `.jsonl.zst`
  files and transparently decompresses them on Node/Electron builds new
  enough to support it (falling back to skipping just that file, as before,
  on older runtimes).
- Decode the **live-API** usage fields the extension was silently dropping. The
  `chatgpt.com/backend-api/wham/usage` response carries several fields the
  extension never parsed; all of them now appear in `More information`:
  - `additional_rate_limits` — separate metered-feature budgets (their own
    `limit_name`, primary/secondary windows) reported alongside the main "codex"
    limit, each now listed as its own row.
  - `code_review_rate_limit` — the dedicated code-review limit, listed the same
    way under "Code review".
  - `rate_limit_reset_credits` — credits that buy an early reset of a window,
    shown as "Limit reset credits" with how many apply to the current windows.
  - `credits.overage_limit_reached` — noted on the "Credits" row.
  - `rate_limit.limit_reached` — shown as a "Rate limit reached" warning
    (previously only the spend-control equivalent was surfaced).

  These are all live-API-only: rollout files only ever record the single main
  snapshot, so the offline source is unaffected (and its schema is unchanged).

## 0.2.1

- Fix the **live API** source (`codexUsage.source: "api"`/`auto`) dropping
  spend-control data: the `chatgpt.com/backend-api/wham/usage` response nests
  `individual_limit` and `reached` inside a top-level `spend_control` object
  (a sibling of `rate_limit`, not a child of it), and `rate_limit_reached_type`
  is an object (`{ "type": "..." }`) rather than a plain string. The extension
  was only looking inside the `rate_limit` container and expecting a string,
  so the "Spend limit" row and "Spend control reached" warning in
  `More information` never appeared for API-sourced snapshots even when the
  account had hit them. Rollout-file snapshots were unaffected.
- Update README with screenshots for the full and compact status bar views
  and added screenshots for the "More information" view.

## 0.2.0

- Add an **online mode** that queries the live Codex usage endpoint
  (`chatgpt.com/backend-api/wham/usage`) with the credential already stored in
  `~/.codex/auth.json`, instead of reading local rollout files. The access
  token and ChatGPT account id are read from the logged-in session; nothing is
  refreshed or written back.
- Add the `codexUsage.source` setting to choose the data source:
  - `auto` (default) — query the API when logged in, otherwise use rollout
    files.
  - `api` — always query the API.
  - `rollout` — always read local rollout files (offline, previous behaviour).
  Online modes fall back to the latest rollout snapshot whenever the live query
  can't run (not logged in, expired token, offline), and the reason is shown in
  the tooltip and `More information` view.
- Add the `codexUsage.compactStatusBar` setting for a compact status bar chip
  (icon + single highest-used percent) as an alternative to the full
  per-window breakdown.
- Use the Codex logo as the status bar icon (contributed icon font,
  `icons/codex-icon.woff`) in both compact and non-compact views. As a
  monochrome glyph it inherits the status bar colour, so it adapts to light and
  dark themes automatically.
- Add the `codexUsage.statusBarAlignment` setting to place the usage item on
  the left or right side of the status bar.
- Show the active source (Live API vs rollout file) in the tooltip and
  `More information` view.

## 0.1.2

- Read the newest `rate_limits` fields Codex reports: a per-account
  `individual_limit` spend-control snapshot, `spend_control_reached`, and
  `rate_limit_reached_type`. Surface them in the `More information` view when
  present.

## 0.1.1

- Support the current Codex CLI rate-limit schema: `resets_at` Unix timestamps
  (replacing `resets_in_seconds`) and optional `window_minutes`. Legacy
  rollouts keep working.
- Label rate-limit windows by their actual length (`5h`, `Day`, `Week`,
  `Month`) instead of assuming primary = current session (5h) and
  secondary = weekly, matching Codex's own `/status` behavior. Accounts that
  only report a weekly window no longer see it mislabeled as the session
  limit next to an empty "Week —" slot.
- Hide windows Codex does not report instead of showing empty placeholders.
- Read the new snapshot fields Codex now reports: `plan_type`, `credits`, and
  `limit_name`/`limit_id`.
- Show plan and credits in the `More information` view when present.
- Keep snapshots that report only credits (no rate-limit windows) instead of
  skipping them.
- Show "Unknown" instead of a broken window length when Codex omits
  `window_minutes`.

## 0.1.0

- Prepare the first public release version.
- Add GitHub Actions release workflow that packages the extension, creates a version tag, and publishes a GitHub Release with the VSIX artifact.
- Keep release notes sourced from the matching changelog section.
- Change usage bar colors to warning yellow at 75% and error red at 90%.

## 0.0.2

- Add Marketplace icon metadata and optimized PNG icon.
- Add MIT license text.

## 0.0.1

- Initial Codex usage status bar extension.
- Read local Codex CLI rollout files from `~/.codex/sessions/`.
- Show current-session and weekly usage in a single VS Code status bar item.
- Show native hover and click summaries with usage bars and reset dates.
- Provide extra captured/source/window metadata behind `More information`.
