#!/usr/bin/env node
import "dotenv/config";

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  buildPrefix,
  isSubjectMeaningfullyDifferent,
  parseCommitMessage,
  validateCommitMessage,
} from "./cli/commitMessage.js";
import {
  getRecentCommitSubjects,
  getStagedDiffUnified0,
  getStagedNameStatus,
  isGitRepo,
  loadRepoRules,
  saveRepoRules,
} from "./cli/git.js";
import { parseCliOptions, printHelp, type CliOptions } from "./cli/options.js";
import { groqProvider } from "./providers/groq.js";


const MAX_CHARS = 25_000;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const EXCLUDED_PREFIXES = ["dist/", "build/", "coverage/", "node_modules/"];
const SAFE_FALLBACK_MESSAGE = "chore: update staged changes";
const MAX_REGENERATIONS = 3;
const MAX_REGENERATION_PROVIDER_ATTEMPTS = 3;
const STYLE_HISTORY_LIMIT = 20;

type StagedStatus = "A" | "M" | "D" | "R" | "C";
type StagedFile = { status: StagedStatus; path: string };
type FilteringOptions = { includeLockfiles: boolean; excludeGlobs: string[] };
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

function globToRegExp(glob: string): RegExp {
  const normalizedGlob = normalizePath(glob).replace(/^\.\/+/, "");
  let pattern = "";

  for (let i = 0; i < normalizedGlob.length; i += 1) {
    const ch = normalizedGlob.charAt(i);
    if (ch === "*") {
      if (normalizedGlob.charAt(i + 1) === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += ch.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
  }

  return new RegExp(`^${pattern}$`);
}

function matchesGlob(path: string, glob: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedGlob = normalizePath(glob).replace(/^\.\/+/, "");
  if (!normalizedGlob) {
    return false;
  }

  const regex = globToRegExp(normalizedGlob);
  if (normalizedGlob.includes("/")) {
    return regex.test(normalizedPath);
  }

  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  return regex.test(normalizedPath) || regex.test(basename);
}

function isLockfile(path: string): boolean {
  return LOCKFILES.has(normalizePath(path));
}

function getExclusionReason(path: string, options: FilteringOptions): string | null {
  const normalized = normalizePath(path);

  const matchingGlob = options.excludeGlobs.find((glob) => matchesGlob(normalized, glob));
  if (matchingGlob) {
    return `matched --exclude ${matchingGlob}`;
  }

  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "generated/build directory";
  }

  if (normalized === "node_modules" || normalized.includes("/node_modules/")) {
    return "node_modules";
  }

  if (normalized.endsWith(".map")) {
    return "*.map";
  }

  if (normalized.includes(".min.")) {
    return "*.min.*";
  }

  if (normalized === ".env") {
    return ".env";
  }

  if (!options.includeLockfiles && isLockfile(normalized)) {
    return "lockfile";
  }

  return null;
}

function isExcludedFromLLM(path: string, options: FilteringOptions): boolean {
  return getExclusionReason(path, options) !== null;
}

function printAIInputSummary(stagedFiles: StagedFile[], options: FilteringOptions): void {
  const included = stagedFiles.filter((file) => !isExcludedFromLLM(file.path, options));
  const excluded = stagedFiles
    .map((file) => ({ file, reason: getExclusionReason(file.path, options) }))
    .filter((item): item is { file: StagedFile; reason: string } => item.reason !== null);

  console.log(
    `ℹ️ AI input summary: ${included.length} included, ${excluded.length} excluded, ${stagedFiles.length} staged total`
  );

  if (included.length > 0) {
    const includedList = included.map((file) => `${file.status} ${file.path}`).join(", ");
    console.log(`   included: ${includedList}`);
  }

  if (excluded.length > 0) {
    const excludedList = excluded
      .map((item) => `${item.file.status} ${item.file.path} (${item.reason})`)
      .join(", ");
    console.log(`   excluded: ${excludedList}`);
  }
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

function filterDiffByExcludedFiles(diffUnified0: string, options: FilteringOptions): string {
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
      keepCurrentChunk = path ? !isExcludedFromLLM(path, options) : true;
      continue;
    }
    currentChunk.push(line);
  }
  flushChunk();

  return keptChunks.join("\n").trim();
}

function buildLLMPayload(stagedFiles: StagedFile[], diffUnified0: string, options: FilteringOptions): string {
  const stagedLines = stagedFiles.map((file) => {
    const exclusionReason = getExclusionReason(file.path, options);
    const excludedSuffix = exclusionReason ? ` (excluded: ${exclusionReason})` : "";
    return `${file.status} ${file.path}${excludedSuffix}`;
  });
  const filteredDiff = filterDiffByExcludedFiles(diffUnified0, options);

  return [
    "STAGED FILES:",
    ...stagedLines,
    "",
    "FILTERED DIFF:",
    filteredDiff || "(all staged file diffs excluded)",
  ].join("\n");
}

