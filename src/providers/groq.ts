// src/providers/groq.ts

import Groq from "groq-sdk";
import type { Provider } from "./types.js";


function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`[aicommits] ${name} is not set. Export it before running.`);
  }
  return v.trim();
}

export const groqProvider: Provider = {
  async generateCommitMessage(diff: string): Promise<string> {
    const apiKey = requireEnv("GROQ_API_KEY");

    // ✅ Now apiKey is definitely a string, so TS is happy.
    const groq = new Groq({ apiKey });

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: [
            "You are a git commit message generator.",
            "Return ONLY a single commit message line.",
            "No quotes, no markdown, no code fences, no extra lines.",
            "Use Conventional Commits: type(scope?): subject",
            "Allowed types: feat, fix, docs, refactor, perf, test, build, ci, chore, revert.",
            "Subject rules: present tense, start lowercase, <= 72 chars, no trailing period.",
            "Use scope only if it clearly helps (e.g. providers, cli, groq).",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            "Generate the best commit message for the staged changes below.",
            "The input has two parts:",
            "1) STAGED FILES (always complete, may include excluded files)",
            "2) FILTERED DIFF (only included files, unified=0).",
            "Use STAGED FILES to understand what changed even if diff content is small.",
            "Do NOT mention excluded files unless they are the only meaningful change.",
            "",
            "INPUT:",
            diff, // this is your M3.5 payload string
          ].join("\n"),
        },
      ],

      temperature: 0.2,
      max_tokens: 80,
    });

    const message = completion.choices[0]?.message?.content;
    if (!message || message.trim().length === 0) {
      throw new Error("[aicommits] Groq returned an empty response.");
    }

    const firstLine = message.trim().split("\n")[0];
    return firstLine ?? message.trim();
  },
};
