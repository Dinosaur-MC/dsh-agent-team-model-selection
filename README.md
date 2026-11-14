# dsh-agent-team-model-selection

User-facing model switching for **DSH Agent Teams teammates and addressed subagents**.

- **Host**: local HTTP API (`/dsh-teammate-model/*`) that accepts an addressed subagent/teammate, checks the model route against the live LLM registry and the profile's delegation allowlist, and applies it through the Agent model facade.
- **UI**: the official `ModelSelect` component (copied/adapted from `dsh-client-ui-model-selection`) mounted directly in `conversation.input.right`. It uses the official catalog, official trigger/menu styling and anchoring, and keeps the selected route in a per-session remembered selection so reopening the picker does not snap back to the stale projection while a dormant teammate is pending. It does not touch, hide or re-position `conversation.input.model`, does not portal the trigger/seat (only the official menu surface is portaled), and does not change z-index. The official main-session picker stays untouched.

## Why this shape

The official `conversation.input.model` seat is hidden for addressed subagent sessions, and `session/selectModel` refuses subagent-owned sessions. This plugin adds a separate right-slot seat and a host route; it does not replace the official picker or the official plugin row.

## Compatibility

- DSH `0.2.2-rc.1` through `0.2.2-rc.3`; `0.2.2-rc.3` is the verified runtime.
- rc3 removed `useAnchoredPosition` from the client primitives. The picker keeps the official hook when present and falls back to local fixed positioning when it is not.
- The seat stays in `conversation.input.right`; no position or z-index override is applied.

## Host API

    GET  /dsh-teammate-model/health
    GET  /dsh-teammate-model/state?sessionId=<id>&parentSessionId=<parent>
    POST /dsh-teammate-model/select   { sessionId, parentSessionId?, provider, model, reasoningEffort? }

All routes are loopback-only.

## Install

```shell
dsh plugin --profile web add dsh-agent-team-model-selection
```

## Subagent support

The same right-slot seat is mounted for any addressed subagent session, including Agent Teams teammates and ordinary subagent children. The host accepts a durable `origin: subagent` header (or the client-provided parent address when the live header is unavailable), stores the choice, and re-applies it when the child activates.

## Boundaries

- Target must be an addressed subagent session; top-level sessions are refused.
- Route must be registered and, when `subagentModelSelection` is enabled, present in its allowlist.
- The right slot is the extension point; the official `conversation.input.model` single slot is never registered or hidden.
- If the Agent model facade is unavailable at `agent/created` on a future DSH version, the host falls back to the durable `model/selection` session event; re-verify on DSH upgrades.
