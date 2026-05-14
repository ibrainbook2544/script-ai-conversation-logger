# script-conversation-logger

A lightweight, cross-platform Stop hook that automatically appends every AI conversation to a daily Markdown log file.

Works with both **Claude Code** and **OpenAI Codex** hooks.

## How it works

When the AI finishes a response, the hook fires:

1. Reads the hook event JSON from `stdin` and extracts `transcript_path`.
2. Parses only the *new* lines since the last run (tracked by a per-transcript state file).
3. Formats each `user` / `assistant` turn into readable Markdown with timestamps and tool-use summaries.
4. Appends the formatted block to `<outputDir>/YYYY-MM-DD.md`, creating the file if it does not exist.

Failure mode is **fail-open** — any error causes the script to exit with code `0` so the assistant is never trapped in a loop.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (no extra packages required — uses only Node built-ins)

### 1. Copy the script

Place `.script/conversation-logger.js` anywhere inside your project root (the directory above `.script/` is treated as the vault root).

### 2. Register the hook

**Claude Code** — add to `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .script/conversation-logger.js",
            "timeout": 10,
            "statusMessage": "Logging conversation..."
          }
        ]
      }
    ]
  }
}
```

**Codex** — add to `.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node .script/conversation-logger.js",
            "timeout": 10,
            "statusMessage": "Logging conversation..."
          }
        ]
      }
    ]
  }
}
```

### 3. (Optional) Configure

Create `.script/conversation-logger.config.json`:

```json
{
  "outputDir": "conversation-logs",
  "header": "---\ntype: log\norigin: hook-transcript\ntags: [conversation, log, hook]\ndate: {{day}}\n---\n"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `outputDir` | `log` | Output directory for log files (relative to vault root, or absolute) |
| `header` | `""` | Text prepended to new log files. Supports `{{day}}` (resolves to `YYYY-MM-DD`) |

## Output format

Each conversation is appended as a Markdown section:

```markdown
## 2026-05-08 14:36:04 - Conversation title

### [User] - 2026-05-08 14:36:02

Hello!

### [claude-sonnet-4-6] - 2026-05-08 14:36:04

Hi! How can I help you today?

---
```

Tool calls are rendered as compact inline summaries (e.g., `🔧 **Bash**: \`git status\``). Thinking blocks show a short preview. File-modification snapshots list the affected files.

## Project structure

```
.
├── .script/
│   ├── conversation-logger.js          # Hook script
│   └── conversation-logger.config.json # Optional configuration
├── .claude/
│   └── settings.json                   # Claude Code hook registration
├── .codex/
│   └── hooks.json                      # Codex hook registration
└── conversation-logs/
    └── YYYY-MM-DD.md                   # Daily log files (git-ignored)
```

State files used to track per-transcript offsets are stored in `.script/.conversation-logger-state/` and are also git-ignored.

## .gitignore

```
log/
.script/.conversation-logger-state/
conversation-logs/
```

Adjust to match your configured `outputDir`.

## License

MIT
