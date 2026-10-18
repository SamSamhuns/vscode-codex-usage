import { RateLimitWindow } from "./types";

let showRemaining = false;

// When enabled, percentages are shown as "left" (100% -> 0%, like the Codex
// CLI) instead of "used". Colours/warnings always follow the used percent.
export function setShowRemaining(value: boolean) {
  showRemaining = value;
}

export function displayPercent(usedPercent: number): number {
  return showRemaining ? 100 - usedPercent : usedPercent;
}

export function formatPercent(usedPercent: number, withDescription: boolean = true): string {
  const p = Number.isFinite(usedPercent) ? displayPercent(usedPercent) : usedPercent;
  return `${Math.round(p)}%${withDescription ? (showRemaining ? " remaining" : " used") : ""}`;
}

let colorIndicators = false;

// When enabled, each window in the status bar text gets a coloured dot
// (🟢 🟡 🟠 🔴) graded by its used percent. Off by default: an always-visible
// dot is distracting, and the hover and usage menu are colour-coded anyway.
export function setColorIndicators(value: boolean) {
  colorIndicators = value;
}

export function colorIndicatorsEnabled(): boolean {
  return colorIndicators;
}

// "Sat, Oct 18, 2:10 PM": quicker to scan than a full toLocaleString().
export function formatResetMoment(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "unknown";
  if (totalSeconds <= 0) return "0m";
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetTime(secondsFromNow: number, now: Date = new Date()): string {
  if (!Number.isFinite(secondsFromNow) || !Number.isFinite(now.getTime())) return "unknown";
  const reset = new Date(now.getTime() + secondsFromNow * 1000);
  if (!Number.isFinite(reset.getTime())) return "unknown";
  return reset.toLocaleString();
}

export type WindowSlot = "primary" | "secondary";

const MINUTES_5H = 5 * 60;
const MINUTES_DAY = 24 * 60;
const MINUTES_WEEK = 7 * MINUTES_DAY;
const MINUTES_MONTH = 30 * MINUTES_DAY;
const MINUTES_YEAR = 365 * MINUTES_DAY;

function isApproximateWindow(minutes: number, expected: number): boolean {
  return minutes >= expected * 0.95 && minutes <= expected * 1.05;
}

// Mirrors Codex CLI's own labeling: windows are identified by their length,
// not by whether they arrive in the primary or secondary slot. The server
// only sends the windows that apply to the account, so the primary slot can
// hold a weekly (or monthly) window when no 5h limit is reported.
export function windowShortLabel(window: RateLimitWindow, slot: WindowSlot): string {
  const minutes = window.window_minutes;
  if (typeof minutes === "number" && Number.isFinite(minutes)) {
    const m = Math.max(0, minutes);
    if (isApproximateWindow(m, MINUTES_5H)) return "5h";
    if (isApproximateWindow(m, MINUTES_DAY)) return "Day";
    if (isApproximateWindow(m, MINUTES_WEEK)) return "Week";
    if (isApproximateWindow(m, MINUTES_MONTH)) return "Month";
    if (isApproximateWindow(m, MINUTES_YEAR)) return "Year";
  }
  return slot === "secondary" ? "Secondary" : "Usage";
}

export function windowLongLabel(window: RateLimitWindow, slot: WindowSlot): string {
  const short = windowShortLabel(window, slot);
  switch (short) {
    case "5h":
      return "5h limit";
    case "Day":
      return "Daily limit";
    case "Week":
      return "Weekly limit";
    case "Month":
      return "Monthly limit";
    case "Year":
      return "Annual limit";
    case "Secondary":
      return "Secondary limit";
    default:
      return "Usage limit";
  }
}

export interface ResetDisplay {
  secondsRemaining: number;
  resetAt: Date;
}

export function getResetDisplay(
  window: RateLimitWindow,
  capturedAt: Date,
  now: Date = new Date(),
): ResetDisplay | null {
  let resetAt: Date | null = null;

  if (typeof window.resets_at === "number" && Number.isFinite(window.resets_at)) {
    resetAt = new Date(window.resets_at * 1000);
  } else if (
    typeof window.resets_in_seconds === "number" &&
    Number.isFinite(window.resets_in_seconds) &&
    Number.isFinite(capturedAt.getTime())
  ) {
    resetAt = new Date(capturedAt.getTime() + window.resets_in_seconds * 1000);
  }

  if (!resetAt || !Number.isFinite(resetAt.getTime()) || !Number.isFinite(now.getTime())) {
    return null;
  }

  return {
    secondsRemaining: Math.max(0, Math.floor((resetAt.getTime() - now.getTime()) / 1000)),
    resetAt,
  };
}
