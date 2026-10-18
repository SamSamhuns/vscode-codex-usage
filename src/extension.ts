import * as path from "path";
import * as vscode from "vscode";
import { readLatestSnapshot } from "./codexReader";
import { CodexApiError, readApiSnapshot } from "./codexApi";
import { isLoggedIn } from "./codexAuth";
import { ClaudeUsageResult, ClaudeUsageService } from "./claudeUsage";
import {
  createMoreInformationItems,
  createUsageSummaryItems,
  isMoreInformationItem,
  STATUS_BAR_PRIORITY,
  StatusBar,
  StatusBarSide,
  UsageProvider,
} from "./statusBar";
import { setColorIndicators, setShowRemaining } from "./format";
import { Snapshot } from "./types";

type UsageSource = "auto" | "api" | "rollout";

const CODEX: UsageProvider = {
  id: "codexUsage.codex",
  title: "Codex Usage",
  name: "Codex",
  icon: "$(codex-logo)",
  showUsageCommand: "codexUsage.showUsage",
  moreInformationCommand: "codexUsage.showMoreInformation",
  emptyTooltip: "No Codex usage data. Start a Codex session or run 'codex login'.",
  accent: { background: "#9de5cf", foreground: "#1f2328" },
  includeAdditionalLimits: false,
};

const CLAUDE: UsageProvider = {
  id: "codexUsage.claude",
  title: "Claude Code Usage",
  name: "Claude",
  icon: "$(claude-logo)",
  showUsageCommand: "codexUsage.showClaudeUsage",
  moreInformationCommand: "codexUsage.showClaudeMoreInformation",
  emptyTooltip:
    "No Claude Code usage fetched yet. It is fetched while a VS Code window is focused.",
  accent: { background: "#f5c2ad", foreground: "#1f2328" },
  // Claude reports per-model weekly caps (e.g. Opus) as rows of their own, and
  // they can be the binding limit, so chart them with the 5h and weekly windows.
  includeAdditionalLimits: true,
};

// The Claude Code item sits immediately right of the Codex item.
const CLAUDE_PRIORITY = STATUS_BAR_PRIORITY - 0.01;
const MIN_CLAUDE_INTERVAL_SECONDS = 60;

let timer: NodeJS.Timeout | undefined;
let statusBar: StatusBar | undefined;
let claudeBar: StatusBar | undefined;
let claudeService: ClaudeUsageService | undefined;
let lastSnapshot: Snapshot | null = null;
let lastNote: string | undefined;
let lastClaude: ClaudeUsageResult | null = null;

function getConfig() {
  const c = vscode.workspace.getConfiguration("codexUsage");
  const source = c.get<string>("source", "auto");
  const side = c.get<string>("statusBarAlignment", "left");
  return {
    codexHome: c.get<string>("codexHome", ""),
    refreshIntervalSeconds: c.get<number>("refreshIntervalSeconds", 60),
    lookbackDays: c.get<number>("lookbackDays", 7),
    source: (["auto", "api", "rollout"].includes(source) ? source : "auto") as UsageSource,
    compact: c.get<boolean>("compactStatusBar", false),
    showRemaining: c.get<boolean>("showRemaining", false),
    colorIndicators: c.get<boolean>("colorIndicators", true),
    warningBackground: c.get<boolean>("warningBackground", false),
    statusBarAlignment: (side === "right" ? "right" : "left") as StatusBarSide,
    claudeEnabled: c.get<boolean>("claude.enabled", true),
    claudeRefreshIntervalSeconds: c.get<number>("claude.refreshIntervalSeconds", 300),
  };
}

type Config = ReturnType<typeof getConfig>;

async function readRollout(cfg: Config): Promise<Snapshot | null> {
  return readLatestSnapshot({
    codexHome: cfg.codexHome,
    lookbackDays: cfg.lookbackDays,
  });
}

// Resolve a snapshot according to the configured source. Online modes fall back
// to the local rollout files whenever the live query can't run (not logged in,
// expired token, offline), so the status bar keeps working.
async function resolveSnapshot(cfg: Config): Promise<{ snapshot: Snapshot | null; note?: string }> {
  const wantApi = cfg.source === "api" || (cfg.source === "auto" && isLoggedIn(cfg.codexHome));
  if (!wantApi) {
    return { snapshot: await readRollout(cfg) };
  }

  try {
    return { snapshot: await readApiSnapshot({ codexHome: cfg.codexHome }) };
  } catch (err) {
    const reason = err instanceof CodexApiError ? err.message : String(err);
    console.warn("[codex-usage] API query failed, falling back to rollout:", reason);
    const snapshot = await readRollout(cfg);
    const note = snapshot
      ? `Live query unavailable — showing latest rollout snapshot. ${reason}`
      : reason;
    return { snapshot, note };
  }
}

async function refreshCodex(cfg: Config) {
  if (!statusBar) return;
  statusBar.ensureAlignment(cfg.statusBarAlignment);
  try {
    const result = await resolveSnapshot(cfg);
    lastSnapshot = result.snapshot;
    lastNote = result.note;
  } catch (err) {
    lastSnapshot = null;
    lastNote = undefined;
    console.error("[codex-usage] read failed:", err);
  }
  statusBar.update(lastSnapshot, {
    compact: cfg.compact,
    note: lastNote,
    warningBackground: cfg.warningBackground,
  });
}

