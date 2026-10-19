import { tool, type Plugin } from "@opencode-ai/plugin";
import type { Message, Part, Provider } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { parseConfig } from "./config.js";
import { classifyPrompt, pickVariant } from "./complexity.js";

const z = tool.schema;
const serviceName = "opencode-adaptive-thinking";
const maxSessionStateSize = 500;
const historyLimit = 20;

type ModelInfo = { providerID: string; modelID: string };
type SessionMessage = { info: Message; parts: Array<Part> };
type SessionState = {
  variant?: string;
  recommendation?: string;
  locked?: boolean;
  reset?: { level: string; agent: string; model?: ModelInfo };
};

class SessionStateCache {
  private readonly entries = new Map<string, SessionState>();

  constructor(private readonly maxSize: number) {}

  get(sessionID: string) {
    const entry = this.entries.get(sessionID);
    if (!entry) return;

    this.entries.delete(sessionID);
    this.entries.set(sessionID, entry);
    return entry;
  }

  update(sessionID: string, update: (entry: SessionState) => void) {
    const entry = this.get(sessionID) ?? {};
    update(entry);
    this.entries.set(sessionID, entry);

    if (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
  }
}

const state = new SessionStateCache(maxSessionStateSize);

type PromptAsyncBody = NonNullable<
  Parameters<OpencodeClient["session"]["promptAsync"]>[0]["body"]
> & { variant: string };

export const AdaptiveThinkingPlugin: Plugin = async ({ client }, options) => {
  const logError = (message: string, error: unknown) =>
    client.app.log({
      body: {
        service: serviceName,
        level: "error",
        message: `${message}: ${JSON.stringify(error)}`,
      },
    });

  const parsed = parseConfig(options);
  if ("error" in parsed) {
    if (options?.quiet !== true) {
      client.tui.showToast({
        body: {
          variant: "error",
          message: "Invalid Adaptive Thinking plugin configuration, see logs for details",
        },
      });
    }
    logError("Invalid Adaptive Thinking plugin configuration", parsed.error);
    return {};
  }

  const config = parsed.config;
  if (!config.enabled) return {};

  const getModelVariants = (model: unknown) => {
    const variants = (model as { variants?: Record<string, unknown> } | undefined)?.variants;
    return Object.keys(variants ?? {});
  };

  let providers: Array<Provider> | undefined;

  const variantsFor = async (model: ModelInfo) => {
    if (!providers) {
      const response = await client.provider.list();
      if (response.error) {
        logError("Failed to retrieve providers", response.error);
        return [];
      }
      providers = (response.data?.all ?? []) as unknown as Array<Provider>;
    }
    const provider = providers.find((candidate) => candidate.id === model.providerID);
    return getModelVariants(provider?.models[model.modelID]);
  };

  const fetchMessages = async (sessionID: string) => {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { limit: historyLimit },
    });
    if (response.error) {
      logError(`Failed to retrieve messages for session ${sessionID}`, response.error);
      return;
    }
    return (response.data ?? []) as Array<SessionMessage>;
  };

  const modelOf = (info: Message): ModelInfo =>
    "model" in info
      ? { providerID: info.model.providerID, modelID: info.model.modelID }
      : { providerID: info.providerID, modelID: info.modelID };

  const latestModel = (messages: Array<SessionMessage>): ModelInfo | undefined => {
    const last = messages.at(-1)?.info;
    return last ? modelOf(last) : undefined;
  };

  const latestVariant = async (messages: Array<SessionMessage>) => {
    let agent: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]!.info;
      const variant = "model" in info ? info.model.variant : info.variant;
      if (variant) return variant;
      agent ??= info.agent;
    }
    if (!agent) return;

    const response = await client.app.agents();
    if (response.error) {
      logError("Failed to retrieve agents", response.error);
      return;
    }
    const match = response.data?.find((candidate) => candidate.name === agent) as
      | { variant?: string }
      | undefined;
    return match?.variant;
  };

  const promptText = (parts: Array<Part>) => {
    if (parts.some((part) => part.type === "text" && part.ignored)) return;
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text.length > 0 ? text : undefined;
  };

  const followUp = /^(continue|go on|proceed|next|yes|ok|okay|sure|do it|go ahead|thanks)\b/i;
  const isFollowUp = (text: string) => text.length < 60 && followUp.test(text);

  const sendVariantPrompt = (
    sessionID: string,
    variant: string,
    text: string,
    agent: string,
    model?: ModelInfo,
  ) =>
    client.session.promptAsync({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text, synthetic: true, ignored: true }],
        agent,
        variant,
        ...(model ? { model } : {}),
      } as PromptAsyncBody,
    });

  return {
    tool: {
      [config.toolName]: tool({
        description: config.toolDescription,
        args: {
          level: z
            .string()
            .describe(
              "The level of reasoning effort to apply. Higher levels may result in more accurate and thoughtful responses, but may also take more time and resources.",
            ),
          persist: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Whether to persist the setting for this session, otherwise it will only apply for the remainder of the current turn",
            ),
        },
        execute: async ({ level, persist }, { sessionID, agent }) => {
          const messages = await fetchMessages(sessionID);
          if (!messages) return "Failed to set reasoning effort: could not read the session";

          const model = latestModel(messages);
          const variants = model ? await variantsFor(model) : [];
          if (variants.length === 0) {
            return "Failed to set reasoning effort: no valid reasoning effort levels are available for this session";
          }
          if (!variants.includes(level)) {
            return `Invalid reasoning effort level: ${level}. Valid levels: ${variants.join(", ")}.`;
          }

          const baseline =
            state.get(sessionID)?.reset?.level ??
            state.get(sessionID)?.variant ??
            (await latestVariant(messages));
          const response = await sendVariantPrompt(
            sessionID,
            level,
            `Reasoning effort set to ${level}`,
            agent,
            model,
          );
          if (response.error) {
            return `Failed to set reasoning effort: ${JSON.stringify(response.error)}`;
          }

          state.update(sessionID, (entry) => {
            entry.variant = level;
            if (persist) entry.locked = true;
            else delete entry.locked;
            delete entry.recommendation;
            if (persist || !baseline || baseline === level || !variants.includes(baseline)) {
              delete entry.reset;
            } else {
              entry.reset ??= { level: baseline, agent, ...(model ? { model } : {}) };
            }
          });

          return `Reasoning effort set to ${level}`;
        },
      }),
    },
    "chat.message": async ({ sessionID, variant }, { message, parts }) => {
      const text = promptText(parts);
      if (text === undefined) return;

      const variants = await variantsFor(message.model);
      const session = state.get(sessionID);
      const cached = session?.variant;
      const current = cached && variants.includes(cached) ? cached : undefined;

      if (config.autoSelect) {
        if (variant) {
          (message.model as { variant?: string }).variant = variant;
          state.update(sessionID, (entry) => {
            entry.variant = variant;
            entry.locked = true;
            delete entry.recommendation;
          });
          return;
        }

        if (!current) {
          const level = pickVariant(variants, classifyPrompt(text));
          if (!level) return;
          (message.model as { variant?: string }).variant = level;
          state.update(sessionID, (entry) => {
            entry.variant = level;
            delete entry.locked;
            delete entry.recommendation;
          });
          return;
        }

        if (isFollowUp(text)) {
          (message.model as { variant?: string }).variant = current;
          state.update(sessionID, (entry) => {
            delete entry.recommendation;
          });
          return;
        }

        const recommended = pickVariant(variants, classifyPrompt(text));
        const up = recommended && variants.indexOf(recommended) > variants.indexOf(current);
        if (up && !session?.locked) {
          (message.model as { variant?: string }).variant = recommended;
          state.update(sessionID, (entry) => {
            entry.variant = recommended;
            delete entry.recommendation;
          });
          return;
        }

        (message.model as { variant?: string }).variant = current;
        state.update(sessionID, (entry) => {
          if (recommended && recommended !== current) entry.recommendation = recommended;
          else delete entry.recommendation;
        });
        return;
      }

      const currentValue = variant ?? (message.model as { variant?: string }).variant;
      if (currentValue) {
        state.update(sessionID, (entry) => {
          entry.variant = currentValue;
        });
      }
      if (isFollowUp(text)) {
        state.update(sessionID, (entry) => {
          delete entry.recommendation;
        });
        return;
      }

      const recommended = pickVariant(variants, classifyPrompt(text));
      state.update(sessionID, (entry) => {
        if (recommended) entry.recommendation = recommended;
        else delete entry.recommendation;
      });
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const sessionID = event.properties.sessionID;
      const session = state.get(sessionID);
      if (!session) return;

      if (session.recommendation) {
        state.update(sessionID, (entry) => {
          delete entry.recommendation;
        });
      }

      const reset = session.reset;
      if (!reset) return;

      const response = await sendVariantPrompt(
        sessionID,
        reset.level,
        `Reasoning effort reset to ${reset.level}.`,
        reset.agent,
        reset.model,
      );
      if (response.error) {
        logError("Failed to reset reasoning effort on session idle", response.error);
        return;
      }

      state.update(sessionID, (entry) => {
        entry.variant = reset.level;
        delete entry.reset;
      });
    },
    "experimental.chat.system.transform": async ({ sessionID, model }, { system }) => {
      if (!sessionID) return;

      let variants = getModelVariants(model);
      let variant = state.get(sessionID)?.variant;
      if (variant && !variants.includes(variant)) variant = undefined;

      if (variants.length === 0 || !variant) {
        const messages = await fetchMessages(sessionID);
        if (!messages) return;

        if (variants.length === 0) {
          const info = latestModel(messages);
          variants = info ? await variantsFor(info) : [];
          if (variants.length === 0) return;
        }

        if (!variant) {
          const resolved = await latestVariant(messages);
          if (resolved && variants.includes(resolved)) {
            variant = resolved;
            state.update(sessionID, (entry) => {
              entry.variant = resolved;
            });
          }
        }
      }

      const recommendation = state.get(sessionID)?.recommendation;
      const effortInstruction = config.autoSelect
        ? recommendation && recommendation !== variant
          ? `This turn suggests ${recommendation} effort${variant ? ` (current: ${variant})` : ""}. Automatic selection is holding the current level; call \`${config.toolName}\` with \`${recommendation}\` if the work needs it.`
          : `Reasoning effort is selected automatically; call \`${config.toolName}\` only to override it.`
        : recommendation && recommendation !== variant
          ? `This turn suggests ${recommendation} effort${variant ? ` (current: ${variant})` : ""}. Call \`${config.toolName}\` with \`${recommendation}\` before proceeding.`
          : recommendation
            ? `The current level fits this request; call \`${config.toolName}\` only if the work grows beyond it.`
            : `Call \`${config.toolName}\` only when the current level no longer fits the task.`;

      const guidance = [
        config.systemPrompt.trim(),
        variant ? `Current reasoning effort level: ${variant}.` : "",
        `Valid reasoning effort levels for this session: ${variants.join(", ")}.`,
        effortInstruction,
      ]
        .filter(Boolean)
        .join(" ");

      const existing = system[0];
      system[0] = existing ? `${existing}\n\n${guidance}` : guidance;
    },
  };
};
