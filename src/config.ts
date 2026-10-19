export const defaultSystemPrompt =
  "Match reasoning effort to the work: lower it for routine or trivial turns, raise it for ambiguity, debugging, risky changes, or multi-step synthesis. " +
  "Use the per-turn recommendation when one is provided; otherwise call the tool only when the current level no longer fits the task.";

export type Config = {
  enabled: boolean;
  quiet: boolean;
  autoSelect: boolean;
  toolName: string;
  toolDescription: string;
  systemPrompt: string;
};

const defaults: Config = {
  enabled: true,
  quiet: false,
  autoSelect: false,
  toolName: "set_reasoning_effort",
  toolDescription: "Set your reasoning effort",
  systemPrompt: defaultSystemPrompt,
};

export const parseConfig = (options: unknown): { config: Config } | { error: string } => {
  if (options === undefined) return { config: { ...defaults } };
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return { error: "options must be an object" };
  }

  const input = options as Record<string, unknown>;
  const config = { ...defaults };

  for (const key of ["enabled", "quiet", "autoSelect"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { error: `${key} must be a boolean` };
    config[key] = value;
  }

  for (const key of ["toolName", "toolDescription", "systemPrompt"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return { error: `${key} must be a string` };
    config[key] = value;
  }

  return { config };
};
