<div align='center'>
    <br/>
    <br/>
    <h3>opencode-adaptive-thinking</h3>
    <p>Adaptive Thinking Plugin for OpenCode.</p>
    <a href="https://www.npmjs.com/package/opencode-adaptive-thinking"><img src="https://img.shields.io/npm/v/opencode-adaptive-thinking?style=for-the-badge&logo=npm&label=npm&color=cb3837" alt="npm version" /></a>
    <br/>
    <br/>
</div>

## Overview

`opencode-adaptive-thinking` is an OpenCode plugin that lets agents actively adjust model reasoning effort during a session.

The plugin injects adaptive-thinking guidance into the system prompt and exposes a tool for switching to one of the current model's valid reasoning-effort variants.

## Requirements

- OpenCode `2` with a plugin runtime compatible with `@opencode/plugin` `2.0.30`.
- A selected model that exposes reasoning-effort variants such as `none`, `low`, `medium`, `high`, or `xhigh`.

## Installation

Add the package to your OpenCode config plugin list:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-adaptive-thinking"]
}
```

To customize behavior, use the object form shown in the configuration example below.

## Configuration

The plugin accepts these optional settings:

- `enabled`: enable or disable the plugin without removing it from config. Defaults to `true`.
- `quiet`: suppress the generic configuration error message. Details go to the server process output (stderr) and the last one is recorded under the `lastDiagnostic` storage key. Defaults to `false`.
- `toolName`: name of the reasoning-effort tool exposed to agents. Defaults to `set_reasoning_effort`.
- `toolDescription`: description for the reasoning-effort tool. Defaults to `Set your reasoning effort`.
- `systemPrompt`: custom adaptive-thinking guidance injected into the system prompt.
- `triggers` (optional): when to inject the guidance and run the classifier. Fields: `afterIdle` and `afterUserMessage` (booleans). Omit `triggers` for the original behavior (guidance on every request); both `false` disables the guidance.
- `classifier` (optional): an LLM classifier that chooses the effort on real user messages. Disabled by default. Fields: `enabled` (boolean) and `model` (`{ providerID, modelID }`, default `opencode/big-pickle`).

### Triggers and classifier

`triggers` scopes when the guidance is injected:

- `afterIdle`: first request after an idle or session start, when no user message is pending.
- `afterUserMessage`: first request after a real user message.

Both are reset when a session execution ends (success, failure, or interruption). Omit `triggers` for the original behavior (guidance on every request). Both `false` disables the guidance.

When `classifier.enabled` is true, the plugin asks the configured model for one valid effort level on real user messages. It uses the same guidance as its system prompt, then the last compaction summary or the messages since session start/last idle, then the current message last. The call is a stateless generation request with no tools and a 5 s timeout; it fails open, so the request keeps its current level and no error reaches the request or the TUI; classifier failures print to stderr only the first time, and every failure is recorded as the last diagnostic. A malformed successful answer is reported as an invalid classifier response. The chosen level is applied to the request that carries the user message and, unless a tool call or explicit variant choice changes it, re-derived for later primary requests in the same turn: the plugin copies the selected catalog variant's request settings into each such request's options and applies the variant's headers or body overrides through request-scoped hooks, on every transport attempt of that call. A variant declares a body override as `extraBody` in its catalog settings (the host exposes it as the variant's `body`); `headers` is applied as-is. The request model ref is stamped with the level so the assistant message records the variant that was actually used, but the level is never written to the session model. The plugin does not override later user or agent variant choices, and it does not claim a level when the catalog has no matching variant or the variant carries no applicable request settings. When the request model exposes variants, the main session still receives the guidance at the triggers.

The `http.request` hook covers the documented HTTP path. A variant whose only mapping is a `body` override is not applied to `experimental.ws.*` requests.

Classifier context comes from `session.context`, which returns the full session history.

```json
"triggers": {
  "afterIdle": true,
  "afterUserMessage": true
},
"classifier": {
  "enabled": true,
  "model": { "providerID": "opencode", "modelID": "big-pickle" }
}
```

Synthetic messages never reach the prompt hook, and synthetic transcript entries are excluded from the classifier context. The classifier sends the user's request text and session context to the configured model; keep it disabled if that is not acceptable.

Session state is kept in a 5,000-entry LRU and expires after seven days of inactivity; deleted sessions are removed.

### Configuration example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-adaptive-thinking",
      "options": {
        "enabled": true,
        "quiet": false,
        "toolName": "set_reasoning_effort",
        "toolDescription": "Set your reasoning effort",
        "systemPrompt": "Actively choose the lowest reasoning effort that can safely complete the task. Raise effort for ambiguity, debugging, risky changes, or multi-step synthesis.",
        "triggers": {
          "afterIdle": true,
          "afterUserMessage": true
        }
      }
    }
  ]
}
```

## Behavior

Agents receive system guidance to actively choose the lowest reasoning effort that can safely complete the task. The plugin also exposes the configured tool, `set_reasoning_effort` by default, with these arguments:

- `level`: one of the valid reasoning-effort variants for the current model.
- `persist`: when `true`, keep the selected effort for the session. When `false` or omitted, apply it temporarily and reset at session idle to the session's own variant from before the tool call (a classified level is request-scoped and is not the reset target).

Example temporary change:

```json
{
  "level": "high",
  "persist": false
}
```

Example persisted change:

```json
{
  "level": "low",
  "persist": true
}
```

The system prompt lists the valid levels for the current session. A remembered level is only reused when the current model still supports it, so switching models will not reuse an invalid effort level. Message lookups now read full session history; the former 20-message limit is gone, so long sessions cost more.

Adaptive-thinking guidance is appended to the existing system instructions as an additional text part instead of a separate system message, so strict chat templates that allow only one system message keep working.

## Troubleshooting

Plugin output is written to the server process console (stderr). It is not part of `opencode.log` or the structured `--print-logs` log stream; when the server's stderr is captured, it appears there as raw lines. Repeated warnings (classifier, model-switch, and request-body) print once; errors print every time; every failure updates `lastDiagnostic`. The plugin also records the most recent warning or error under the `lastDiagnostic` key in plugin storage as `{ at, level, message }`, so a failure can be inspected after the fact. Classifier failures fail open: the request proceeds without a classified level.

If the tool returns `no valid reasoning effort levels are available for this session`, check that the active model exposes variants in OpenCode. Some providers or models may not support reasoning-effort levels.

If the tool returns `Invalid reasoning effort level`, use one of the levels listed in the system prompt for the current session.

If configuration errors appear, check the plugin options against the documented keys and value types. Set `quiet` to `true` to suppress the generic configuration error message; details are written to the server process output (stderr), not to `opencode.log`. OpenCode 2 does not expose a TUI toast API to server plugins, so configuration errors are logged instead.

## Development

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```
