#!/usr/bin/env node
import "dotenv/config";

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseCommitMessage } from "./cli/commitMessage.js";
import {
  generateDistinctRegeneratedMessage,
  generateValidatedMessage,
} from "./cli/generation.js";
import {
  getRecentCommitSubjects,
  getStagedDiffUnified0,
  getStagedNameStatus,
  isGitRepo,
  loadRepoRules,
  saveRepoRules,
} from "./cli/git.js";
import { parseCliOptions, printHelp, type CliOptions } from "./cli/options.js";
import {
  buildLLMPayload,
  collectNoiseWarnings,
  isExcludedFromLLM,
  isLockfile,
  parseStagedNameStatus,
  printAIInputSummary,
  truncateForLLM,
  type FilteringOptions,
} from "./cli/payload.js";

const MAX_REGENERATIONS = 3;
const STYLE_HISTORY_LIMIT = 20;

type SecretExposure = { name: string; file: string; line: number; preview: string };
function getCliVersion(): string {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const packageJsonRaw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(packageJsonRaw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "private key block", re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i },
  { name: "API key assignment", re: /\b(?:export\s+)?[A-Z0-9_]*API[_-]?KEY[A-Z0-9_]*\s*=\s*\S+/ },
  { name: "password assignment", re: /\bPASS(?:WORD)?\s*=/i },
  { name: "secret assignment", re: /\bSECRET\s*=/i },
  { name: "token assignment", re: /\bTOKEN\s*=/i },
  { name: "sk- token prefix", re: /\bsk-[A-Za-z0-9]{16,}/ },
];

function detectSecretsInLine(lineContent: string): string[] {
  const matches: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(lineContent)) {
      matches.push(pattern.name);
    }
  }
  return matches;
}

function summarizePreview(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function findSecretExposuresInDiff(rawDiff: string): SecretExposure[] {
  const exposures: SecretExposure[] = [];
  const lines = rawDiff.split(/\r?\n/);

  let currentFile = "(unknown)";
  let inHunk = false;
  let newLine = 0;

  for (const rawLine of lines) {
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice("+++ b/".length).trim() || "(unknown)";
      continue;
    }

    if (rawLine.startsWith("@@")) {
      const match = rawLine.match(/\+(\d+)(?:,\d+)?/);
      newLine = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const content = rawLine.slice(1);
      const detected = detectSecretsInLine(content);
      for (const name of detected) {
        exposures.push({
          name,
          file: currentFile,
          line: newLine,
          preview: summarizePreview(content),
        });
      }
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith(" ") || rawLine === "") {
      newLine += 1;
      continue;
    }
  }

  return exposures;
}

function findSecretExposuresInText(input: string, label: string): SecretExposure[] {
  const exposures: SecretExposure[] = [];
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineContent = lines[i] ?? "";
    const detected = detectSecretsInLine(lineContent);
    for (const name of detected) {
      exposures.push({
        name,
        file: label,
        line: i + 1,
        preview: summarizePreview(lineContent),
      });
    }
  }
  return exposures;
}

function getMostFrequent(counts: Map<string, number>): { value: string; count: number } | null {
  let bestValue = "";
  let bestCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  if (!bestValue) {
    return null;
  }
  return { value: bestValue, count: bestCount };
}

function getLetterCase(text: string): "lower" | "upper" | "none" {
  const firstLetter = text.match(/[A-Za-z]/)?.[0] ?? "";
  if (!firstLetter) {
    return "none";
  }
  return firstLetter === firstLetter.toLowerCase() ? "lower" : "upper";
}

