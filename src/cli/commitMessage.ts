const ALLOWED_COMMIT_TYPES = new Set([
  "feat",
  "fix",
  "docs",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
]);

const CONVENTIONAL_COMMIT_RE = /^([a-z]+)(?:\(([^)]+)\))?: (.+)$/;

export type ParsedCommitMessage = { type: string; scope?: string; subject: string };
export type ValidationResult = { valid: true } | { valid: false; reason: string };

export function validateCommitMessage(message: string): ValidationResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { valid: false, reason: "empty message" };
  }

  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return { valid: false, reason: "must be a single line" };
  }

  if (trimmed.length > 72) {
    return { valid: false, reason: "must be <= 72 chars" };
  }

  if (trimmed.endsWith(".")) {
    return { valid: false, reason: "must not end with a period" };
  }

  const match = trimmed.match(CONVENTIONAL_COMMIT_RE);
  if (!match) {
    return { valid: false, reason: "must match type(scope?): subject" };
  }

  const type = match[1];
  const subject = match[3];
  if (!type || !ALLOWED_COMMIT_TYPES.has(type)) {
    return { valid: false, reason: "type must be allowed lowercase conventional type" };
  }

  if (!subject || !subject.trim()) {
    return { valid: false, reason: "subject must be present" };
  }

  return { valid: true };
}

export function parseCommitMessage(message: string): ParsedCommitMessage | null {
  const match = message.trim().match(CONVENTIONAL_COMMIT_RE);
  if (!match) {
    return null;
  }
  const type = match[1];
  const scope = match[2];
  const subject = match[3];
  if (!type || !subject) {
    return null;
  }
  if (scope) {
    return { type, scope, subject };
  }
  return { type, subject };
}

function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSubjectMeaningfullyDifferent(previousSubject: string, nextSubject: string): boolean {
  const previous = normalizeSubject(previousSubject);
  const next = normalizeSubject(nextSubject);

  if (!previous || !next) {
    return previous !== next;
  }
  if (previous === next) {
    return false;
  }

  const previousWords = previous.split(" ").filter(Boolean);
  const nextWords = next.split(" ").filter(Boolean);
  const previousSet = new Set(previousWords);
  const nextSet = new Set(nextWords);
  const allWords = new Set([...previousSet, ...nextSet]);

  let overlap = 0;
  for (const word of previousSet) {
    if (nextSet.has(word)) {
      overlap += 1;
    }
  }

  const jaccard = allWords.size === 0 ? 1 : overlap / allWords.size;
  return jaccard < 0.75;
}

export function buildPrefix(type: string, scope?: string): string {
  return scope ? `${type}(${scope})` : type;
}
