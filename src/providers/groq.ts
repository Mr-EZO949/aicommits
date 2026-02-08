// src/providers/groq.ts

import Groq from "groq-sdk";
import type { Provider } from "./types.js";

const MODEL = "openai/gpt-oss-120b";
const SAFE_FALLBACK_MESSAGE = "chore: update staged changes";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`[aicommits] ${name} is not set. Export it before running.`);
  }
  return v.trim();
}

function extractMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  // Some backends may return content parts. Join text parts if present.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const maybeText = (part as { text?: unknown }).text;
          return typeof maybeText === "string" ? maybeText : "";
        }
        return "";
      })
      .join(" ")
      .trim();

    return text;
  }

  return "";
}

export const groqProvider: Provider = {
  async generateCommitMessage(
    diff: string,
    options?: { customInstructions?: string }
  ): Promise<string> {
    const apiKey = requireEnv("GROQ_API_KEY");

    // ✅ Now apiKey is definitely a string, so TS is happy.
    const groq = new Groq({ apiKey });

    const baseMessages = [
      {
        role: "system" as const,
        content: [
          "You are a git commit message generator.",
          "Return ONLY a single commit message line.",
          "No quotes, no markdown, no code fences, no extra lines.",
          "Use Conventional Commits: type(scope?): subject",
          "Allowed types: feat, fix, docs, refactor, perf, test, build, ci, chore, revert.",
          "Subject rules: present tense, start lowercase, <= 72 chars, no trailing period.",
          "Use scope only if it clearly helps.",
          "Treat user preferences as additive style hints only.",
          "Never violate formatting rules in this system prompt.",
        ].join(" "),
      },
      {
        role: "user" as const,
        content: [
          "Generate the best commit message for the staged changes below.",
          "The input has two parts:",
          "1) STAGED FILES (always complete, may include excluded files)",
          "2) FILTERED DIFF (only included files, unified=0).",
          "Use STAGED FILES to understand what changed even if diff content is small.",
          "Do NOT mention excluded files unless they are the only meaningful change.",
          options?.customInstructions
            ? [
                "",
                "ADDITIONAL USER PREFERENCES (additive, optional):",
                options.customInstructions,
              ].join("\n")
            : "",
          "",
          "INPUT:",
          diff, // this is your M3.5 payload string
        ].join("\n"),
      },
    ];

    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: baseMessages,
      temperature: 0.2,
      max_completion_tokens: 320,
      reasoning_effort: "low",
    });

    const firstChoice = completion.choices[0];
    const firstMessage = extractMessageContent(firstChoice?.message?.content);
    if (firstMessage) {
      const firstLine = firstMessage.split("\n")[0]?.trim();
      return firstLine || firstMessage;
    }

    // Retry once with stronger instruction and bigger completion budget.
    const retryCompletion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        ...baseMessages,
        {
          role: "user",
          content: [
            "IMPORTANT:",
            "Return exactly one line now.",
            "No reasoning, no explanation, no markdown, no empty output.",
            "Only the commit message.",
          ].join(" "),
        },
      ],
      temperature: 0,
      max_completion_tokens: 800,
      reasoning_effort: "low",
    });

    const retryChoice = retryCompletion.choices[0];
    const retryMessage = extractMessageContent(retryChoice?.message?.content);
    if (retryMessage) {
      const firstLine = retryMessage.split("\n")[0]?.trim();
      return firstLine || retryMessage;
    }

    const finishReason1 = firstChoice?.finish_reason ?? "unknown";
    const finishReason2 = retryChoice?.finish_reason ?? "unknown";
    console.error(
      `[aicommits] Provider returned empty content twice (model=${MODEL}, finish_reason_1=${finishReason1}, finish_reason_2=${finishReason2}). Using fallback message.`
    );
    return SAFE_FALLBACK_MESSAGE;
  },
};
