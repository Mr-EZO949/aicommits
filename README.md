# aicommits

Generate Conventional Commit messages from staged git changes.

`aicommits` is a CLI that:
- reads your staged changes
- filters noisy files before sending context to the model
- validates commit-message format
- supports regenerate / confirm flow
- can commit, copy, or dry-run

---

## Quick start

Run without installing globally:

```bash
npx @mr_ezo/aicommits
```

---

## Requirements

- Node.js 18+
- Git repository
- Groq API key (BYOK)

---

## Setup (API key)

You must provide a Groq API key before running.

### Option 1: environment variable

```bash
export GROQ_API_KEY="sk_..."
```

Then run:

```bash
aicommits
```

### Option 2: project `.env` file

Create a `.env` file in your repository:

```env
GROQ_API_KEY=sk_...
```

---

## Installation

### Global install (optional)

```bash
npm i -g @mr_ezo/aicommits
```

Then run:

```bash
aicommits
```

### Local install (project dependency)

```bash
npm i -D @mr_ezo/aicommits
```

Then run:

```bash
npx aicommits
```

---

## Usage

```bash
aicommits [options]
```

### Options

- `--custom "<text>"`
  - Add extra style preferences (additive only, does not override safety or format rules).
- `--include-lockfiles`
  - Include lockfile diff content in model input.
- `--exclude <glob>`
  - Exclude staged files from model input. Repeatable.
  - Example: `--exclude "dist/**" --exclude "*.map"`
- `--debug-payload`
  - Print the exact payload sent to the provider.
- `--copy`
  - Copy the final validated message to clipboard and exit (no commit).
- `--dry-run`
  - Print the final validated message and exit (no prompt, no commit).
- `--help`, `-h`
  - Show CLI help.

---

## Typical workflow

```bash
git add .
aicommits
```

Interactive prompt:
- `y` / `yes` → commit with validated message
- `r` → regenerate message (bounded retries)
- `n` / empty / Ctrl-C / EOF → exit without commit

---

## Safety and validation

- Guardrails run before any provider call.
- Messages must pass Conventional Commit validation:
  - single line
  - `type(scope?): subject`
  - lowercase allowed types
  - max 72 characters
  - no trailing period
- Invalid model output is retried and can fall back to a safe deterministic message.

---

## Transparency features

- Prints an AI input summary (included vs excluded files).
- Exact payload inspection via `--debug-payload`.
- `--copy` and `--dry-run` ensure non-destructive workflows.

---

## Development

```bash
npm run build
npm run dev
```

---

## License

MIT