// Cheap on most ticks: the service re-reads the usage state shared by all
// windows and only goes to the network when that is stale and this window is
// focused (or the user asked for a refresh).
async function refreshClaude(cfg: Config = getConfig(), force = false) {
  if (!claudeBar || !claudeService) return;
  claudeBar.ensureAlignment(cfg.statusBarAlignment);
  if (!cfg.claudeEnabled) {
    lastClaude = null;
    claudeBar.hide();
    return;
  }

  try {
    lastClaude = await claudeService.refresh({
      force,
      focused: vscode.window.state.focused,
      intervalMs: Math.max(MIN_CLAUDE_INTERVAL_SECONDS, cfg.claudeRefreshIntervalSeconds) * 1000,
    });
  } catch (err) {
    console.error("[codex-usage] Claude usage read failed:", err);
  }

  if (!lastClaude?.loggedIn) {
    claudeBar.hide();
    return;
  }
  claudeBar.update(lastClaude.snapshot, {
    compact: cfg.compact,
    note: lastClaude.note,
    warningBackground: cfg.warningBackground,
  });
}

async function refresh(force = false) {
  const cfg = getConfig();
  setShowRemaining(cfg.showRemaining);
  setColorIndicators(cfg.colorIndicators);
  await Promise.all([refreshCodex(cfg), refreshClaude(cfg, force)]);
}

function restartTimer() {
  if (timer) clearInterval(timer);
  const cfg = getConfig();
  const intervalMs = Math.max(5, cfg.refreshIntervalSeconds) * 1000;
  timer = setInterval(() => void refresh(), intervalMs);
}

async function showUsage() {
  if (!lastSnapshot) {
    await vscode.window.showInformationMessage(
      "No Codex rollout files found. Start a Codex session to populate usage.",
    );
    return;
  }

  const selected = await vscode.window.showQuickPick(createUsageSummaryItems(lastSnapshot, CODEX), {
    title: "Codex Usage",
    placeHolder: "Current session and weekly rate limits",
  });
  if (isMoreInformationItem(selected)) {
    await showMoreInformation();
  }
}

async function showMoreInformation() {
  if (!lastSnapshot) {
    await vscode.window.showInformationMessage(
      "No Codex rollout files found. Start a Codex session to populate usage.",
    );
    return;
  }

  await vscode.window.showQuickPick(createMoreInformationItems(lastSnapshot, lastNote), {
    title: "Codex Usage - More Information",
    placeHolder: "Captured time, source file, and rate-limit windows",
  });
}

// Why there is no Claude Code usage to show.
function claudeUnavailableMessage(): string {
  if (!getConfig().claudeEnabled) {
    return "Claude Code usage is turned off (codexUsage.claude.enabled).";
  }
  if (lastClaude && !lastClaude.loggedIn) {
    return "No Claude Code login found. Sign in to Claude Code with a claude.ai Pro, Max, Team, or Enterprise plan.";
  }
  return (
    lastClaude?.note ??
    "Claude Code usage hasn't been fetched yet. It is fetched while a VS Code window is focused."
  );
}

async function showClaudeUsage() {
  const snapshot = lastClaude?.snapshot;
  if (!snapshot) {
    await vscode.window.showInformationMessage(claudeUnavailableMessage());
    return;
  }

  const selected = await vscode.window.showQuickPick(createUsageSummaryItems(snapshot, CLAUDE), {
    title: "Claude Code Usage",
    placeHolder: "Current session and weekly plan limits",
  });
  if (isMoreInformationItem(selected)) {
    await showClaudeMoreInformation();
  }
}

async function showClaudeMoreInformation() {
  const snapshot = lastClaude?.snapshot;
  if (!snapshot) {
    await vscode.window.showInformationMessage(claudeUnavailableMessage());
    return;
  }

  await vscode.window.showQuickPick(createMoreInformationItems(snapshot, lastClaude?.note), {
    title: "Claude Code Usage - More Information",
    placeHolder: "Captured time, source, plan, and limit windows",
  });
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = getConfig();
  statusBar = new StatusBar(CODEX, cfg.statusBarAlignment);
  claudeBar = new StatusBar(CLAUDE, cfg.statusBarAlignment, CLAUDE_PRIORITY);
  // Global storage is shared by every window, so one fetch serves them all.
  claudeService = new ClaudeUsageService(
    path.join(context.globalStorageUri.fsPath, "claude-usage.json"),
  );
  context.subscriptions.push(statusBar, claudeBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("codexUsage.refresh", () => refresh(true)),
    vscode.commands.registerCommand("codexUsage.showUsage", showUsage),
    vscode.commands.registerCommand("codexUsage.showDetails", showUsage),
    vscode.commands.registerCommand("codexUsage.showMoreInformation", showMoreInformation),
    vscode.commands.registerCommand("codexUsage.showClaudeUsage", showClaudeUsage),
    vscode.commands.registerCommand("codexUsage.showClaudeMoreInformation", showClaudeMoreInformation),
    vscode.commands.registerCommand("codexUsage.openSessionsFolder", async () => {
      const cfg = getConfig();
      const { resolveCodexHome } = await import("./codexReader");
      const home = resolveCodexHome(cfg.codexHome);
      const uri = vscode.Uri.file(`${home}/sessions`);
      await vscode.commands.executeCommand("revealFileInOS", uri);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("codexUsage")) return;
      restartTimer();
      void refresh();
    }),
    // Claude usage is only fetched by a focused window, so catch up as soon as
    // one gains focus instead of waiting for the next tick.
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void refreshClaude();
    }),
  );

  restartTimer();
  void refresh();
}

export function deactivate() {
  if (timer) clearInterval(timer);
  statusBar?.dispose();
  claudeBar?.dispose();
}
