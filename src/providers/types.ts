// src/providers/types.ts

/**
 * A Provider is any "engine" that can turn a git diff into a commit message.
 * The CLI should depend on this interface, not on any specific SDK (OpenAI/Groq/etc).
 */
export interface Provider {
  generateCommitMessage(
    diff: string,
    options?: { customInstructions?: string }
  ): Promise<string>;
}