function inferRepoStyleInstructions(subjects: string[]): string | undefined {
  if (subjects.length === 0) {
    return undefined;
  }

  const typeCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();
  let parsedCount = 0;
  let lowerCaseSubjects = 0;
  let upperCaseSubjects = 0;
  let ticketPrefixCount = 0;
  let ticketPrefixSample = "";

  for (const subject of subjects) {
    const parsed = parseCommitMessage(subject);
    const subjectText = parsed?.subject ?? subject;
    const letterCase = getLetterCase(subjectText);
    if (letterCase === "lower") {
      lowerCaseSubjects += 1;
    } else if (letterCase === "upper") {
      upperCaseSubjects += 1;
    }

    const ticketMatch = subjectText.match(/^(?:\[[A-Z]+-\d+\]|[A-Z]+-\d+)[:\s-]?/);
    if (ticketMatch) {
      ticketPrefixCount += 1;
      if (!ticketPrefixSample) {
        ticketPrefixSample = ticketMatch[0].trim();
      }
    }

    if (!parsed) {
      continue;
    }
    parsedCount += 1;
    typeCounts.set(parsed.type, (typeCounts.get(parsed.type) ?? 0) + 1);
    if (parsed.scope) {
      scopeCounts.set(parsed.scope, (scopeCounts.get(parsed.scope) ?? 0) + 1);
    }
  }

  const hints: string[] = [];
  const dominantType = getMostFrequent(typeCounts);
  if (dominantType && parsedCount > 0 && dominantType.count / parsedCount >= 0.35) {
    hints.push(`Prefer type \`${dominantType.value}\` when it accurately matches the staged change.`);
  }

  const dominantScope = getMostFrequent(scopeCounts);
  if (dominantScope && parsedCount > 0 && dominantScope.count / parsedCount >= 0.25) {
    hints.push(`Preferred scope is often \`${dominantScope.value}\`; use it when relevant.`);
  }

  if (subjects.length > 0 && lowerCaseSubjects / subjects.length >= 0.7) {
    hints.push("Start subject text with lowercase (repo convention).");
  } else if (subjects.length > 0 && upperCaseSubjects / subjects.length >= 0.7) {
    hints.push("Start subject text with uppercase (repo convention).");
  }

  if (subjects.length > 0 && ticketPrefixCount / subjects.length >= 0.25) {
    const sample = ticketPrefixSample || "ABC-123";
    hints.push(`When applicable, keep ticket-prefix style in subject (e.g. \`${sample}\`).`);
  }

  if (hints.length === 0) {
    return undefined;
  }

  return [
    `Repository style hints inferred from last ${subjects.length} commit subjects:`,
    ...hints.map((hint) => `- ${hint}`),
  ].join("\n");
}

