const MAX_CUSTOM_INSTRUCTIONS_CHARS = 1_000;
const MAX_RULES_CHARS = 2_000;

export type CliOptions = {
  showHelp: boolean;
  showVersion: boolean;
  customInstructions?: string;
  rulesUpdate?: string;
  includeLockfiles: boolean;
  excludeGlobs: string[];
  debugPayload: boolean;
  copy: boolean;
  dryRun: boolean;
};

export function printHelp(): void {
  console.log([
    "Usage:",
    "  aicommits [--rules \"<repo rules>\"] [--custom \"<preferences>\"] [--include-lockfiles] [--exclude <glob>] [--debug-payload] [--copy] [--dry-run] [--version] [--help]",
    "",
    "Options:",
    "  --rules <text>    Save persistent commit preferences for this repository.",
    "                    Stored under .git and reused in future runs.",
    "  --custom <text>   Add optional commit style preferences (max 1000 chars).",
    "                    This is additive and never overrides safety/format rules.",
    "  --include-lockfiles",
    "                    Include lockfile diffs in AI input (default: excluded).",
    "  --exclude <glob>  Exclude staged paths from AI input (repeatable).",
    "                    Examples: --exclude \"dist/**\" --exclude \"*.map\"",
    "  --debug-payload   Print exact payload text sent to the provider.",
    "  --copy            Copy final validated message to clipboard, then exit.",
    "  --dry-run         Print final validated message and exit (no prompt, no commit).",
    "  --version, -v     Show current CLI version.",
    "  --help, -h        Show this help message.",
    "",
    "Examples:",
    "  aicommits",
    "  aicommits --rules \"prefer scope cli and mention tests when relevant\"",
    "  aicommits --custom \"prefer scope cli and mention tests when relevant\"",
    "  aicommits --custom \"focus on user-facing behavior changes\"",
    "  aicommits --include-lockfiles",
    "  aicommits --exclude \"dist/**\" --exclude \"*.map\"",
    "  aicommits --debug-payload",
    "  aicommits --copy",
    "  aicommits --dry-run",
    "  aicommits --version",
  ].join("\n"));
}

export function parseCliOptions(argv: string[]): CliOptions {
  const parsed: CliOptions = {
    showHelp: false,
    showVersion: false,
    includeLockfiles: false,
    excludeGlobs: [],
    debugPayload: false,
    copy: false,
    dryRun: false,
  };
  let sawCustom = false;
  let sawRules = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.showHelp = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      parsed.showVersion = true;
      continue;
    }

    if (arg === "--rules") {
      if (sawRules) {
        throw new Error("`--rules` can only be provided once.");
      }
      const next = argv[i + 1];
      if (!next || next === "--help" || next === "-h" || next.startsWith("--")) {
        throw new Error("Missing value for `--rules`. Example: --rules \"prefer concise subjects\"");
      }
      parsed.rulesUpdate = next;
      sawRules = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--rules=")) {
      if (sawRules) {
        throw new Error("`--rules` can only be provided once.");
      }
      parsed.rulesUpdate = arg.slice("--rules=".length);
      sawRules = true;
      continue;
    }

    if (arg === "--include-lockfiles") {
      parsed.includeLockfiles = true;
      continue;
    }

    if (arg === "--debug-payload") {
      parsed.debugPayload = true;
      continue;
    }

    if (arg === "--copy") {
      parsed.copy = true;
      continue;
    }

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--exclude") {
      const next = argv[i + 1];
      if (!next || next === "--help" || next === "-h" || next.startsWith("--")) {
        throw new Error("Missing value for `--exclude`. Example: --exclude \"dist/**\"");
      }
      parsed.excludeGlobs.push(next);
      i += 1;
      continue;
    }

    if (arg.startsWith("--exclude=")) {
      parsed.excludeGlobs.push(arg.slice("--exclude=".length));
      continue;
    }

    if (arg === "--custom") {
      if (sawCustom) {
        throw new Error("`--custom` can only be provided once.");
      }
      const next = argv[i + 1];
      if (!next || next === "--help" || next === "-h" || next.startsWith("--")) {
        throw new Error("Missing value for `--custom`. Example: --custom \"prefer concise subjects\"");
      }
      parsed.customInstructions = next;
      sawCustom = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--custom=")) {
      if (sawCustom) {
        throw new Error("`--custom` can only be provided once.");
      }
      parsed.customInstructions = arg.slice("--custom=".length);
      sawCustom = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (parsed.customInstructions !== undefined) {
    const custom = parsed.customInstructions.trim();
    if (custom.length === 0) {
      throw new Error("`--custom` value cannot be empty.");
    }
    if (custom.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
      throw new Error(
        `\`--custom\` is too long (${custom.length} chars). Max is ${MAX_CUSTOM_INSTRUCTIONS_CHARS} chars.`
      );
    }
    parsed.customInstructions = custom;
  }

  if (parsed.rulesUpdate !== undefined) {
    const rules = parsed.rulesUpdate.trim();
    if (rules.length === 0) {
      throw new Error("`--rules` value cannot be empty.");
    }
    if (rules.length > MAX_RULES_CHARS) {
      throw new Error(`\`--rules\` is too long (${rules.length} chars). Max is ${MAX_RULES_CHARS} chars.`);
    }
    parsed.rulesUpdate = rules;
  }

  parsed.excludeGlobs = parsed.excludeGlobs.map((glob) => glob.trim()).filter(Boolean);
  for (const glob of parsed.excludeGlobs) {
    if (glob.length > 512) {
      throw new Error(`\`--exclude\` glob is too long (${glob.length} chars).`);
    }
  }

  return parsed;
}
