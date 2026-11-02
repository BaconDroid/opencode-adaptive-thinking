import { afterEach, describe, expect, test, vi } from "vitest";
import { AdaptiveThinkingPlugin } from "./index";

const variants = [
  { id: "none", settings: { reasoningEffort: "none" } },
  { id: "low", settings: { reasoningEffort: "low" } },
  { id: "medium", settings: { reasoningEffort: "medium" } },
  { id: "high", settings: { reasoningEffort: "high" } },
  { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
];

const model = (variant?: string, providerID = "provider", id = "model") => ({
  providerID,
  id,
  ...(variant ? { variant } : {}),
});

const userMessage = (text = "", created = 0) => ({ type: "user", text, time: { created } });
const assistantMessage = (variant?: string, created = 1) => ({
  type: "assistant",
  agent: "agent",
  model: model(variant),
  content: [{ type: "text", text: "assistant text" }],
  time: { created },
});
const switchedMessage = (variant?: string, created = 1) => ({
  type: "model-switched",
  model: model(variant),
  time: { created },
});
const compactionMessage = (summary: string, created = 1) => ({
  type: "compaction",
  status: "completed",
  reason: "auto",
  summary,
  time: { created },
});

type HarnessOptions = {
  messages?: Array<any>;
  modelVariants?: Array<{
    id: string;
    settings?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  }>;
  modelRecords?: Array<{
    id?: string;
    modelID: string;
    providerID: string;
    settings?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    variants: Array<{
      id: string;
      settings?: Record<string, unknown>;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    }>;
  }>;
  agents?: Record<string, string>;
  agent?: string;
  sessionModel?: { providerID: string; id: string; variant?: string };
  answer?: string;
  experimentalGenerate?: boolean;
};

const quietConsole = () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};

let sessionCounter = 0;

