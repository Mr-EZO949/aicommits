import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Runs a shell command and returns stdout as a string.
// Throws if the command exits non-zero.
export function run(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function isGitRepo(): boolean {
  try {
    run("git rev-parse --is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

export function getStagedNameStatus(): string {
  return run("git diff --staged --name-status");
}

export function getStagedDiffUnified0(): string {
  return run("git diff --staged --unified=0");
}

export function getRepoRulesPath(): string {
  return run("git rev-parse --git-path aicommits-rules").trim();
}

export function saveRepoRules(rulesText: string): string {
  const path = getRepoRulesPath();
  writeFileSync(path, `${rulesText.trim()}\n`, "utf8");
  return path;
}

export function loadRepoRules(): string | undefined {
  const path = getRepoRulesPath();
  if (!existsSync(path)) {
    return undefined;
  }
  const text = readFileSync(path, "utf8").trim();
  return text.length > 0 ? text : undefined;
}

export function getRecentCommitSubjects(limit: number): string[] {
  try {
    const raw = run(`git log -n ${limit} --pretty=%s`);
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Best-effort only (e.g., brand new repo with no commits).
    return [];
  }
}
