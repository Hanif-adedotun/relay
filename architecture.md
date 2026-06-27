# Agent Architecture

## Overview

Relay is an orchestration layer between iMessage and external execution backends. It does not perform software engineering, GitHub operations, or server administration directly — it classifies inbound messages, enqueues work, and delegates to the appropriate **tool adapter**.

Relay exposes three first-class tools:

| Tool | Responsibility |
|---|---|
| **Conversational Agent** | Scoped LLM face of Relay — natural replies, context, refusals, tool routing |
| **CodingAgent** | Code changes in a repository — fix bugs, open/update PRs, run tests |
| **GitHubAgent** | GitHub read/write — PR status, CI checks, merges, workflow dispatch |
| **ServerAgent** | Infrastructure and deployment — SSH deploys, nginx, certbot, preview-per-branch domains |
| **Spectrum (iMessage Gateway)** | Delivers messages to/from the user's phone; provides sender phone + conversation thread |

Each tool implements a shared **Relay Tool Interface**. Tools may be backed by direct API clients (`gh`, Octokit, SSH runners, or **MCP servers** that expose the same capabilities as callable tools.

Relay is **conversational first**. The user texts naturally from their phone; Relay remembers who they are, what you were just talking about, and replies in plain language — not API dumps. Long-running work streams back as short status messages and typing indicators, the way a colleague would text updates.

---

## Design principles

| Principle | What it means |
|---|---|
| **Conversational** | Replies read like iMessage, not logs. Clarify ambiguity ("Which repo — `project-a` or `project-b`?") instead of failing silently. |
| **Identity by phone** | The sender's phone number is the primary user key. No separate login — if you text Relay, we know who you are. |
| **Session-aware** | Each conversation thread carries working context: active repo, last PR discussed, pending confirmation, connected GitHub account. |
| **Scoped capability** | Relay only handles coding, GitHub, deploy, and infra tasks. Everything else gets a polite, in-character refusal. |
| **Async but present** | Jobs run in the background; the user always gets an immediate ack and ongoing progress, never silence. |

---

## End-to-end flow

```
iPhone
   │
iMessage
   │
   ▼
┌──────────────────┐
│ iMessage Gateway │  ← spectrum-ts + @spectrum-ts/imessage (src/index.ts)
└──────────────────┘
   │
   ▼
┌──────────────────┐
│      Relay       │  ← Fastify API (or in-process module)
│ Conversational   │  ← system prompt, scope guard, natural replies
│ Agent + Session  │  ← phone → user, thread → context
└──────────────────┘
   │
   ├──────────────────┐
   ▼                  ▼
PostgreSQL          BullMQ
(users by phone,     (async jobs:
 sessions,           code, github, deploy, infra)
 repo/server grants,
 jobs, audit)
                         │
                         ▼
                  ┌─────────────┐
                  │ Tool Router │
                  └─────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   CodingAgent     GitHubAgent      ServerAgent
         │               │               │
         ▼               ▼               ▼
   Claude Code /    GitHub API /     SSH / Ansible /
   OpenClaw /       gh CLI /         nginx / certbot /
   Cursor SDK /      GitHub App       GitHub Actions
   Aider / OpenHands
         │               │               │
         └───────────────┴───────────────┘
                         │
                         ▼
                  iMessage reply
                  (status, links, confirmations)
```

---

## iMessage Gateway (Spectrum)

The entry point today is `src/index.ts`. Spectrum provides:

- **Inbound** — `app.messages` yields `[space, message]` pairs
- **Outbound** — `space.send(...)`, typing indicators, reactions
- **Connectivity** — cloud (managed line), local (macOS Messages DB), or dedicated relay

Spectrum is the **phone interface only**. It does not talk to GitHub, run agents, or SSH into servers. The echo loop in `index.ts` will be replaced with: enqueue inbound messages → async workers reply via `space.send()`.

Production patterns (debounce, batch flush, in-flight cancellation, idempotent send) apply here — see the bundled `spectrum` skill.

On each inbound message, Spectrum provides:

- `message.sender.id` — the sender's phone number (E.164), used as the **user identity key**
- `space` — the conversation thread, used as the **session key** (DM or group)

---

## User identity (phone number)

Every inbound message is attributed to a sender. On iMessage, `message.sender.id` is their phone number.

```
+15551234567  →  users.phone  →  user record in Postgres
```

On first contact:

1. Normalize the number to E.164
2. Look up or create a `users` row keyed by phone
3. Load their grants (repos, servers, GitHub connection) and preferences (default repo, preferred CodingAgent backend)

Unknown numbers can be rejected or held in a pending state until an admin allowlists them.

For **group chats**, the session is still keyed by `space.id`, but actions are attributed to the individual sender's phone. Group permissions may require all participants to be allowlisted, or restrict write actions to the space owner.

---

## Session and context

A **session** is the live state of a conversation thread (`space.id`). It is what makes Relay feel continuous — the user can say "fix that" or "deploy it" without repeating repo names every time.

Sessions are stored in Postgres and updated after every turn.

| Session field | Purpose |
|---|---|
| `active_repo` | Repository currently in focus (e.g. `org/project-a`) |
| `active_pr` | Last PR discussed (number, branch, URL) |
| `active_branch` | Branch in focus for deploy/preview |
| `active_env` | `staging` / `production` / preview domain |
| `pending_confirmation` | Destructive action awaiting "YES" (deploy prod, merge, nginx reload) |
| `recent_turns` | Rolling window of user + assistant messages for LLM context |
| `open_jobs` | In-flight BullMQ jobs tied to this session |

**Session resolution examples:**

| User says | Session supplies |
|---|---|
| "What's the status?" | `active_pr` from earlier in the thread |
| "Deploy it" | `active_repo` + `active_branch` + confirm if prod |
| "Switch to project-b" | Updates `active_repo`; clears stale PR/branch refs |
| "Yes" | Matches `pending_confirmation` and executes the held action |

Sessions expire after idle timeout (e.g. 24h) or can be explicitly reset ("start over", "clear context"). Expired sessions fall back to the user's default repo.

**Integration connections** (GitHub token, SSH host keys, server credentials) live on the **user** record, not the session. The session only holds *which* repo/server is active right now; the user record holds *whether* they are allowed and *how* to authenticate.

---

## Conversational agent and intent routing

Relay's conversational layer is an LLM-backed agent with a fixed **system prompt** and access to the three tools. It is not a general assistant.

### Scope (system prompt)

The system prompt defines what Relay can and cannot do. In-scope tasks:

- **query** — PR status, CI checks, branch/release info (GitHubAgent)
- **code** — fix bugs, write code, open/update PRs, run tests (CodingAgent)
- **deploy** — ship to staging/production, trigger workflows (ServerAgent)
- **infra** — nginx, certbot, preview domains linked to branches (ServerAgent)

**Out of scope** — weather, general knowledge, unrelated coding help, personal advice, anything that does not involve the user's connected repos or servers:

> "I can only help with your repos and servers — things like PR status, code fixes, deploys, and nginx/certs. Want to check on a PR or deploy something?"

The refusal should stay conversational and short, not a policy wall. Optionally suggest the nearest in-scope action if one is obvious.

### Routing

Each turn, the conversational agent:

1. Loads **user** (by phone) and **session** (by space)
2. Builds prompt context: system prompt + user grants + session fields + recent turns
3. Decides: reply directly, ask a clarifying question, refuse (out of scope), or invoke a tool
4. Updates session with anything new (repo switched, PR mentioned, confirmation pending)
5. Sends the reply via `space.send()` — or enqueues a BullMQ job and acks immediately ("On it — I'll text you when CI finishes")

| Intent | Examples | Routed to |
|---|---|---|
| **query** | "What's the stage of PR #42?", "Did CI pass?" | GitHubAgent |
| **code** | "Fix the failing test", "Open a PR for this" | CodingAgent |
| **deploy** | "Deploy main to production", "Ship staging" | ServerAgent (deploy) |
| **infra** | "Add nginx vhost for preview.example.com", "Create cert for this domain" | ServerAgent (infra) |
| **out_of_scope** | "What's the weather?", "Write me a poem" | Conversational agent (polite refusal, no tool call) |
| **clarify** | "Deploy it" (no repo set) | Conversational agent asks; no tool call yet |

Destructive or production-affecting actions set `pending_confirmation` on the session and require an explicit reply (e.g. "Reply YES to deploy main to prod").

### Conversational tone

- Keep messages short — this is iMessage, not email
- Use `space.responding()` / typing indicators while thinking or waiting on tools
- Stream progress on long jobs ("Pushed the fix", "CI running…", "Deployed ✅")
- Include links when helpful (PR URL, preview domain)
- Remember prior context so the user does not repeat themselves

---

## Tool adapters

### CodingAgent

Handles repository-level software engineering tasks.

**Backends** (pluggable, one per user/repo/task):

| Backend | Notes |
|---|---|
| Claude Code | Local or remote execution |
| OpenClaw | Open-source coding agent framework |
| OpenHands | Open-source software engineering agent |
| Aider | Terminal-based coding assistant |
| Cursor SDK | Programmatic agent via `@cursor/sdk` |
| Future | Any backend implementing the interface |

```typescript
interface CodingAgent {
  execute(repository: Repository, task: Task): Promise<JobResult>
}
```

Typical tasks: fix a failing test, implement a feature, open or update a PR, run the test suite.

---

### GitHubAgent

Handles GitHub-specific read and write operations without touching the codebase directly.

**Capabilities:**

- PR status — reviews, checks, merge state, CI/CD status
- PR lifecycle — open, close, merge (with confirmation)
- Workflow dispatch — trigger GitHub Actions via `workflow_dispatch`
- Repo metadata — branches, releases, issue lookup

**Implementation options:** `gh` CLI, Octokit / GitHub App, or an MCP server wrapping the above.

Typical tasks: "What's the stage of this PR?", "Close PR #12", "Re-run the deploy workflow".

---

### ServerAgent

Handles deployment and infrastructure on user-authorized servers.

**Deploy capabilities:**

- Trigger CI/CD (GitHub Actions `workflow_dispatch`)
- Direct deploy — SSH pull/build/restart, health check
- Preview deploy — build a branch, expose at a subdomain linked to that branch

**Infra capabilities:**

- nginx — add/change vhost configs from versioned templates
- certbot — issue/renew TLS certs for new domains
- Domain ↔ branch mapping — e.g. `feature-login.staging.example.com` → branch `feature/login`

**Implementation options:** SSH + shell scripts, Ansible, or an MCP server exposing deploy/infra tools.

All server access is scoped per user and per environment (staging vs production). Credentials live outside the repo (env / secrets store), never committed.

---

## MCP as a tool wrapper (optional)

The three tools may be exposed as **MCP servers** so Relay (or a CodingAgent backend) invokes them uniformly:

```
Relay → MCP client → CodingAgent MCP server   (repo operations)
                 → GitHubAgent MCP server  (PR status, merge, workflow dispatch)
                 → ServerAgent MCP server   (deploy, nginx, certbot)
```

Benefits:

- Same tool surface whether Relay calls them directly or a CodingAgent uses them mid-task
- Tools are testable and swappable independently of Relay
- Aligns with Cursor / Claude Code MCP ecosystems

Relay's **Tool Router** resolves intent → tool name → MCP call (or direct adapter). The interface contract is the same either way.

---

## Agent / tool selection

Users configure backends at three levels:

| Level | Example |
|---|---|
| Per user | Default agent: `claude-code` |
| Per repository | `project-a` → Cursor SDK, `project-b` → OpenClaw |
| Per task | Short fix → Aider, large refactor → OpenHands |

```yaml
project-a:
  coding: claude-code
  github: gh-cli
  server: ssh-staging
project-b:
  coding: cursor-sdk
  github: github-app
  server: ansible-prod
```

---

## Relay core

Shared infrastructure all tools depend on.

| Component | Role |
|---|---|
| **Fastify API** | HTTP surface for webhooks, admin, health checks; may run in-process with Spectrum initially |
| **PostgreSQL** | Users (keyed by phone), sessions (per space), repo/server grants, integration tokens, job records, deployment history, audit log |
| **BullMQ** | Async job queue for code, github, deploy, and infra work — with retries, cancellation, and progress events |
| **User identity** | Phone number from `message.sender.id` → user record, grants, and stored connections (GitHub, SSH) |
| **Sessions** | Per-`space.id` working context — active repo/PR/branch, pending confirmations, recent turns |
| **Conversational agent** | LLM with scoped system prompt; routes to tools or refuses out-of-scope requests |
| **Job lifecycle** | `queued → running → succeeded / failed` with iMessage progress updates |
| **Spectrum wiring** | Inbound enqueue; workers call `space.send()` and typing indicators while jobs run |
---

## Example flows

### First message from a new number

```
iMessage from +15551234567 → Spectrum
  → normalize phone → create/find user
  → new session for this space
  → space.send("Hey — I'm Relay. I can check PRs, fix code, deploy, and manage nginx/certs on your servers. Which repo should we start with?")
```

### Out-of-scope question

```
User: "What's the capital of France?"
  → Conversational agent (system prompt: out of scope)
  → space.send("I can only help with your repos and servers — PRs, code fixes, deploys, nginx, that kind of thing. Want to check on something in GitHub?")
  → no tool call; session unchanged
```

### Session continuity — "what about that one?"

```
[earlier] User: "How's PR 42 on project-a?"
           Relay: "PR #42: CI green, 1 approval needed…"
           → session.active_repo = project-a, session.active_pr = 42

[later]  User: "Can you fix the failing test?"
           → session supplies repo + PR; no need to re-ask
           → CodingAgent.execute(project-a, { fix-pr: 42 })
```

### "What's the stage of PR #42?"

```
iMessage → Spectrum → Relay enqueue
  → resolve user (+1555…) + session (space)
  → Intent: query → GitHubAgent.getPrStatus(repo, 42)
  → session.active_repo = project-a, session.active_pr = 42
  → space.send("PR #42: checks pending, 1 approval needed, CI green ✅")
```

### "Fix the failing test on PR 42"

```
iMessage → Spectrum → Relay enqueue
  → Intent: code
  → CodingAgent.execute(repo, { type: "fix-pr", pr: 42 })
  → progress via typing indicator + status messages
  → GitHubAgent may be called mid-task (re-check CI)
  → space.send("Pushed fix to branch fix/pr-42-tests. CI running…")
```

### "Deploy main to production"

```
iMessage → Spectrum → Relay enqueue
  → Intent: deploy
  → confirm("Deploy main to prod? Reply YES")
  → ServerAgent.deploy({ env: "production", ref: "main" })
  → space.send("Deployed v1.2.3 to prod ✅ https://…")
```

### "Point login.staging.example.com at branch feature/login"

```
iMessage → Spectrum → Relay enqueue
  → Intent: infra + deploy
  → ServerAgent.previewDeploy({ branch: "feature/login", domain: "login.staging.example.com" })
    → build branch
    → nginx vhost from template
    → certbot if needed
    → reload nginx
  → space.send("Live at https://login.staging.example.com (branch: feature/login)")
```

---

## Build order

Implement in this sequence. Each phase delivers a testable slice before the next layer depends on it.

### 1. Relay core

Fastify (or in-process module), PostgreSQL, BullMQ, user identity, sessions.

- Schema: `users` (phone primary key), `sessions` (space id), `repo_grants`, `server_grants`, `integration_connections`, `jobs`
- Resolve user from `message.sender.id` on every inbound message
- Create/load session from `space.id`; persist `active_repo`, `active_pr`, `pending_confirmation`, recent turns
- Basic job enqueue / worker skeleton
- Health check endpoint

### 2. Conversational agent + intent router

LLM with scoped system prompt; classify and route inbound messages.

- System prompt: in-scope tasks only; conversational refusal for everything else
- Load user grants + session context into every turn
- Route: **query** / **code** / **deploy** / **infra** / **clarify** / **out_of_scope**
- Confirmation gate for destructive actions via `pending_confirmation` on session
- Short, iMessage-native reply formatting

### 3. GitHubAgent adapter

Read PR/CI status; optional write via `gh` or GitHub App.

- First vertical slice: answer "what's the stage of this PR?"
- Then: merge, close, workflow_dispatch

### 4. First CodingAgent adapter

e.g. Cursor SDK or Claude Code for "fix this PR".

- Implement `CodingAgent` interface for one backend
- Wire to BullMQ; stream progress back to iMessage

### 5. Deploy adapter (ServerAgent — deploy)

GitHub Actions `workflow_dispatch` and/or SSH deploy script.

- Staging first; production behind confirmation
- Record deployment history in Postgres

### 6. Infra adapter (ServerAgent — infra)

nginx / certbot via SSH + templates; preview-per-branch.

- Versioned nginx templates in repo or Relay config
- Preview subdomain ↔ branch mapping
- Rollback path for bad nginx reloads

### 7. Wire Spectrum

Replace echo loop with enqueue + async replies.

- Debounced inbound pipeline (see spectrum best-practices skill)
- Typing indicators while jobs run
- Stable client GUIDs for idempotent sends

### 8. MCP wrappers (optional, parallel-friendly)

Expose CodingAgent, GitHubAgent, ServerAgent as MCP servers.

- Can start after step 3–6 interfaces are stable
- Lets CodingAgent backends reuse GitHub/Server tools mid-task

---

## Security notes

- Never commit `.env`, GitHub tokens, or SSH keys
- **Phone allowlisting** — reject or quarantine unknown numbers; tie all grants to verified phone identity
- Scope GitHub App / `gh` tokens to minimum required permissions
- Separate staging and production server credentials
- Audit log every tool invocation (phone, session, repo/server, outcome)
- Rate-limit and cap concurrent agent runs per user
- Session data may contain repo/PR context — treat as sensitive; expire idle sessions

---

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts) — iMessage gateway
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
- Bundled `spectrum` skill — production messaging patterns
- Cursor SDK skill — if using Cursor as CodingAgent backend
