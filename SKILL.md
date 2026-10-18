---
name: vscode-codex-usage
description: Maintain the vscode-codex-usage VS Code extension. Use when changing the Codex or Claude Code usage status bar items, rollout JSONL parsing, the Codex/Claude usage endpoints, extension manifest, Marketplace packaging, README, or development workflow in this repository.
---

# vscode-codex-usage

## Purpose

This repo is a TypeScript VS Code extension that shows Codex CLI primary/session
and secondary/weekly usage in one VS Code status bar item, and Claude Code's
5-hour/weekly plan usage in a second item right next to it. Codex data comes
either from local rollout JSONL files in `~/.codex/sessions/` (offline) or from
a live query against the Codex usage endpoint using the logged-in credential
(online), selected via `codexUsage.source`. Claude Code data comes from
Anthropic's usage endpoint using Claude Code's stored claude.ai login.

## Current Shape

- `src/extension.ts`: activation, polling, command registration, quick-pick UI,
  source selection (`auto`/`api`/`rollout`) with rollout fallback, and the
  `CODEX`/`CLAUDE` provider descriptors.
- `src/statusBar.ts`: one `StatusBarItem` per `UsageProvider`, tooltip rendering,
  native usage and metadata item builders, compact/full text, source labeling,
  and left/right alignment (recreates the item since alignment is fixed at
  creation).
- `src/claudeAuth.ts`: reads Claude Code's claude.ai login from the macOS
  Keychain (`Claude Code-credentials`, via `/usr/bin/security`) or
  `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json`. Read-only; never refreshes.
- `src/claudeApi.ts`: GETs `api.anthropic.com/api/oauth/usage` and normalizes its
  `limits[]` rows (by `kind`) or legacy flat buckets into `RateLimits`. Throws
  `ClaudeApiError` (with `Retry-After`).
- `src/claudeUsage.ts`: `ClaudeUsageService`, the fetch policy (no `vscode`
  import, so it is unit-testable): cross-window state file in global storage,
  focused-window-only fetching, expired-token skip, exponential backoff, 429
  pause.
- `src/http.ts`: shared read-only HTTPS GET used by both live sources.
- `src/codexReader.ts`: resolves Codex home, finds recent rollout files, parses
  the latest usable `token_count.rate_limits`.
- `src/codexAuth.ts`: reads `~/.codex/auth.json` for the OAuth access token and
  ChatGPT account id (with JWT-claim fallback). Read-only; never refreshes.
- `src/codexApi.ts`: GETs `chatgpt.com/backend-api/wham/usage` and normalizes the
  (undocumented) response into `RateLimits`. Throws `CodexApiError`.
- `src/format.ts`: percent, duration, and reset-time helpers.
- `src/types.ts`: `RateLimitWindow`, `RateLimits`, `Snapshot`, `SnapshotSource`.
- `icons/codex-icon.woff`: contributed Codex-logo icon font (glyph U+E900) used as
  the status bar `$(codex-logo)` icon.
- `icons/claude-icon.woff`: contributed Claude-logo icon font (glyph U+E900, same
  1000-unit em box as the Codex font) used as the `$(claude-logo)` icon.
- `package.json`: VS Code extension manifest, `contributes.icons`, npm scripts.

## UI Constraints

- Keep one status bar item per provider (Codex, Claude Code), side by side: the
  Claude item uses a fractionally lower priority than the Codex item so it sits
  immediately to its right. Do not split a provider's session and weekly usage
  into separate items unless explicitly requested.
- Default (non-compact) status text stays:
  `$(codex-logo) Codex 🟢 5h <session percent> · <session reset>  🟡 Week <weekly percent> · <weekly reset>`
  (and the same shape with `$(claude-logo) Claude`). The dot before each
  window is graded by used percent (🟢 <50, 🟡 <75, 🟠 <90, 🔴 90+); with
  `codexUsage.colorIndicators` off, drop the dots and join segments with ` | `.
  When `codexUsage.compactStatusBar` is on, show only `<icon> <dot> <highest percent>`.