const createHarness = async (options: unknown = undefined, setup: HarnessOptions = {}) => {
  quietConsole();
  const sessionID = `session-${++sessionCounter}`;

  const messages = setup.messages ?? [];
  const modelVariants = setup.modelVariants ?? variants;
  const switched: Array<{ providerID: string; id: string; variant?: string }> = [];
  const agentSwitches: Array<string> = [];
  const generated: Array<any> = [];
  const registered: Array<any> = [];
  const diagnostics: Array<{ key: string; value: any }> = [];
  const subscriptionSignals: Array<AbortSignal | undefined> = [];
  const subscriptionTypes: Array<ReadonlyArray<string> | undefined> = [];
  const hooks: Record<string, Array<(event: any) => unknown>> = {};
  const queue: Array<any> = [];
  let waiting: ((result: IteratorResult<any>) => void) | undefined;

  const session: any = { id: sessionID, agent: setup.agent ?? "agent" };
  if (setup.sessionModel) session.model = setup.sessionModel;

  const records: NonNullable<HarnessOptions["modelRecords"]> = setup.modelRecords ?? [
    {
      id: "model",
      modelID: "model",
      providerID: "provider",
      settings: {},
      headers: {},
      body: {},
      variants: modelVariants,
    },
    {
      id: "narrow",
      modelID: "narrow",
      providerID: "other",
      settings: {},
      headers: {},
      body: {},
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
      ],
    },
  ];

  const modelList = vi.fn(async () => ({
    location: {},
    data: records,
  }));

  const agentList = vi.fn(async () => ({
    location: {},
    data: Object.entries(setup.agents ?? {}).map(([name, variant]) => ({
      id: name,
      name,
      model: model(variant),
    })),
  }));

  const switchModel = vi.fn(async (input: any) => {
    switched.push(input.model);
    session.model = input.model;
  });
  const switchAgent = vi.fn(async (input: any) => {
    agentSwitches.push(input.agent);
    session.agent = input.agent;
  });

  const generateText = vi.fn(async (input: any) => {
    generated.push(input);
    return { text: setup.answer ?? "high" };
  });

  const experimentalGenerateText = vi.fn(async (input: any) => {
    generated.push(input);
    return { text: setup.answer ?? "high" };
  });

  const subscribe = vi.fn((options?: { signal?: AbortSignal; types?: ReadonlyArray<string> }) => {
    subscriptionSignals.push(options?.signal);
    subscriptionTypes.push(options?.types);
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
            return new Promise<IteratorResult<any>>((resolve) => {
              waiting = resolve;
              options?.signal?.addEventListener(
                "abort",
                () => resolve({ value: undefined, done: true }),
                { once: true },
              );
            });
          },
          async return() {
            return { value: undefined, done: true };
          },
        };
      },
    };
  });

  const ctx = {
    app: { name: "test", version: "2.0.30", channel: "test" },
    location: {
      directory: "/tmp",
      project: { id: "project", directory: "/tmp", canonical: "/tmp" },
    },
    options,
    model: { list: modelList },
    agent: { list: agentList },
    session: {
      context: vi.fn(async () => messages),
      get: vi.fn(async () => session),
      switchModel,
      switchAgent,
      hook: vi.fn(async (name: string, callback: (event: any) => unknown) => {
        (hooks[name] ??= []).push(callback);
        return { dispose: async () => {} };
      }),
    },
    tool: {
      transform: vi.fn(async (callback: (editor: any) => void) => {
        callback({
          add: (tool: any) => registered.push(tool),
          update: () => {},
          remove: () => {},
          list: () => registered,
          get: (id: string) => registered.find((tool) => tool.name === id),
          namespace: () => {},
        });
        return { dispose: async () => {} };
      }),
    },
    storage: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async (key: string, value: any) => {
        diagnostics.push({ key, value });
      }),
      remove: vi.fn(async () => {}),
      scan: vi.fn(async () => ({ entries: [] })),
    },
    experimental: setup.experimentalGenerate
      ? { generate: { text: experimentalGenerateText } }
      : {},
    generate: { text: generateText },
    event: { subscribe },
  };

  const cleanup = await AdaptiveThinkingPlugin.setup(ctx as never);
  await Promise.resolve();

  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  const emit = async (event: any) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: event, done: false });
    } else {
      queue.push(event);
    }
    await settle();
  };

  const prompt = async (text: string) => {
    for (const hook of hooks.prompt ?? []) {
      await hook({
        sessionID,
        messageID: "msg",
        prompt: { text, files: [] },
        metadata: undefined,
        delivery: "steer",
      });
    }
  };

  const hook = async (name: string, event: any) => {
    for (const callback of hooks[name] ?? []) await callback(event);
    return event;
  };

  const context = async (
    system: Array<{ type: "text"; text: string }> = [],
    eventModel?: { providerID: string; id: string; variant?: string },
    agent = setup.agent ?? "agent",
  ) => {
    // Requests start from the session model, so a plugin write to the session model shows up
    // in the next request while a per-request write does not.
    const requestModel = eventModel ?? (session.model ? { ...session.model } : model());
    // The host resolves the selected variant BEFORE the context hook and passes only its ref as
    // `event.model`. Snapshot that resolution so the test can build the outgoing request from
    // the pre-hook model plus the fields the runtime reads back from the hook event.
    const resolvedRecord = records.find(
      (record) =>
        record.providerID === requestModel.providerID &&
        (record.modelID === requestModel.id || record.id === requestModel.id),
    );
    const variantID = requestModel.variant === "default" ? undefined : requestModel.variant;
    const resolvedVariant = variantID
      ? resolvedRecord?.variants.find((candidate) => candidate.id === variantID)
      : undefined;
    const preHookModel = {
      ...resolvedRecord,
      variant: requestModel.variant,
      settings: { ...resolvedRecord?.settings, ...resolvedVariant?.settings },
      headers: { ...resolvedRecord?.headers, ...resolvedVariant?.headers },
      body: { ...resolvedRecord?.body, ...resolvedVariant?.body },
    };

    const event: any = {
      sessionID,
      agent,
      model: requestModel,
      system,
      messages: [],
      options: {},
      tools: {},
    };
    for (const hook of hooks.context ?? []) await hook(event);
    // What the runtime reads back, plus the pre-hook model it already resolved. A provider
    // option written by the plugin only reaches the wire through `event.options`.
    (event as any).request = {
      model: preHookModel,
      system: event.system,
      messages: event.messages,
      options: event.options,
      providerOptions: { ...preHookModel.settings, ...event.options },
      tools: event.tools,
    };
    return event;
  };

  const idle = () => emit({ type: "session.execution.succeeded", data: { sessionID } });

  const tool = (name = "set_reasoning_effort") => registered.find((entry) => entry.name === name);

  const set = async (level: string, persist: boolean, agent = setup.agent ?? "agent") =>
    tool().execute({ level, persist }, { sessionID, agent });

  return {
    sessionID,
    session,
    ctx,
    cleanup,
    settle,
    modelList,
    agentList,
    switchModel,
    switchAgent,
    generateText,
    experimentalGenerateText,
    switched,
    agentSwitches,
    generated,
    diagnostics,
    subscriptionSignals,
    subscriptionTypes,
    registered,
    hooks,
    messages,
    emit,
    idle,
    prompt,
    hook,
    context,
    tool,
    set,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdaptiveThinkingPlugin", () => {
  test("registers a V2 plugin definition with a stable id", () => {
    expect(AdaptiveThinkingPlugin.id).toBe("opencode-adaptive-thinking");
    expect(typeof AdaptiveThinkingPlugin.setup).toBe("function");
  });

  test("applies defaults, persists a level and preserves the model", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    expect(harness.tool().description).toBe("Set your reasoning effort");
    expect((await harness.set("high", true)).content).toBe("Reasoning effort set to high");
    expect(harness.switched[0]).toEqual({ providerID: "provider", id: "model", variant: "high" });

    const system: Array<{ type: "text"; text: string }> = [];
    await harness.context(system);
    const guidance = system.at(-1)?.text ?? "";
    expect(guidance).toContain("You MUST manage reasoning effort actively");
    expect(guidance).toContain("Current reasoning effort level: high.");
    expect(guidance).toContain(
      "Valid reasoning effort levels for this session: none, low, medium, high, xhigh.",
    );
    expect(guidance).toContain("set_reasoning_effort");
  });

  test("honors custom configuration and appends guidance beside an existing system part", async () => {
    const harness = await createHarness(
      {
        toolName: "adjust_reasoning",
        toolDescription: "Adjust it",
        systemPrompt: "Prefer cheap.",
      },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    expect(harness.tool("adjust_reasoning").description).toBe("Adjust it");
    expect(harness.tool("set_reasoning_effort")).toBeUndefined();

    const system = [{ type: "text" as const, text: "Base prompt." }];
    await harness.context(system);
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toBe("Base prompt.");
    expect(system[1]?.text.startsWith("Prefer cheap.")).toBe(true);
    expect(system[1]?.text).not.toContain("You MUST manage");
    expect(system[1]?.text).toContain("adjust_reasoning");
  });

  test("registers nothing when disabled", async () => {
    const harness = await createHarness({ enabled: false });

    expect(harness.registered).toHaveLength(0);
    expect(harness.hooks.prompt).toBeUndefined();
    expect(harness.hooks.context).toBeUndefined();
  });

  test("reports invalid configuration and suppresses the generic message when quiet", async () => {
    const invalid = await createHarness({ enabled: "yes" });
    expect(invalid.registered).toHaveLength(0);
    const messages = vi
      .mocked(console.error)
      .mock.calls.map((call) => call.join(" "))
      .join("\n");
    expect(messages).toContain("Invalid Adaptive Thinking plugin configuration");
    expect(messages).toContain("enabled must be a boolean");
    expect(messages).toContain("see the server output for details");
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(2);

    vi.mocked(console.error).mockClear();
    const quiet = await createHarness({ enabled: "yes", quiet: true });
    expect(quiet.registered).toHaveLength(0);
    const quietMessages = vi
      .mocked(console.error)
      .mock.calls.map((call) => call.join(" "))
      .join("\n");
    expect(quietMessages).not.toContain("see the server output for details");
    expect(quietMessages).toContain("enabled must be a boolean");
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });

  test("reports invalid configuration without throwing when options is null", async () => {
    const harness = await createHarness(null);

    expect(harness.registered).toHaveLength(0);
    const messages = vi
      .mocked(console.error)
      .mock.calls.map((call) => call.join(" "))
      .join("\n");
    expect(messages).toContain("Invalid Adaptive Thinking plugin configuration");
    expect(messages).toContain("options must be an object");
  });

  test("rejects an invalid level without switching", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    expect((await harness.set("extreme", true)).content).toContain(
      "Invalid reasoning effort level",
    );
    expect(harness.switched).toHaveLength(0);
  });

  test("reports models without reasoning variants", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
      modelVariants: [],
    });

    expect((await harness.set("high", true)).content).toContain("no valid reasoning effort levels");
    expect(harness.switched).toHaveLength(0);
  });

  test("resets a temporary level to the level from the session history", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    await harness.set("low", false);
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "medium"]);
  });

  test("does not restore an agent that changed after the tool call", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    await harness.set("low", false, "agent-at-tool-time");
    // The user picks another agent while the temporary level is active.
    harness.session.agent = "user-chosen";
    await harness.idle();

    expect(harness.agentSwitches).toHaveLength(0);
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "medium"]);
  });

  test("does not restore a model that changed after the tool call", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    await harness.set("low", false);
    // The user picks another model while the temporary level is active.
    harness.session.model = { providerID: "other", id: "narrow", variant: "low" };
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low"]);

    // The pending reset was dropped rather than retried against the new model.
    await harness.idle();
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low"]);
  });

  test("does not read session history when no trigger injects guidance", async () => {
    const harness = await createHarness(
      { triggers: { afterIdle: false, afterUserMessage: false } },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    await harness.prompt("hello");
    await harness.context([]);
    await harness.context([]);

    expect(harness.ctx.session.context).not.toHaveBeenCalled();
    expect(harness.ctx.session.get).not.toHaveBeenCalled();
  });

  test("reverts to the session model variant when history has no level", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage()],
      sessionModel: { providerID: "provider", id: "model", variant: "default" },
    });

    await harness.set("high", false);
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["high", "default"]);
  });

  test("reads the model and variant from assistant messages", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("high")],
    });

    await harness.set("low", false);
    await harness.idle();

    expect(harness.switched[0]).toEqual({ providerID: "provider", id: "model", variant: "low" });
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "high"]);
  });

  test("matches a model ref whose id is the record id rather than its modelID", async () => {
    const harness = await createHarness(undefined, {
      messages: [
        userMessage(),
        {
          type: "assistant",
          agent: "agent",
          model: model("medium", "provider", "record-id"),
          content: [{ type: "text", text: "assistant text" }],
          time: { created: 1 },
        },
      ],
      modelRecords: [
        { id: "record-id", modelID: "canonical-model", providerID: "provider", variants },
      ],
    });

    const system: Array<{ type: "text"; text: string }> = [];
    await harness.context(system, model(undefined, "provider", "record-id"));
    const guidance = system.at(-1)?.text ?? "";

    expect(guidance).toContain(
      "Valid reasoning effort levels for this session: none, low, medium, high, xhigh.",
    );
    expect(guidance).toContain("Current reasoning effort level: medium.");

    expect((await harness.set("high", true)).content).toBe("Reasoning effort set to high");
    expect(harness.switched[0]).toEqual({
      providerID: "provider",
      id: "record-id",
      variant: "high",
    });
  });

  test("resets a temporary level to the model default baseline", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("default")],
    });

    await harness.set("high", false);
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["high", "default"]);
  });

  test("does not remember the default level after an idle reset", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage(), assistantMessage("default")] },
    );

    await harness.set("high", false);
    await harness.idle();
    await harness.prompt("debug");
    await harness.context([]);

    const prompt = harness.generated.at(-1)?.prompt ?? "";
    expect(prompt).not.toContain("Current reasoning effort level: default.");
    expect(prompt).not.toContain("Current reasoning effort level");
  });

  test("keeps the original baseline across repeated temporary changes", async () => {
    const changed = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    await changed.set("low", false);
    await changed.set("high", false);
    await changed.idle();

    const repeated = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    await repeated.set("low", false);
    await repeated.set("low", false);
    await repeated.idle();

    expect(changed.switched.map((entry) => entry.variant)).toEqual(["low", "high", "medium"]);
    expect(repeated.switched.map((entry) => entry.variant)).toEqual(["low", "low", "medium"]);
  });

  test("restores the pre-tool session variant after the classifier applied the same level", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        sessionModel: { providerID: "provider", id: "model", variant: "default" },
      },
    );

    await harness.prompt("debug the flaky test");
    const classified = await harness.context([]);
    expect(classified.model.variant).toBe("high");
    expect(harness.session.model).toEqual({
      providerID: "provider",
      id: "model",
      variant: "default",
    });

    // The agent asks for the same level temporarily. The classifier's level is not the
    // session's baseline, so the temporary change must still be armed and revert at idle.
    expect((await harness.set("high", false)).content).toBe("Reasoning effort set to high");
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["high", "default"]);
    expect(harness.session.model).toEqual({
      providerID: "provider",
      id: "model",
      variant: "default",
    });

    // The reset must not pin the session, so the next user message is still classified.
    await harness.prompt("explain this function");
    const next = await harness.context();
    expect(harness.generateText).toHaveBeenCalledTimes(2);
    expect(next.model.variant).toBe("high");
  });

  test("restores the pre-tool session variant when the classifier applied another level", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        sessionModel: { providerID: "provider", id: "model", variant: "default" },
      },
    );

    await harness.prompt("debug the flaky test");
    await harness.context([]);

    expect((await harness.set("low", false)).content).toBe("Reasoning effort set to low");
    await harness.idle();

    // The reset target is the session variant from before the tool call, not the classified
    // level that only applied to the previous request.
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "default"]);
    expect(harness.session.model).toEqual({
      providerID: "provider",
      id: "model",
      variant: "default",
    });

    await harness.prompt("explain this function");
    await harness.context();
    expect(harness.generateText).toHaveBeenCalledTimes(2);
  });

  test("keeps a temporary reset pending after a failed attempt", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    const succeed = harness.switchModel.getMockImplementation()!;
    harness.switchModel
      .mockImplementationOnce(succeed)
      .mockImplementationOnce(async () => {
        throw new Error("unavailable");
      })
      .mockImplementationOnce(succeed);

    await harness.set("low", false);
    await harness.idle();
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "medium"]);
    expect(console.error).toHaveBeenCalled();
  });

  test("reports a provider lookup failure without switching", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    harness.modelList.mockRejectedValueOnce(new Error("down"));

    expect((await harness.set("high", true)).content).toContain("no valid reasoning effort levels");
    expect(harness.switched).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  test("does not reset a persisted level on idle", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    await harness.set("high", true);
    await harness.idle();

    expect(harness.switched).toHaveLength(1);
  });

  test("returns an error instead of throwing when messages cannot be read", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    vi.mocked(harness.ctx.session.context).mockRejectedValueOnce(new Error("unavailable"));

    expect((await harness.set("high", true)).content).toContain("could not read the session");
    expect(console.error).toHaveBeenCalled();
  });

  test("ignores a cached level that the current model does not support", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    await harness.set("high", true);

    const system: Array<{ type: "text"; text: string }> = [];
    const event = await harness.context(system, model(undefined, "other", "narrow"));
    const guidance = system.at(-1)?.text ?? "";
    expect(guidance).toContain("Valid reasoning effort levels for this session: low, medium.");
    expect(guidance).not.toContain("Current reasoning effort level: high.");
    expect(event.request.providerOptions.reasoningEffort).toBe("medium");
  });

  test("falls back to the agent variant when history has none", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage()],
      agents: { worker: "low" },
      agent: "worker",
    });

    const system: Array<{ type: "text"; text: string }> = [];
    const event = await harness.context(system, model(), "worker");
    expect(system.at(-1)?.text).toContain("Current reasoning effort level: low.");
    expect(event.request.providerOptions.reasoningEffort).toBe("low");
  });

  test("drops session state when the session is deleted", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    await harness.set("low", false);
    await harness.emit({ type: "session.deleted", data: { sessionID: harness.sessionID } });
    await harness.idle();

    expect(harness.switched).toHaveLength(1);
  });

  test("injects guidance once per user turn when afterUserMessage is set", async () => {
    const harness = await createHarness(
      { triggers: { afterIdle: false, afterUserMessage: true } },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    await harness.prompt("hello");
    const first: Array<{ type: "text"; text: string }> = [];
    await harness.context(first);
    expect(first).toHaveLength(1);

    const second: Array<{ type: "text"; text: string }> = [];
    await harness.context(second);
    expect(second).toHaveLength(0);
  });

  test("injects guidance after idle when afterIdle is set", async () => {
    const harness = await createHarness(
      { triggers: { afterIdle: true, afterUserMessage: false } },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    const first: Array<{ type: "text"; text: string }> = [];
    await harness.context(first);
    expect(first).toHaveLength(1);

    const second: Array<{ type: "text"; text: string }> = [];
    await harness.context(second);
    expect(second).toHaveLength(0);

    await harness.idle();
    const third: Array<{ type: "text"; text: string }> = [];
    await harness.context(third);
    expect(third).toHaveLength(1);
  });

  test("ignores an unrelated event that carries a session id", async () => {
    const harness = await createHarness(
      { triggers: { afterIdle: true, afterUserMessage: false } },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    // Consume the session-start idle injection so the next event decides whether it re-arms.
    const first: Array<{ type: "text"; text: string }> = [];
    await harness.context(first);
    expect(first).toHaveLength(1);

    await harness.set("low", false);
    await harness.emit({
      type: "session.message.content.updated",
      data: { sessionID: harness.sessionID },
    });

    // The event is not an execution end, so the temporary level must not be reset.
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low"]);

    // Nor may it re-arm the idle trigger.
    const afterUnrelated: Array<{ type: "text"; text: string }> = [];
    await harness.context(afterUnrelated);
    expect(afterUnrelated).toHaveLength(0);

    // A real execution end still resets the level and injects guidance.
    await harness.idle();
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "medium"]);
    const afterRealIdle: Array<{ type: "text"; text: string }> = [];
    await harness.context(afterRealIdle);
    expect(afterRealIdle).toHaveLength(1);
  });

  test("does not inject twice for a user message after idle", async () => {
    const harness = await createHarness(
      { triggers: { afterIdle: true, afterUserMessage: true } },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    await harness.idle();
    await harness.prompt("hello");
    const system: Array<{ type: "text"; text: string }> = [];
    await harness.context(system);
    expect(system).toHaveLength(1);
  });

  test("injects nothing when both triggers are false", async () => {
    const harness = await createHarness(
      { triggers: { afterIdle: false, afterUserMessage: false } },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    await harness.prompt("hello");
    const system: Array<{ type: "text"; text: string }> = [];
    await harness.context(system);
    expect(system).toHaveLength(0);
  });

  test("classifies user turns but not idle turns", async () => {
    const harness = await createHarness(
      {
        triggers: { afterIdle: true, afterUserMessage: true },
        classifier: { enabled: true },
      },
      { messages: [userMessage(), assistantMessage("medium")] },
    );

    await harness.context([]);
    expect(harness.generateText).not.toHaveBeenCalled();

    await harness.prompt("debug the flaky test");
    await harness.context([]);
    expect(harness.generateText).toHaveBeenCalledTimes(1);
  });

  test("applies the classified level to the current request options only", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);
    const high = variants.find((variant) => variant.id === "high");

    // The pre-hook model carries no level, so only a field the runtime reads back can reach
    // the provider. Asserting the request options is the independent oracle for that.
    expect(event.request.model.settings).toEqual({});
    expect(event.request.providerOptions).toMatchObject(high?.settings ?? {});
    expect(event.model.variant).toBe("high");
    expect(harness.switched).toHaveLength(0);
  });

  test("does not forward an unsafe settings key into request options", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        modelVariants: [
          {
            id: "high",
            settings: JSON.parse('{"__proto__":{"polluted":true},"reasoningEffort":"high"}'),
          },
        ],
      },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    expect(event.request.providerOptions.reasoningEffort).toBe("high");
    expect(Object.getPrototypeOf(event.options)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(event.options, "__proto__")).toBe(false);
  });

  test("does not forward runtime settings keys into request options", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        modelVariants: [
          {
            id: "high",
            settings: {
              apiKey: "x",
              baseURL: "http://x",
              headers: { "x-leak": "no" },
              reasoningEffort: "high",
            },
          },
        ],
      },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    // A catalog variant may list host runtime settings. They configure the runtime, not the
    // provider request, so only the provider option may reach the request's options.
    expect(event.options).toEqual({ reasoningEffort: "high" });
    expect(event.request.providerOptions.reasoningEffort).toBe("high");
  });

  test("does not claim a level whose catalog variant has no request mapping", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()], modelVariants: [{ id: "high" }] },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    expect(harness.generateText).toHaveBeenCalledTimes(1);
    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(event.system.at(-1)?.text).not.toContain("Current reasoning effort level");
  });

  test("applies variant headers and body overrides to a primary request and its retries", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        modelVariants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          {
            id: "high",
            settings: { reasoningEffort: "high" },
            headers: { "x-reasoning-level": "high" },
            body: { thinking: { type: "enabled", budgetTokens: 1024 } },
          },
        ],
      },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);
    expect(event.request.providerOptions.reasoningEffort).toBe("high");

    const modelRequest = await harness.hook("model.request", {
      sessionID: harness.sessionID,
      kind: "primary",
      headers: { "x-base": "kept" },
    });
    expect(modelRequest.headers).toEqual({ "x-base": "kept", "x-reasoning-level": "high" });

    const request = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "model",
        messages: [],
        thinking: { type: "disabled", keep: true },
      }),
    });
    const httpRequest = await harness.hook("http.request", {
      sessionID: harness.sessionID,
      kind: "primary",
      request,
    });
    expect(await httpRequest.request.json()).toEqual({
      model: "model",
      messages: [],
      thinking: { type: "enabled", budgetTokens: 1024, keep: true },
    });

    // The same call may retry the transport. Every attempt must receive the override, because
    // only the next context hook ends its lifetime.
    const retry = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [] }),
    });
    const retryRequest = await harness.hook("http.request", {
      sessionID: harness.sessionID,
      kind: "primary",
      request: retry,
    });
    expect(await retryRequest.request.json()).toEqual({
      model: "model",
      messages: [],
      thinking: { type: "enabled", budgetTokens: 1024 },
    });
  });

  test("clears a stale request override before the next request", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        modelVariants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          {
            id: "high",
            settings: { reasoningEffort: "high" },
            headers: { "x-reasoning-level": "high" },
            body: { thinking: { type: "enabled", budgetTokens: 1024 } },
          },
        ],
      },
    );

    await harness.prompt("debug the flaky test");
    await harness.context([]);

    const firstModel = await harness.hook("model.request", {
      sessionID: harness.sessionID,
      kind: "primary",
      headers: { "x-base": "kept" },
    });
    expect(firstModel.headers).toEqual({ "x-base": "kept", "x-reasoning-level": "high" });

    // No http.request ran for that request, so the override is still pending. The next context
    // hook must discard it instead of leaking it into the next request.
    await harness.context([]);

    const secondModel = await harness.hook("model.request", {
      sessionID: harness.sessionID,
      kind: "primary",
      headers: { "x-base": "kept" },
    });
    expect(secondModel.headers).toEqual({ "x-base": "kept" });

    const request = new Request("https://example.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [] }),
    });
    const httpRequest = await harness.hook("http.request", {
      sessionID: harness.sessionID,
      kind: "primary",
      request,
    });
    expect(await httpRequest.request.json()).toEqual({ model: "model", messages: [] });
  });

  test("fails open when the primary request body is not JSON and warns once", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        modelVariants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          {
            id: "high",
            settings: { reasoningEffort: "high" },
            body: { thinking: { type: "enabled" } },
          },
        ],
      },
    );

    await harness.prompt("debug the flaky test");
    await harness.context([]);

    const send = async (body: string) => {
      const request = new Request("https://example.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const event = await harness.hook("http.request", {
        sessionID: harness.sessionID,
        kind: "primary",
        request,
      });
      return { request, event };
    };

    const first = await send("not json");
    expect(first.event.request).toBe(first.request);
    expect(await first.event.request.text()).toBe("not json");
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(harness.diagnostics.at(-1)?.value.message).toContain(
      "Failed to apply the request-scoped reasoning variant body",
    );

    // A later failure is recorded again but must not print the warning again.
    const second = await send("still not json");
    expect(second.event.request).toBe(second.request);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(harness.diagnostics.at(-1)?.value.message).toContain(
      "Failed to apply the request-scoped reasoning variant body",
    );
  });

  test("leaves a primary request with no body untouched", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        modelVariants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          {
            id: "high",
            settings: { reasoningEffort: "high" },
            body: { thinking: { type: "enabled" } },
          },
        ],
      },
    );

    await harness.prompt("debug the flaky test");
    await harness.context([]);

    const request = new Request("https://example.test/v1/chat/completions");
    const event = await harness.hook("http.request", {
      sessionID: harness.sessionID,
      kind: "primary",
      request,
    });

    expect(event.request).toBe(request);
    expect(request.body).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  test("leaves non-primary requests untouched", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        modelVariants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          {
            id: "high",
            settings: { reasoningEffort: "high" },
            headers: { "x-reasoning-level": "high" },
            body: { thinking: { type: "enabled", budgetTokens: 1024 } },
          },
        ],
      },
    );

    await harness.prompt("debug the flaky test");
    await harness.context([]);

    for (const kind of ["title", "compaction"]) {
      const modelRequest = await harness.hook("model.request", {
        sessionID: harness.sessionID,
        kind,
        headers: { "x-base": "kept" },
      });
      expect(modelRequest.headers).toEqual({ "x-base": "kept" });

      const request = new Request("https://example.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "model", messages: [] }),
      });
      const httpRequest = await harness.hook("http.request", {
        sessionID: harness.sessionID,
        kind,
        request,
      });
      expect(await httpRequest.request.json()).toEqual({ model: "model", messages: [] });
    }
  });

  test("ignores history when the request model has no variants", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("high")],
      modelRecords: [
        { id: "model", modelID: "model", providerID: "provider", variants },
        { id: "plain", modelID: "plain", providerID: "other", variants: [] },
      ],
    });

    const system: Array<{ type: "text"; text: string }> = [];
    const event = await harness.context(system, model(undefined, "other", "plain"));

    // The history level belongs to the other model. Nothing may be applied or stamped on a
    // request whose own model exposes no variants.
    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions).toEqual({});
    expect(system).toHaveLength(0);
  });

  test("fails open when the provider catalog payload is malformed", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.modelList.mockResolvedValueOnce({ location: {}, data: {} } as never);

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(harness.diagnostics.at(-1)?.value.message).toContain("Failed to retrieve providers");
  });

  test("fails open on nested catalog shape garbage", async () => {
    for (const records of [
      [{ providerID: "provider", modelID: "model", variants: {} }],
      [null],
      [{ providerID: "provider", modelID: "model", variants: [null] }],
    ]) {
      const harness = await createHarness(
        { classifier: { enabled: true } },
        { messages: [userMessage()] },
      );
      harness.modelList.mockResolvedValueOnce({ location: {}, data: records } as never);

      await harness.prompt("debug the flaky test");
      const event = await harness.context([]);

      expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    }
  });

  test("fails open when the session context payload is malformed", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.ctx.session.context.mockResolvedValueOnce({ messages: [] } as never);

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    expect(event.request.providerOptions.reasoningEffort).toBe("high");
    expect(harness.diagnostics.at(-1)?.value.message).toContain(
      "Failed to retrieve messages for session",
    );
  });

  test("classifies a request that carries the model default variant", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context([], model("default"));

    expect(harness.generateText).toHaveBeenCalledTimes(1);
    expect(event.model.variant).toBe("high");
    expect(event.request.model.settings).toEqual({});
    expect(event.request.providerOptions.reasoningEffort).toBe("high");
  });

  test("uses the last compaction summary in the classifier context", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage(), assistantMessage("medium"), compactionMessage("SUMMARY-CONTEXT")],
      },
    );

    await harness.prompt("next step");
    await harness.context([]);

    const prompt = harness.generated.at(-1)?.prompt ?? "";
    expect(prompt).toContain("SUMMARY-CONTEXT");
    expect(prompt).toContain("Current message:\nnext step");
  });

  test("scopes classifier context to messages since the last idle", async () => {
    const harness = await createHarness({ classifier: { enabled: true } }, { messages: [] });

    const beforeIdle = Date.now() - 60_000;
    await harness.idle();
    const afterIdle = Date.now();

    harness.messages.push(
      {
        type: "assistant",
        model: model("medium"),
        content: [{ type: "text", text: "PRE-IDLE-ASSISTANT" }],
        time: { created: beforeIdle },
      },
      {
        type: "user",
        text: "PRE-IDLE-USER",
        time: { created: beforeIdle + 1000 },
      },
      {
        type: "assistant",
        model: model("medium"),
        content: [{ type: "text", text: "RECENT-ASSISTANT" }],
        time: { created: afterIdle },
      },
    );

    await harness.prompt("current question");
    await harness.context([]);

    const prompt = harness.generated.at(-1)?.prompt ?? "";
    expect(prompt).toContain("RECENT-ASSISTANT");
    expect(prompt).not.toContain("PRE-IDLE-ASSISTANT");
  });

  test("classifies each real user message", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );

    await harness.prompt("debug the flaky auth test");
    const first = await harness.context([]);

    await harness.prompt("explain this function");
    const second = await harness.context([]);

    expect(first.model.variant).toBe("high");
    expect(second.model.variant).toBe("high");
    expect(first.request.providerOptions.reasoningEffort).toBe("high");
    expect(second.request.providerOptions.reasoningEffort).toBe("high");
    expect(harness.generateText).toHaveBeenCalledTimes(2);
    expect(harness.generated[0].model).toEqual({ providerID: "opencode", id: "big-pickle" });
    expect(harness.generateText.mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  test("does not classify when disabled or with an explicit variant", async () => {
    const off = await createHarness(undefined, { messages: [userMessage()] });
    await off.prompt("debug");
    await off.context([]);
    expect(off.generateText).not.toHaveBeenCalled();

    const on = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    await on.prompt("debug");
    const event = await on.context([], model("low"));
    expect(on.generateText).not.toHaveBeenCalled();
    expect(event.model.variant).toBe("low");
    expect(event.request.providerOptions.reasoningEffort).toBe("low");
  });

  test("ignores an invalid classifier answer and reports it as invalid", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()], answer: "unsure" },
    );

    await harness.prompt("debug");
    const event = await harness.context([]);

    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(harness.switched).toHaveLength(0);
    expect(harness.diagnostics.at(-1)?.value.message).toContain(
      "The classifier returned an invalid response",
    );
  });

  test("fails open when the classifier request fails", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.generateText.mockRejectedValueOnce(new Error("unavailable"));

    await harness.prompt("debug");
    const event = await harness.context([]);

    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  test("fails open when the generate API throws synchronously", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.generateText.mockImplementationOnce(() => {
      throw new Error("sync failure");
    });

    await harness.prompt("debug");
    const event = await harness.context([]);

    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  test("records every classifier failure but warns once", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.generateText
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));

    await harness.prompt("debug");
    await harness.context([]);
    await harness.prompt("debug again");
    await harness.context([]);

    const diagnostics = harness.diagnostics.filter((entry) => entry.key === "lastDiagnostic");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.at(-1)?.value.message).toContain("second failure");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  test("rejects an invalid classifier configuration", async () => {
    const harness = await createHarness({ classifier: { enabled: "yes" } });

    expect(harness.registered).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  test("records state for model-switched and idle messages without failing", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), switchedMessage("medium"), assistantMessage("medium")],
    });

    await harness.set("low", false);
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "medium"]);
  });

  test("does not persist a classified level and classifies consecutive user messages", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      {
        messages: [userMessage()],
        sessionModel: { providerID: "provider", id: "model", variant: "default" },
      },
    );

    await harness.prompt("debug the flaky test");
    const first = await harness.context();
    expect(first.model.variant).toBe("high");
    expect(first.request.providerOptions.reasoningEffort).toBe("high");
    expect(harness.session.model).toEqual({
      providerID: "provider",
      id: "model",
      variant: "default",
    });

    const next = await harness.context();
    expect(next.model.variant).not.toBe("high");
    expect(next.request.providerOptions.reasoningEffort).toBeUndefined();

    await harness.prompt("explain this function");
    const second = await harness.context();
    expect(second.model.variant).toBe("high");
    expect(second.request.providerOptions.reasoningEffort).toBe("high");
    expect(harness.generateText).toHaveBeenCalledTimes(2);
    expect(harness.switched).toHaveLength(0);
  });

  test("records the last diagnostic when the classifier fails", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.generateText.mockRejectedValueOnce(new Error("unavailable"));

    await harness.prompt("debug");
    await harness.context();

    const last = harness.diagnostics.at(-1);
    expect(last?.key).toBe("lastDiagnostic");
    expect(last?.value.level).toBe("warn");
    expect(last?.value.at).toEqual(expect.any(String));
    expect(last?.value.message).toContain("The classifier request failed");
  });

  test("prefers the experimental generate API when available", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()], experimentalGenerate: true },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context();

    expect(event.model.variant).toBe("high");
    expect(event.request.providerOptions.reasoningEffort).toBe("high");
    expect(harness.experimentalGenerateText).toHaveBeenCalledTimes(1);
    expect(harness.generateText).not.toHaveBeenCalled();
  });

  test("treats the model default as absent and applies the agent variant on the first turn", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage()],
      agents: { worker: "low" },
      agent: "worker",
      sessionModel: { providerID: "provider", id: "model", variant: "default" },
    });

    const event = await harness.context([], undefined, "worker");
    const guidance = event.system.at(-1)?.text ?? "";

    expect(event.model.variant).toBe("low");
    expect(event.request.model.settings).toEqual({});
    expect(event.request.providerOptions.reasoningEffort).toBe("low");
    expect(guidance).toContain("Current reasoning effort level: low.");
  });

  test("applies the resolved history level when the request carries the model default", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
      sessionModel: { providerID: "provider", id: "model", variant: "default" },
    });

    const event = await harness.context();
    const guidance = event.system.at(-1)?.text ?? "";

    expect(event.model.variant).toBe("medium");
    expect(event.request.model.settings).toEqual({});
    expect(event.request.providerOptions.reasoningEffort).toBe("medium");
    expect(guidance).toContain("Current reasoning effort level: medium.");
    expect(guidance).not.toContain("Current reasoning effort level: high.");
  });

  test("omits the current level when the request has no usable level", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage()],
      sessionModel: { providerID: "provider", id: "model", variant: "default" },
    });

    const event = await harness.context();
    const guidance = event.system.at(-1)?.text ?? "";

    expect(event.model.variant).toBe("default");
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(guidance).not.toContain("Current reasoning effort level");
  });

  test("cleanup aborts the event subscription", async () => {
    const harness = await createHarness();
    await harness.settle();

    expect(harness.cleanup).toBeTypeOf("function");
    expect(harness.subscriptionSignals[0]?.aborted).toBe(false);
    expect(harness.subscriptionTypes[0]).toEqual([
      "session.deleted",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]);

    await harness.cleanup?.();
    await harness.settle();

    expect(harness.subscriptionSignals[0]?.aborted).toBe(true);
  });

  test("aborts the classifier request when it times out", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createHarness(
        { classifier: { enabled: true } },
        { messages: [userMessage()] },
      );
      let signal: AbortSignal | undefined;
      harness.generateText.mockImplementationOnce((_input: any, options?: any) => {
        signal = options?.signal;
        return new Promise(() => {});
      });

      await harness.prompt("debug");
      const pending = harness.context();
      await vi.advanceTimersByTimeAsync(5000);
      const event = await pending;

      expect(signal?.aborted).toBe(true);
      expect(event.model.variant).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
      expect(harness.diagnostics.at(-1)?.value.message).toContain("The classifier timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not reset when the session cannot be read", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    await harness.set("low", false, "worker");
    harness.ctx.session.get.mockRejectedValueOnce(new Error("unavailable"));
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low"]);
    expect(harness.agentSwitches).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  test("disarms a temporary reset when the session is unreadable at tool time", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("high")],
    });

    // The history carries the plugin's own classifier stamp, not a level the user chose. When
    // the session itself cannot be read the baseline is UNKNOWN, so the reset must be disarmed
    // instead of restoring that stamped level at idle.
    harness.ctx.session.get.mockRejectedValueOnce(new Error("unavailable"));
    expect((await harness.set("low", false)).content).toBe("Reasoning effort set to low");
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low"]);
    expect(console.error).toHaveBeenCalled();
  });

  test("prefers the session variant over a stamped history level for the reset baseline", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("high")],
      sessionModel: { providerID: "provider", id: "model", variant: "default" },
    });

    // The history carries the plugin's own classifier stamp. The session variant is the
    // reset baseline; the stamp must not survive idle as the session's level.
    expect((await harness.set("low", false)).content).toBe("Reasoning effort set to low");
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "default"]);
    expect(harness.session.model).toEqual({
      providerID: "provider",
      id: "model",
      variant: "default",
    });
  });

  test("accepts unknown tool arguments", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    expect(harness.tool().input.additionalProperties).toBeUndefined();
    const result = await harness
      .tool()
      .execute(
        { level: "high", persist: true, extra: "ignored" },
        { sessionID: harness.sessionID, agent: "agent" },
      );

    expect(result.content).toBe("Reasoning effort set to high");
  });

  test("warns once for repeated switch failures", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    const succeed = harness.switchModel.getMockImplementation()!;
    harness.switchModel
      .mockImplementationOnce(succeed)
      .mockImplementationOnce(async () => {
        throw new Error("unavailable");
      })
      .mockImplementationOnce(async () => {
        throw new Error("unavailable");
      });

    await harness.set("low", false);
    await harness.idle();
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low"]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(harness.diagnostics.filter((entry) => entry.key === "lastDiagnostic")).toHaveLength(2);
  });

  test("treats a non-serializable switch failure as a failure", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });
    harness.switchModel.mockImplementationOnce(async () => {
      throw () => "not serializable";
    });

    const result = await harness.set("high", false);
    expect(result.content).toContain("Failed to set reasoning effort:");
    expect(result.content).not.toContain("Reasoning effort set");
    expect(console.error).toHaveBeenCalled();

    // The failed switch must not be remembered as the current level.
    await harness.set("low", false);
    await harness.idle();
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "medium"]);
  });

  test("fails open when the classifier returns a non-string answer", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.generateText.mockResolvedValueOnce({ text: 42 } as never);

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(harness.switched).toHaveLength(0);
    expect(event.system.at(-1)?.text).toContain("You MUST manage reasoning effort actively");
    expect(harness.diagnostics.at(-1)?.value.message).toContain(
      "The classifier returned an invalid response",
    );
  });

  test("reports a successful response without text as an invalid response", async () => {
    const harness = await createHarness(
      { classifier: { enabled: true } },
      { messages: [userMessage()] },
    );
    harness.generateText.mockResolvedValueOnce({ text: undefined } as never);

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
    expect(harness.diagnostics.at(-1)?.value.message).toContain(
      "The classifier returned an invalid response",
    );
    expect(harness.diagnostics.at(-1)?.value.message).not.toContain(
      "The classifier request failed",
    );
  });

  test("clears a remembered level when the reset is dropped for a model change", async () => {
    const harness = await createHarness(undefined, {
      messages: [userMessage(), assistantMessage("medium")],
    });

    await harness.set("low", false);
    // The user picks another model while the temporary level is active.
    harness.session.model = { providerID: "other", id: "narrow" };
    await harness.idle();
    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low"]);

    // A temporary change on the new model must use that model's own baseline.
    harness.messages.push({
      type: "assistant",
      model: { providerID: "other", id: "narrow", variant: "medium" },
      content: [{ type: "text", text: "assistant text" }],
      time: { created: 2 },
    });
    await harness.set("low", false);
    await harness.idle();

    expect(harness.switched.map((entry) => entry.variant)).toEqual(["low", "low", "medium"]);
  });

  test("does not classify when only afterIdle is enabled", async () => {
    const harness = await createHarness(
      { triggers: { afterIdle: true, afterUserMessage: false }, classifier: { enabled: true } },
      { messages: [userMessage()] },
    );

    await harness.prompt("debug the flaky test");
    const event = await harness.context([]);

    expect(harness.generateText).not.toHaveBeenCalled();
    expect(event.model.variant).toBeUndefined();
    expect(event.request.providerOptions.reasoningEffort).toBeUndefined();
  });

  test("does not subscribe to events when disabled", async () => {
    const harness = await createHarness({ enabled: false });
    await harness.settle();

    expect(harness.ctx.event.subscribe).not.toHaveBeenCalled();
    expect(harness.subscriptionSignals).toHaveLength(0);
  });
});
