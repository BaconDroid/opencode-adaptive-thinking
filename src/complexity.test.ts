import { expect, test } from "vitest";
import { classifyPrompt, pickVariant } from "./complexity";

test("classifies prompt complexity", () => {
  expect(classifyPrompt("fix typo in the README")).toBe("simple");
  expect(classifyPrompt("add a test for the parser")).toBe("normal");
  expect(classifyPrompt("debug the flaky test")).toBe("complex");
  expect(classifyPrompt("debug the flaky test and trace the root cause across modules")).toBe(
    "deep",
  );
});

test("maps complexity to an available variant", () => {
  const all = ["none", "low", "medium", "high", "xhigh"];
  expect(pickVariant(all, "simple")).toBe("low");
  expect(pickVariant(all, "normal")).toBe("medium");
  expect(pickVariant(all, "complex")).toBe("high");
  expect(pickVariant(all, "deep")).toBe("xhigh");
  expect(pickVariant(["low"], "deep")).toBe("low");
  expect(pickVariant([], "normal")).toBeUndefined();
});
