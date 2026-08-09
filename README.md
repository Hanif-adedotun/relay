# Relay

**Ship code from your pocket.**

Relay is a conversational devops agent over iMessage. Text it like a teammate — check PR status, fix failing tests, deploy to staging, spin up a preview domain — and get human replies back on your phone, not log dumps.

No dashboard. No SSH app. Just you, your number, and the repos you trust Relay with.

---

## Why Relay?

You're away from your laptop. CI is red. Someone asks if the PR is ready. You want to deploy — or point a branch at a preview URL — without opening five tabs.

Relay meets you where you already are: **iMessage**.

- **Conversational** — "How's PR 42?" then later "fix that test." It remembers.
- **Scoped** — coding, GitHub, deploys, and server infra. Not a general chatbot.
- **Pluggable** — swap coding backends (Claude Code, Cursor, OpenClaw, Aider…) without changing how you text.
- **Open** — adapters, MCP tools, and agent backends are meant to be extended by the community.

---

## Features

### Talk to your stack

| You text… | Relay does… |
|---|---|
| "What's the stage of PR #42?" | Fetches reviews, checks, merge state via **GitHubAgent** |
| "Fix the failing test on that PR" | Delegates to **CodingAgent** (Claude Code, Cursor SDK, OpenClaw, …) |
| "Deploy main to staging" | Runs deploy workflow via **ServerAgent** |
| "Point `login.staging.example.com` at `feature/login`" | Preview deploy — nginx, certbot, branch mapping |
| "What's the weather?" | Politely declines — Relay stays in its lane |

### Built for real conversations

- **Identity by phone** — your number is your account; no separate login flow
- **Sessions** — each thread remembers active repo, PR, branch, and pending confirmations
- **Async with presence** — jobs run in the background; you get acks, typing indicators, and progress texts
- **Confirm before damage** — production deploys and destructive ops require an explicit "YES"

### Three tools, one interface

| Tool | Role |
|---|---|
| **CodingAgent** | Code changes, tests, PRs |
| **GitHubAgent** | PR/CI status, merges, workflow dispatch |
| **ServerAgent** | Deploys, nginx, certbot, preview domains |

Tools can run as direct adapters or **MCP servers** — same surface, your choice.

### Messaging that doesn't fall apart

Relay sits on [Spectrum](https://photon.codes/docs/spectrum-ts) for iMessage delivery, with production patterns for debouncing message bursts, cancelling stale replies, and idempotent sends when workers retry.

---

## How it works

```
iPhone → iMessage → Relay → [CodingAgent | GitHubAgent | ServerAgent] → GitHub / CI / your server
                ↑__________________________________________________________|
                              replies flow back to your thread
```

Relay orchestrates. It doesn't rewrite your code or SSH into boxes itself — it routes work to the right adapter and keeps the conversation going while jobs run.

Full design: **[architecture.md](./architecture.md)**

---

## Example thread

```
You:    How's PR 42 on project-a?
Relay:  PR #42 — CI green ✅, 1 approval still needed. Want me to fix anything?

You:    Yeah, the flaky test in auth
Relay:  On it…
Relay:  Pushed a fix to the PR branch. CI is running again.

You:    Deploy to staging when it passes
Relay:  Will do — I'll text you when it's live.
```

---

## Status

Relay is **early and building in public**. Today:

- ✅ iMessage gateway wired via Spectrum (`src/index.ts`)
- ✅ Architecture and roadmap documented
- 🚧 Relay core (Postgres, BullMQ, sessions)
- 🚧 Conversational agent + tool adapters
- 🚧 GitHubAgent, CodingAgent, ServerAgent implementations

We're looking for contributors who want to help shape the first open-source "text your infra" agent. See [Roadmap](#roadmap) and [Contributing](#contributing).

---

## Quick start

**Requirements:** [Bun](https://bun.sh), a [Photon](https://app.photon.codes) project (for iMessage cloud mode)

```sh
git clone https://github.com/Hanif-adedotun/relay.git
cd relay
bun install
```

Create `.env` (gitignored) with credentials from the [Photon dashboard](https://app.photon.codes):

```env
PROJECT_ID=...
PROJECT_SECRET=...
```

For GitHub App write flows (create branch, commit files, open PRs), the installed app needs:

- **Contents: Read and write**
- **Pull requests: Read and write**

Accept the permission update on the installation after changing these in the App settings.

Run:

```sh
bun start
# or hot reload
bun dev
```

Text your Relay line. You'll get an echo reply until the conversational layer lands — that's the hook to replace in `src/index.ts`.

---

## Roadmap

| Phase | Focus |
|---|---|
| 1 | Relay core — users by phone, sessions, Postgres, BullMQ |
| 2 | Conversational agent — scoped system prompt, intent routing |
| 3 | GitHubAgent — PR status, CI, workflow dispatch |
| 4 | CodingAgent — first backend (Cursor SDK or Claude Code) |
| 5 | ServerAgent — deploy + nginx/certbot/preview domains |
| 6 | Spectrum wiring — debounced pipeline, typing, async replies |
| 7 | MCP wrappers — optional tool servers for the ecosystem |

Details and example flows: **[architecture.md](./architecture.md#build-order)**

---

## Contributing

We'd love your help. Relay is designed as a **platform of adapters** — if you care about a specific agent, deployment stack, or infra tool, there's probably a clean place to plug it in.

**Great first contributions:**

- **GitHubAgent** — `gh` CLI or Octokit adapter; PR status as the first vertical slice
- **CodingAgent backend** — Claude Code, Cursor SDK, OpenClaw, Aider, OpenHands
- **ServerAgent** — SSH deploy scripts, GitHub Actions dispatch, nginx/certbot templates
- **Session store** — Postgres schema for users, sessions, grants
- **Conversational layer** — system prompt, scope guard, iMessage-native reply formatting
- **MCP servers** — expose GitHub / deploy / infra tools for Relay and other agents
- **Docs & examples** — setup guides, adapter templates, conversation fixtures

**Before you open a PR:**

1. Read [architecture.md](./architecture.md) — especially design principles and the tool interfaces
2. Keep changes focused; match existing TypeScript/Bun conventions
3. Never commit secrets (`.env`, tokens, SSH keys)
4. Open an issue first for large changes — we'd rather align early than rework

Questions or ideas? Open an issue with the **idea** or **help wanted** label. Half-baked thoughts welcome — that's how this project started.

---

## Project layout

```
relay/
├── src/
│   └── index.ts          # Spectrum iMessage entry (today: echo loop)
├── architecture.md       # Full system design & build order
├── AGENTS.md             # Agent/dev instructions for AI tooling
└── package.json
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | [Bun](https://bun.sh) + TypeScript |
| iMessage | [spectrum-ts](https://github.com/photon-hq/spectrum-ts) |
| API (planned) | Fastify |
| Queue (planned) | BullMQ |
| Database (planned) | PostgreSQL |
| Agents | Pluggable — Claude Code, Cursor SDK, OpenClaw, MCP, … |

---

## Links

- [Architecture & roadmap](./architecture.md)
- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [Photon dashboard](https://app.photon.codes) — iMessage project setup

---

## Star history

If Relay sounds like something you'd use — or want to build with us — **star the repo** and watch releases. We're building the agent we'd actually text from the train.
