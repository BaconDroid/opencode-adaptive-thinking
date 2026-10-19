export type Complexity = "simple" | "normal" | "complex" | "deep";

const signals: Array<[RegExp, number]> = [
  [/\b(debug|investigate|trace)\b/i, 2],
  [/\b(root cause|flaky|race|deadlock|leak)\b/i, 2],
  [
    /\b(architecture|architect|design|plan|refactor|migrat\w*|review|audit|security|performance|optimi[sz]e)\b/i,
    2,
  ],
  [/\b(error|exception|failing|fails?|failure|broken|bug|why)\b/i, 2],
  [/\b(test|tests|coverage|benchmark)\b/i, 1],
  [/\b(multi[- ]file|across|module|modules|system|end[- ]to[- ]end)\b/i, 1],
  [/[?][\s\S]*[?]/, 1],
  [/```/, 1],
];

const simpleSignals = /\b(typo|rename|format|lint|thanks|thank you|hello|hi|hey)\b/i;

export const classifyPrompt = (text: string): Complexity => {
  const input = text.trim();
  if (input.length === 0) return "normal";

  let score = signals.reduce(
    (total, [pattern, weight]) => total + (pattern.test(input) ? weight : 0),
    0,
  );
  if (input.length > 400) score += 1;
  if (input.length > 1200) score += 2;
  if (input.length < 200 && simpleSignals.test(input)) score -= 3;

  if (score >= 6) return "deep";
  if (score >= 3) return "complex";
  if (score <= 0 && input.length < 160) return "simple";
  return "normal";
};

export const pickVariant = (
  variants: Array<string>,
  complexity: Complexity,
): string | undefined => {
  const usable = variants.filter((variant) => !/^(none|off|disabled)$/i.test(variant));
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];

  const last = usable.length - 1;
  const index = {
    simple: 0,
    normal: Math.floor(last / 2),
    complex: Math.round(last * 0.75),
    deep: last,
  }[complexity];

  return usable[index];
};
