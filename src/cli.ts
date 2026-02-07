#!/usr/bin/env node

import { execSync } from "node:child_process";

const MAX_CHARS = 25_000;

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

function getStagedDiff(): string {
  return run("git diff --staged");
}

type Sanitized = { safeDiff: string; warnings: string[] };

function sanitizeDiff(rawDiff: string): Sanitized {
  const warnings: string[] = [];

  // Very basic “obvious secret” patterns (MVP).
  // This is NOT perfect security—just a guardrail.
  const secretPatterns: Array<{ name: string; re: RegExp }> = [
    { name: "private key block", re: /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i },
    { name: "API key assignment", re: /\bAPI[_-]?KEY\s*=/i },
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

  // Optional “noise” warnings (we don't remove yet; just warn).
  const noisyPathHints: Array<{ label: string; re: RegExp }> = [
    { label: "node_modules/", re: /diff --git a\/node_modules\// },
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

  let safeDiff = rawDiff;

  if (safeDiff.length > MAX_CHARS) {
    warnings.push(
      `⚠️ Large diff (${safeDiff.length.toLocaleString()} chars). Using first ${MAX_CHARS.toLocaleString()} chars.`
    );
    safeDiff = safeDiff.slice(0, MAX_CHARS) + "\n\n…(truncated)\n";
  }

  return { safeDiff, warnings };
}

function main() {
  // Useful when debugging “why doesn't git see my repo”
  // console.log("CWD:", process.cwd());

  if (!isGitRepo()) {
    console.error("❌ Not a git repository. Run this inside a repo.");
    process.exit(1);
  }

  const rawDiff = getStagedDiff();

  if (!rawDiff.trim()) {
    console.log("🟡 No staged changes. Run: git add <files>");
    process.exit(0);
  }

  console.log(`ℹ️ Raw diff size: ${rawDiff.length.toLocaleString()} chars`);

  let sanitized: Sanitized;
  try {
    sanitized = sanitizeDiff(rawDiff);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ ${msg}`);
    process.exit(1);
  }

  for (const w of sanitized.warnings) {
    console.log(w);
  }

  console.log(`ℹ️ Using diff size: ${sanitized.safeDiff.length.toLocaleString()} chars\n`);
  console.log(sanitized.safeDiff);
}

main();
