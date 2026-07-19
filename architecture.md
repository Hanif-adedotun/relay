# Relay Architecture v2

> **Relay is a conversation-first orchestration platform for AI software engineering.**

---

# Vision

Relay enables developers to manage software projects entirely through natural conversations over messaging platforms.

Rather than building another coding agent, Relay orchestrates existing coding agents, language models, and MCP servers through a unified conversation engine.

The user should never think about models, APIs, or infrastructure.

Instead, they simply text:

> "Update the pricing page CTA to green, run the tests, deploy to staging."

Relay determines:

* Which repository is being referenced
* Which AI model should execute the task
* Which coding agent to use
* Which MCP servers are required
* How to safely execute the request
* When to notify the user

The conversation—not the model—is the primary interface.

---

# Core Design Principles

## Conversation First

Every interaction happens through a persistent conversation.

Relay remembers:

* Current project
* Current repository
* Current branch
* Current environment
* Preferred AI provider
* Previous deployments

Users should not repeatedly provide context.

---

## Agent Agnostic

Relay never couples itself to a single coding agent.

Supported agents include:

* OpenClaw
* Claude Code
* OpenHands
* Aider
* Future agent runtimes

Relay simply routes work.

---

## Model Agnostic

Relay does not own intelligence.

Models are interchangeable.

Supported providers:

* Groq (default)
* OpenAI
* Anthropic
* DeepSeek
* OpenRouter
* Local Models

Users may provide their own API keys.

---

## MCP Native

Relay never communicates directly with external systems.

Everything is performed through MCP servers.

This keeps Relay modular, secure, and extensible.

---

# High-Level Architecture

```text
                iMessage
                    │
                    ▼
        Spectrum Transport Layer
                    │
                    ▼
          Conversation Engine
                    │
                    ▼
        Conversation State Store
                    │
                    ▼
            Agent Runtime Layer
                    │
        ┌───────────┴────────────┐
        │                        │
        ▼                        ▼
 Language Model          Coding Agent
 (Groq/OpenAI/etc.)     (OpenClaw/etc.)
                    │
                    ▼
               MCP Client
                    │
 ┌──────────┬──────────┬──────────┬──────────┐
 │          │          │          │          │
GitHub    Vercel      AWS      Filesystem   Terminal
 MCP       MCP        MCP         MCP         MCP
```

---

# Layer 1 — Transport

Responsible only for receiving and sending messages.

Initial implementation:

* iMessage via Spectrum

Future transports:

* WhatsApp
* Slack
* Discord
* Telegram
* SMS

Relay core should never know where messages originate.

Interface:

```ts
interface Transport {
    receive()
    send()
}
```

---

# Layer 2 — Conversation Engine

This is the heart of Relay.

Responsibilities:

* Authentication
* Conversation history
* Context management
* Project selection
* Repository selection
* Model selection
* Agent routing
* Permission validation

The Conversation Engine is Relay's primary differentiator.

---

# Conversation State

Every conversation maintains structured state.

Example:

```yaml
conversation:

  user:
    id: hanif

  repository:
    active: relay

  branch:
    current: feature/chat

  deployment:
    target: staging

  model:
    provider: groq

  agent:
    provider: openclaw
```

This allows users to naturally continue conversations.

Example:

User:

> Deploy it.

Relay already knows what "it" refers to.

---

# Layer 3 — Agent Runtime

Responsible for executing engineering tasks.

Relay delegates execution to compatible coding agents.

Supported implementations:

* OpenClaw
* Claude Code
* OpenHands
* Aider

Interface:

```ts
interface CodingAgent {

    execute(task)

    stream()

    cancel()

}
```

Relay should never contain agent-specific logic.

Instead, adapters translate Relay requests into each agent's API.

---

# Layer 4 — Model Providers

Coding agents consume language models.

Relay ships with:

Default:

* Open Router Groq

Bring Your Own Model:

* OpenAI
* Anthropic
* DeepSeek
* OpenRouter

Users configure providers per:

* Account
* Repository
* Conversation

Example:

```yaml
repositories:

  relay:
    model: groq

  startup:
    model: claude

  client:
    model: gpt-5
```

---

# Layer 5 — MCP Client

Relay interacts with the outside world exclusively through MCP.

Relay never contains GitHub, AWS, or deployment logic.

Instead:

Conversation

↓

Agent

↓

MCP

↓

External System

---

# Supported MCP Servers

## GitHub MCP

Responsibilities:

* Clone repositories
* Create branches
* Push commits
* Create pull requests
* Review pull requests

---

## Filesystem MCP

Responsibilities:

* Read files
* Write files
* Search code
* Generate diffs

---

## Terminal MCP

Responsibilities:

* Install dependencies
* Run tests
* Execute builds

---

## Deployment MCP

Examples:

* Vercel
* Railway
* Fly.io
* Netlify

Responsibilities:

* Deploy
* Fetch preview URL
* View deployment status

---

## Cloud MCP

Examples:

AWS

DigitalOcean

Azure

GCP

Responsibilities:

* Restart services
* Deploy containers
* View logs
* Scale applications

Cloud MCP servers should operate under least-privilege IAM accounts.

Relay should never possess root-level infrastructure credentials.

---

# Security Model

Every MCP server exposes only approved capabilities.

Example:

Allowed:

* Deploy application
* Restart ECS task
* Read CloudWatch logs

Blocked:

* Delete VPC
* Delete database
* Modify IAM
* Destroy infrastructure

Security belongs inside each MCP implementation.

---

# Job Lifecycle

Incoming Message

↓

Conversation Context

↓

Task Generation

↓

Agent Selection

↓

Model Selection

↓

MCP Execution

↓

Job Complete

↓

Notify User

Jobs are asynchronous by default.

---

# Cost Strategy

Default Provider:

Groq

Reason:

* Extremely low inference cost
* Fast response times
* Excellent for orchestration

Premium users may connect:

* OpenAI
* Anthropic
* DeepSeek

Relay primarily monetizes orchestration rather than inference.

---

# Conversation Flow Example

User:

> Update the button on Project X.

Conversation Engine:

* Resolves Project X
* Retrieves current branch
* Uses OpenClaw
* Uses Groq
* Invokes GitHub MCP

Reply:

> Working on it.

Agent completes.

Deployment MCP executes.

Relay replies:

> Tests passed.

> Preview deployed:

> https://staging.example.com

---

# Future Capabilities

Because Relay is transport-agnostic and MCP-native, new capabilities become integrations rather than rewrites.

Future additions:

* Jira MCP
* Linear MCP
* Notion MCP
* Figma MCP
* Kubernetes MCP
* Docker MCP
* Stripe MCP
* Sentry MCP
* PagerDuty MCP

Relay becomes the conversational operating system sitting above an ecosystem of specialized tools.

---

# Engineering Philosophy

Relay should own:

* Conversations
* Context
* Orchestration
* Routing
* Authentication
* Notifications

Relay should never own:

* AI models
* Coding engines
* Cloud provider SDKs
* GitHub SDK implementations
* Deployment implementations

Everything external should be abstracted behind adapters or MCP servers.

This ensures Relay remains lightweight, extensible, and resilient as AI models, coding agents, and developer tooling continue to evolve.
