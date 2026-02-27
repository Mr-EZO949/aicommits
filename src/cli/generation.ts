import {
  buildPrefix,
  isSubjectMeaningfullyDifferent,
  parseCommitMessage,
  validateCommitMessage,
} from "./commitMessage.js";
import { groqProvider } from "../providers/groq.js";

const SAFE_FALLBACK_MESSAGE = "chore: update staged changes";
const MAX_REGENERATION_PROVIDER_ATTEMPTS = 3;

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

export async function generateValidatedMessage(
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

export async function generateDistinctRegeneratedMessage(
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
