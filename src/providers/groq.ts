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
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content:
            "You write concise git commit messages. Return ONLY one commit message line. Use Conventional Commits format.",
        },
        {
          role: "user",
          content: "Generate a commit message for the following staged diff:\n\n" + diff,
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