function buildRetryPayload(basePayload: string, firstOutput: string, reason: string): string {
  return [
    basePayload,
    "",
    "FORMAT FIX REQUEST:",
    "Your previous output was invalid. Return ONLY one corrected commit message line.",
    "Strict rules:",
    "1) Must match: type(scope?): subject",
    "2) Allowed lowercase types: feat, fix, docs, refactor, perf, test, build, ci, chore, revert",
    "3) Max 72 characters total",
    "4) No trailing period",
    "5) No quotes, markdown, bullets, or extra text",
    `Invalid output: ${firstOutput.replace(/\s+/g, " ").trim() || "(empty)"}`,
    `Reason: ${reason}`,
  ].join("\n");
}

function printDebugPayload(payload: string, label: string): void {
  console.log(`\n🔎 DEBUG PAYLOAD (${label}) START`);
  console.log(payload);
  console.log(`🔎 DEBUG PAYLOAD (${label}) END\n`);
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

function getDeterministicAlternativeMessage(previousMessage: string): string {
  const previous = previousMessage.trim();
  const parsedPrevious = parseCommitMessage(previous);
  if (parsedPrevious) {
    const prefix = buildPrefix(parsedPrevious.type, parsedPrevious.scope);
    const alternativeSubjects = [
      "refine staged updates",
      "adjust staged implementation",
      "improve staged changes",
      "update staged changes",
    ];

    for (const subject of alternativeSubjects) {
      if (!isSubjectMeaningfullyDifferent(parsedPrevious.subject, subject)) {
        continue;
      }
      const candidate = `${prefix}: ${subject}`;
      if (validateCommitMessage(candidate).valid) {
        return candidate;
      }
    }
  }

  return SAFE_FALLBACK_MESSAGE;
}

async function generateValidatedMessage(
  payload: string,
  customInstructions?: string,
  debugPayload = false
): Promise<string> {
  const providerOptions = customInstructions ? { customInstructions } : undefined;
  if (debugPayload) {
    printDebugPayload(payload, "provider:first-attempt");
  }
  const firstAttempt = await groqProvider.generateCommitMessage(payload, providerOptions);
  const firstValidation = validateCommitMessage(firstAttempt);

  let msg = firstAttempt.trim();
  if (!firstValidation.valid) {
    const retryPayload = buildRetryPayload(payload, firstAttempt, firstValidation.reason);
    if (debugPayload) {
      printDebugPayload(retryPayload, "provider:format-retry");
    }
    const secondAttempt = await groqProvider.generateCommitMessage(retryPayload, providerOptions);
    const secondValidation = validateCommitMessage(secondAttempt);

    if (secondValidation.valid) {
      msg = secondAttempt.trim();
    } else {
      msg = SAFE_FALLBACK_MESSAGE;
      console.log(
        `⚠️ Provider returned invalid commit messages twice (${firstValidation.reason}; ${secondValidation.reason}). Using fallback.`
      );
    }
  }

  const finalValidation = validateCommitMessage(msg);
  if (!finalValidation.valid) {
    console.log(`⚠️ Final message failed validation (${finalValidation.reason}). Using fallback.`);
    return SAFE_FALLBACK_MESSAGE;
  }
  return msg;
}

async function generateDistinctRegeneratedMessage(
  basePayload: string,
  previousMessage: string,
  regenerationNumber: number,
  customInstructions?: string,
  debugPayload = false
): Promise<string> {
  const previous = previousMessage.trim();
  const previousParsed = parseCommitMessage(previous);
  const fixedPrefix = previousParsed ? buildPrefix(previousParsed.type, previousParsed.scope) : "";

  for (let attempt = 1; attempt <= MAX_REGENERATION_PROVIDER_ATTEMPTS; attempt += 1) {
    const regenerationPayload = [
      basePayload,
      "",
      "ALTERNATIVE PHRASING REQUEST:",
      "Generate an alternative valid commit message by rephrasing the subject.",
      "Keep the same underlying change intent and keep the same type/scope prefix.",
      fixedPrefix ? `Required prefix: ${fixedPrefix}:` : "",
      "Do NOT only swap the type (feat/fix/etc). Rewrite the subject wording.",
      `Regeneration number: ${regenerationNumber}`,
      `Message you MUST NOT repeat exactly: ${previous}`,
      previousParsed ? `Previous subject you must rewrite: ${previousParsed.subject}` : "",
      attempt > 1 ? "The previous regenerated output repeated. You must choose different wording." : "",
    ]
      .filter(Boolean)
      .join("\n");

    const candidate = await generateValidatedMessage(regenerationPayload, customInstructions, debugPayload);
    const candidateTrimmed = candidate.trim();
    const candidateParsed = parseCommitMessage(candidateTrimmed);
    const hasDifferentSubject = previousParsed && candidateParsed
      ? isSubjectMeaningfullyDifferent(previousParsed.subject, candidateParsed.subject)
      : candidateTrimmed !== previous;
    const hasSamePrefix = previousParsed && candidateParsed
      ? candidateParsed.type === previousParsed.type &&
        (candidateParsed.scope ?? "") === (previousParsed.scope ?? "")
      : true;

    if (candidateTrimmed !== previous && hasSamePrefix && hasDifferentSubject) {
      return candidate;
    }
  }

  console.log("⚠️ Regeneration repeated the same message. Using deterministic alternative.");
  return getDeterministicAlternativeMessage(previous);
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
