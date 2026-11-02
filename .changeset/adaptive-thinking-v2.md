---
"opencode-adaptive-thinking": minor
---

Port the plugin to the OpenCode V2 plugin API. The implementation now default-exports a
`Plugin.define` definition, registers the reasoning-effort tool and hooks on the V2
domains, and is distributed as a V2 server plugin.

**OpenCode 1 is no longer supported**: this package does not load in OpenCode 1.