function buildEffectiveCustomInstructions(
  styleInstructions?: string,
  repoRules?: string,
  userCustomInstructions?: string
): string | undefined {
  const sections: string[] = [];
  if (styleInstructions) {
    sections.push(styleInstructions);
  }
  if (repoRules) {
    sections.push(`Repository saved rules:\n${repoRules}`);
  }
  if (userCustomInstructions) {
    sections.push(`One-time user preferences:\n${userCustomInstructions}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function assertNoSecrets(input: string, source: "diff" | "text", label = "input"): void {
  const exposures = source === "diff"
    ? findSecretExposuresInDiff(input)
    : findSecretExposuresInText(input, label);

  if (exposures.length > 0) {
    const maxItems = Math.min(5, exposures.length);
    const formatted = exposures
      .slice(0, maxItems)
      .map((item) => `${item.name} at ${item.file}:${item.line} [${item.preview}]`)
      .join("; ");
    const suffix = exposures.length > maxItems ? `; +${exposures.length - maxItems} more` : "";
    throw new Error(
      `Possible sensitive data detected. ${formatted}${suffix}. ` +
      "Refusing to continue. Unstage/remove secrets and try again."
    );
  }
}

function copyToClipboard(text: string): void {
  const attempts: Array<{ cmd: string; args: string[] }> = [];

  if (process.platform === "darwin") {
    attempts.push({ cmd: "pbcopy", args: [] });
  } else if (process.platform === "win32") {
    attempts.push({ cmd: "clip", args: [] });
  } else {
    attempts.push({ cmd: "wl-copy", args: [] });
    attempts.push({ cmd: "xclip", args: ["-selection", "clipboard"] });
    attempts.push({ cmd: "xsel", args: ["--clipboard", "--input"] });
  }

  let lastError = "no clipboard command available";
  for (const attempt of attempts) {
    const result = spawnSync(attempt.cmd, attempt.args, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (!result.error && (result.status ?? 1) === 0) {
      return;
    }
    lastError = result.error?.message || result.stderr || `exit code ${result.status ?? 1}`;
  }

  throw new Error(`Failed to copy to clipboard (${lastError.trim()}).`);
}

type CommitAction = "yes" | "no" | "regenerate";

async function promptForCommitAction(message: string, allowRegenerate: boolean): Promise<CommitAction> {
  console.log("✅ Proposed commit message:");
  console.log(message);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let settled = false;
    const answer = await new Promise<string>((resolve) => {
      const settle = (value: string) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      rl.on("SIGINT", () => settle(""));
      rl.on("close", () => settle(""));

      const prompt = allowRegenerate
        ? "\nCommit with this message? [y]es / [n]o / [r]egenerate: "
        : "\nCommit with this message? (y/N): ";

      rl.question(prompt)
        .then((value) => settle(value))
        .catch(() => settle(""));
    });

    const normalized = answer.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") {
      return "yes";
    }
    if (allowRegenerate && normalized === "r") {
      return "regenerate";
    }
    return "no";
  } finally {
    rl.close();
  }
}

function commitWithMessage(message: string): void {
  const result = spawnSync("git", ["commit", "-m", message], {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(`git commit failed with exit code ${result.status ?? 1}`);
  }
}

async function main() {
  let cliOptions: CliOptions;
  try {
    cliOptions = parseCliOptions(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ ${msg}`);
    console.error("Run `aicommits --help` for usage.");
    process.exit(1);
  }

  if (cliOptions.showHelp) {
    printHelp();
    process.exit(0);
  }

  if (cliOptions.showVersion) {
    console.log(getCliVersion());
    process.exit(0);
  }

  if (!isGitRepo()) {
    console.error("❌ Not a git repository. Run this inside a repo.");
    process.exit(1);
  }

  if (cliOptions.rulesUpdate) {
    try {
      assertNoSecrets(cliOptions.rulesUpdate, "text", "--rules");
      const savedPath = saveRepoRules(cliOptions.rulesUpdate);
      console.log(`ℹ️ Saved repository rules at: ${savedPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`❌ ${msg}`);
      process.exit(1);
    }
  }

  const repoRules = loadRepoRules();
  if (repoRules) {
    try {
      assertNoSecrets(repoRules, "text", "saved-rules");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`❌ ${msg}`);
      process.exit(1);
    }
  }

  const userCustomInstructions = cliOptions.customInstructions;
  if (userCustomInstructions) {
    try {
      assertNoSecrets(userCustomInstructions, "text", "--custom");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`❌ ${msg}`);
      process.exit(1);
    }
  }
  const inferredStyleInstructions = inferRepoStyleInstructions(getRecentCommitSubjects(STYLE_HISTORY_LIMIT));
  const effectiveCustomInstructions = buildEffectiveCustomInstructions(
    inferredStyleInstructions,
    repoRules,
    userCustomInstructions
  );

  if (repoRules) {
    console.log("ℹ️ Applying saved repository rules.");
  }

  if (inferredStyleInstructions && !repoRules && !userCustomInstructions) {
    console.log("ℹ️ Applying inferred repository commit style from recent history.");
  } else if (inferredStyleInstructions && (repoRules || userCustomInstructions)) {
    console.log("ℹ️ Applying inferred repository style with your configured preferences.");
  }

  const filteringOptions: FilteringOptions = {
    includeLockfiles: cliOptions.includeLockfiles,
    excludeGlobs: cliOptions.excludeGlobs,
  };
  const debugPayload = cliOptions.debugPayload;

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
    assertNoSecrets(rawDiffUnified0, "diff");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ ${msg}`);
    process.exit(1);
  }

  printAIInputSummary(stagedFiles, filteringOptions);

  const includedFiles = stagedFiles.filter((f) => !isExcludedFromLLM(f.path, filteringOptions));
  const hasLockfile = stagedFiles.some((f) => isLockfile(f.path));
  let finalMessage = "";
  let truncatedPayload = "";
  let canRegenerate = false;

  if (includedFiles.length === 0 && hasLockfile) {
    finalMessage = "chore(deps): update lockfile";
  } else {
    const basePayload = buildLLMPayload(stagedFiles, rawDiffUnified0, filteringOptions);
    const truncation = truncateForLLM(basePayload);
    const warnings = [...collectNoiseWarnings(rawDiffUnified0), ...truncation.warnings];
    truncatedPayload = truncation.text;
    canRegenerate = true;

    for (const w of warnings) {
      console.log(w);
    }

    console.log(`ℹ️ Using payload size: ${truncatedPayload.length.toLocaleString()} chars\n`);

    try {
      finalMessage = await generateValidatedMessage(truncatedPayload, effectiveCustomInstructions, debugPayload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`❌ ${msg}`);
      process.exit(1);
    }
  }

  if (cliOptions.copy || cliOptions.dryRun) {
    console.log("✅ Final commit message:");
    console.log(finalMessage);

    if (cliOptions.copy) {
      try {
        copyToClipboard(finalMessage);
        console.log("ℹ️ Copied commit message to clipboard.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`❌ ${msg}`);
        process.exit(1);
      }
    }

    console.log("🟡 Non-destructive mode enabled. No commit was created.");
    process.exit(0);
  }

  let regenerations = 0;
  while (true) {
    const allowRegenerate = canRegenerate && regenerations < MAX_REGENERATIONS;
    const action = await promptForCommitAction(finalMessage, allowRegenerate);

    if (action === "yes") {
      break;
    }

    if (action === "regenerate") {
      regenerations += 1;
      try {
        finalMessage = await generateDistinctRegeneratedMessage(
          truncatedPayload,
          finalMessage,
          regenerations,
          effectiveCustomInstructions,
          debugPayload
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`❌ ${msg}`);
        process.exit(1);
      }
      continue;
    }

    console.log("🟡 Commit cancelled. No changes were committed.");
    process.exit(0);
  }

  try {
    commitWithMessage(finalMessage);
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
