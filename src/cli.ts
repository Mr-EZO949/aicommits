#!/usr/bin/env node
import "dotenv/config";

import { execSync } from "node:child_process";
import { groqProvider } from "./providers/groq.js";


const MAX_CHARS = 25_000;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const EXCLUDED_PREFIXES = ["dist/", "build/", "coverage/", "node_modules/"];

type StagedStatus = "A" | "M" | "D" | "R" | "C";
type StagedFile = { status: StagedStatus; path: string };

// Runs a shell command and returns stdout as a string.
// Throws if the command exits non-zero.
function run(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isGitRepo(): boolean {
  try {
    run("git rev-parse --is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

function getStagedNameStatus(): string {
  return run("git diff --staged --name-status");
}

function getStagedDiffUnified0(): string {
  return run("git diff --staged --unified=0");
}

function parseStagedNameStatus(rawNameStatus: string): StagedFile[] {
  const files: StagedFile[] = [];
  const lines = rawNameStatus.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    // Git usually uses tabs here; fall back to whitespace to stay resilient.
    const tabParts = line.split("\t");
    const statusToken = tabParts[0]?.trim();
    if (!statusToken) {
      continue;
    }

    const statusChar = statusToken.charAt(0);
    if (!statusChar) {
      continue;
    }
    const status = statusChar as StagedStatus;
    if (!["A", "M", "D", "R", "C"].includes(status)) {
      continue;
    }

    let path = "";
    if (tabParts.length >= 2) {
      // For rename/copy, use the destination path (last field).
      path = (tabParts[tabParts.length - 1] ?? "").trim();
    } else {
      const whitespaceParts = line.trim().split(/\s+/);
      path = whitespaceParts.slice(1).join(" ").trim();
    }

    if (!path) {
      continue;
    }

    files.push({ status, path });
  }

  return files;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isLockfile(path: string): boolean {
  return LOCKFILES.has(normalizePath(path));
}

function isExcludedFromLLM(path: string): boolean {
  const normalized = normalizePath(path);

  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  if (normalized === "node_modules" || normalized.includes("/node_modules/")) {
    return true;
  }

  if (normalized.endsWith(".map")) {
    return true;
  }

  if (normalized.includes(".min.")) {
    return true;
  }

  if (normalized === ".env") {
    return true;
  }

  if (isLockfile(normalized)) {
    return true;
  }

  return false;
}

function assertNoSecrets(rawDiff: string): void {
  // Very basic “obvious secret” patterns (MVP).
  // This is NOT perfect security—just a guardrail.
  const secretPatterns: Array<{ name: string; re: RegExp }> = [
    { name: "private key block", re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i },
    // Match env-style secret assignments (e.g. GROQ_API_KEY=..., export API_KEY=...)
    // and avoid false positives like `const apiKey = ...`.
    { name: "API key assignment", re: /\b(?:export\s+)?[A-Z0-9_]*API[_-]?KEY[A-Z0-9_]*\s*=\s*\S+/ },
    { name: "password assignment", re: /\bPASS(?:WORD)?\s*=/i },
    { name: "secret assignment", re: /\bSECRET\s*=/i },
    { name: "token assignment", re: /\bTOKEN\s*=/i },
    // common OpenAI-style key prefix (not guaranteed, but good guardrail)
    { name: "sk- token prefix", re: /\bsk-[A-Za-z0-9]{16,}/ },
  ];

  for (const p of secretPatterns) {
    if (p.re.test(rawDiff)) {
      // Block sending this to any LLM.
      throw new Error(
        `Possible sensitive data detected (${p.name}). Refusing to continue. ` +
          `Unstage/remove secrets and try again.`
      );
    }
  }
}

function collectNoiseWarnings(rawDiff: string): string[] {
  const warnings: string[] = [];

  // Optional “noise” warnings (we don't remove yet; just warn).
  const noisyPathHints: Array<{ label: string; re: RegExp }> = [
    { label: "node_modules/", re: /diff --git a\/(?:.+\/)?node_modules\// },
    { label: "dist/ or build output", re: /diff --git a\/(?:dist|build)\// },
    { label: "coverage/", re: /diff --git a\/coverage\// },
    { label: "lockfile", re: /diff --git a\/(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)/ },
    { label: ".env file", re: /diff --git a\/\.env(\.|$)/ },
  ];

  for (const n of noisyPathHints) {
    if (n.re.test(rawDiff)) {
      warnings.push(`⚠️ Diff includes ${n.label} (often noise). Consider unstaging if unintended.`);
    }
  }

  return warnings;
}

function truncateForLLM(text: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let output = text;
  if (output.length > MAX_CHARS) {
    warnings.push(
      `⚠️ Large payload (${output.length.toLocaleString()} chars). Using first ${MAX_CHARS.toLocaleString()} chars.`
    );
    output = output.slice(0, MAX_CHARS) + "\n\n…(truncated)\n";
  }

  return { text: output, warnings };
}

function filterDiffByExcludedFiles(diffUnified0: string): string {
  if (!diffUnified0.trim()) {
    return "";
  }

  const lines = diffUnified0.split("\n");
  const keptChunks: string[] = [];
  let currentChunk: string[] = [];
  let keepCurrentChunk = true;

  const flushChunk = () => {
    if (currentChunk.length > 0 && keepCurrentChunk) {
      keptChunks.push(currentChunk.join("\n"));
    }
    currentChunk = [];
    keepCurrentChunk = true;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushChunk();
      currentChunk.push(line);
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = match?.[2] ?? match?.[1] ?? "";
      keepCurrentChunk = path ? !isExcludedFromLLM(path) : true;
      continue;
    }
    currentChunk.push(line);
  }
  flushChunk();

  return keptChunks.join("\n").trim();
}

function buildLLMPayload(stagedFiles: StagedFile[], diffUnified0: string): string {
  const stagedLines = stagedFiles.map((file) => {
    const excludedSuffix = isExcludedFromLLM(file.path) ? " (excluded)" : "";
    return `${file.status} ${file.path}${excludedSuffix}`;
  });
  const filteredDiff = filterDiffByExcludedFiles(diffUnified0);

  return [
    "STAGED FILES:",
    ...stagedLines,
    "",
    "FILTERED DIFF:",
    filteredDiff || "(all staged file diffs excluded)",
  ].join("\n");
}

async function main() {
  if (!isGitRepo()) {
    console.error("❌ Not a git repository. Run this inside a repo.");
    process.exit(1);
  }

  const rawNameStatus = getStagedNameStatus();
  if (!rawNameStatus.trim()) {
    console.log("🟡 No staged changes. Run: git add <files>");
    process.exit(0);
  }
  const stagedFiles = parseStagedNameStatus(rawNameStatus);
  if (stagedFiles.length === 0) {
    console.log("🟡 No staged changes. Run: git add <files>");
    process.exit(0);
  }

  const rawDiffUnified0 = getStagedDiffUnified0();
  console.log(`ℹ️ Raw diff size (unified=0): ${rawDiffUnified0.length.toLocaleString()} chars`);

  try {
    assertNoSecrets(rawDiffUnified0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ ${msg}`);
    process.exit(1);
  }

  const includedFiles = stagedFiles.filter((f) => !isExcludedFromLLM(f.path));
  const hasLockfile = stagedFiles.some((f) => isLockfile(f.path));
  if (includedFiles.length === 0 && hasLockfile) {
    console.log("✅ Suggested commit message:");
    console.log("chore(deps): update lockfile");
    process.exit(0);
  }

  const llmPayload = buildLLMPayload(stagedFiles, rawDiffUnified0);
  const truncation = truncateForLLM(llmPayload);
  const warnings = [...collectNoiseWarnings(rawDiffUnified0), ...truncation.warnings];
  const truncatedPayload = truncation.text;

  for (const w of warnings) {
    console.log(w);
  }

  console.log(`ℹ️ Using payload size: ${truncatedPayload.length.toLocaleString()} chars\n`);

  try {
    const msg = await groqProvider.generateCommitMessage(truncatedPayload);
    console.log("✅ Suggested commit message:");
    console.log(msg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ ${msg}`);
  process.exit(1);
});