- Status bar items can only use the theme's warning/error backgrounds and one
  text colour, so colour per window comes from the emoji dots; keep the item's
  text colour at the theme default for contrast. The warning/error background
  is opt-in (`codexUsage.warningBackground`, default off) because a
  permanently red item is distracting; do not turn it back on by default.
- Claude per-model weekly caps (`additional_limits`) are charted in the Claude
  hover/menu and count toward its compact percent and optional background
  (`includeAdditionalLimits`); one joins the status text once it reaches 75%.
  Codex keeps them in More information only.
- Hover colours are light: pastel badges with dark (`#1f2328`) text and light
  bar fills. Keep new colours in that range.
- Claude usage must stay cheap for an endpoint whose rate limit is shared with
  Claude Code: keep fetching in `ClaudeUsageService` (shared state, focused
  window only, never an expired token, backoff, 429 pause). Do not add
  per-window or per-tick requests.
- Hover should stay lightweight and native: show only session and weekly usage
  bars plus reset dates, then a `More information` command link. It uses
  `supportHtml` only for coloured `<span>` badges (provider name, `% used`) and
  a muted reset line. VS Code keeps a span style only in the exact form
  `color:…;background-color:…;` (hex or `var(--vscode-…)`), so build styles via
  `badge()`/`muted()`, and pass every dynamic string through `escapeText()`.
  Badge text keeps at least 4.5:1 contrast on its background.
- The extension is displayed as **Codex & Claude Usage**, but its id
  (`samsamhuns.vscode-codex-usage`), command ids, and `codexUsage.*` setting
  keys stay as they are so installs upgrade in place and settings carry over.
- `images/icon.png` (256×256) shows the Codex knot (white) and Claude spark
  (terracotta) above a green and an amber usage meter, on black. It is drawn
  from the two icon fonts' glyphs.
- Click should use native VS Code UI such as `showQuickPick`, not a webview,
  unless the user explicitly asks for custom HTML.
- Extra metadata belongs behind `More information`: captured time, source file,
  and rate-limit window lengths.
- The leading status bar icon is the contributed Codex logo `$(codex-logo)`, backed
  by `icons/codex-icon.woff` (glyph U+E900) declared under `contributes.icons` in
  `package.json`. As a font glyph it is monochrome and inherits the status bar
  foreground colour, so it adapts to light and dark themes automatically — do
  not add separate light/dark image assets for the status bar.
- The font is self-generated from the Codex logo. If you replace or regenerate
  it, keep the glyph mapped to U+E900 (or update `fontCharacter` to match).
- Other in-menu icons use built-in Codicons in `$(name)` syntax (e.g. `$(pulse)`
  / `$(calendar)` to distinguish 5h vs weekly windows in the quick pick).

## Build And Test

Use the repo scripts:

```sh
npm install
npm run compile
```

For manual extension testing, open the repo in VS Code and press F5. The
`.vscode/launch.json` config starts an Extension Development Host and runs
`npm: compile` first.

Package locally with:

```sh
npx @vscode/vsce package
code --install-extension vscode-codex-usage-<version>.vsix
```

## Marketplace Notes

- Publish with `vsce`; `package.json` must have a unique lowercase `name`, a
  SemVer `version`, a `publisher`, `engines.vscode`, `main`, `categories`, and
  useful Marketplace metadata.
- Do not use SVG for the Marketplace icon. README/CHANGELOG images should be
  HTTPS and should avoid untrusted SVGs.
- A GitHub pipeline is optional. Local publishing with `vsce publish` is normal
  for small extensions. CI is useful once releases should be repeatable.
- If adding CI publishing, store the Marketplace/Azure DevOps token as
  `VSCE_PAT` in repository secrets and run `vsce publish` only from an explicit
  release/tag workflow.

## Change Guidance

- Prefer small, focused changes and run `npm run compile` before finishing.
- Keep `README.md` and `PLAN.md` aligned when user-facing behavior changes.
- Avoid adding runtime network calls beyond the two providers' own usage
  endpoints; the extension should remain read-only and telemetry-free, and must
  never refresh, rewrite, or persist either provider's credential.
- Treat `out/`, `node_modules/`, `.vscode-test/`, and `*.vsix` as generated.
