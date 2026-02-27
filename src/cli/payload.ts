const MAX_CHARS = 25_000;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const EXCLUDED_PREFIXES = ["dist/", "build/", "coverage/", "node_modules/"];

export type StagedStatus = "A" | "M" | "D" | "R" | "C";
export type StagedFile = { status: StagedStatus; path: string };
export type FilteringOptions = { includeLockfiles: boolean; excludeGlobs: string[] };

export function parseStagedNameStatus(rawNameStatus: string): StagedFile[] {
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

export function isLockfile(path: string): boolean {
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

export function isExcludedFromLLM(path: string, options: FilteringOptions): boolean {
  return getExclusionReason(path, options) !== null;
}

export function printAIInputSummary(stagedFiles: StagedFile[], options: FilteringOptions): void {
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

export function collectNoiseWarnings(rawDiff: string): string[] {
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

export function truncateForLLM(text: string): { text: string; warnings: string[] } {
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

export function buildLLMPayload(stagedFiles: StagedFile[], diffUnified0: string, options: FilteringOptions): string {
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
