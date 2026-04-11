# Claude Telegram Bridge

A local proxy that lets you interact with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone via a Telegram bot. Runs on your Mac, no cloud needed.

## How it works

```
Phone (Telegram) --> Telegram Bot API --> This App --> Claude Code CLI
```

- Messages you send on Telegram get forwarded to `claude -p` running locally
- Claude's responses stream back to Telegram with real-time updates
- Sessions persist across messages using Claude Code's `--session-id` / `--resume`
- No ports are exposed — uses Telegram long polling (outbound HTTPS only)

## Prerequisites

- **Node.js** >= 20
- **Claude Code** CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- A **Telegram account**

## Quick Start

```bash
git clone <this-repo>
cd claude-telegram-bridge
npm install
npm run setup    # Interactive wizard
npm run dev      # Start the bridge
```

The setup wizard walks you through:
1. Creating a Telegram bot via @BotFather
2. Finding your Telegram user ID via @userinfobot
3. Setting an optional security PIN
4. Adding your project directories

## Manual Setup

If you prefer to configure manually:

```bash
cp .env.example .env
cp config.example.yaml config.yaml
```

Edit `.env`:
```
TELEGRAM_BOT_TOKEN=your-token-from-botfather
BRIDGE_PIN=optional-pin
```

Edit `config.yaml`:
```yaml
telegram:
  allowedUserIds:
    - 123456789  # Your Telegram user ID

projects:
  my-app:
    path: "/path/to/your/project"
```

Then run:
```bash
npm run dev
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/new [project] [name]` | Start a new Claude session |
| `/sessions` | List all sessions |
| `/switch <id>` | Switch to a session (by ID prefix) |
| `/status` | Current session info |
| `/project <name>` | Switch project directory |
| `/projects` | List configured projects |
| `/model <name>` | Change model (haiku/sonnet/opus) |
| `/effort <level>` | Change effort (low/medium/high/max) |
| `/cost` | Cost summary |
| `/kill` | Stop the current Claude request |
| `/killall` | Disable all processing (emergency stop) |
| `/enable` | Re-enable after killall |

## Features

- **Streaming responses** — see Claude's response as it types
- **Session management** — multiple concurrent conversations
- **Project switching** — quickly change working directories
- **Per-project tool whitelists** — restrict what Claude can do per project
- **File uploads** — send photos/documents from your phone to Claude
- **Cost tracking** — per-session and total cost display
- **Code formatting** — proper code blocks in Telegram messages
- **Message queuing** — messages queue up if Claude is busy
- **State persistence** — sessions survive restarts

## Security

| Layer | Mechanism |
|-------|-----------|
| Network | No exposed ports (long polling only) |
| Identity | Telegram user ID whitelist |
| Auth | Optional PIN with lockout |
| Tools | Per-project allowed tool lists |
| Cost | Budget caps per invocation |
| Process | Kill switch commands |
| Rate limit | Configurable messages/minute |

## Configuration Reference

See `config.example.yaml` for all options. Key settings:

- `telegram.allowedUserIds` — who can use the bot (required)
- `security.requirePin` — enable PIN authentication
- `claude.defaultModel` — default model (sonnet, opus, haiku)
- `claude.defaultTools` — tools Claude can use
- `claude.maxBudgetUsd` — max cost per invocation
- `projects.<name>.path` — project directory
- `projects.<name>.allowedTools` — per-project tool override

## Running in Background

```bash
# Build and run with pm2
npm run build
npx pm2 start dist/index.js --name claude-bridge

# Or with nohup
nohup npm start > bridge.log 2>&1 &
```

## Development

```bash
npm run dev        # Start with hot reload
npm run typecheck  # Type check without building
npm run build      # Build to dist/
```
