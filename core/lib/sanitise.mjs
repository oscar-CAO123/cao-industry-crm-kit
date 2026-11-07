// Clean outside text before an agent reads it. Returns the text and any flags.
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const PATTERNS = [
  [/ignore (all |any |the )?(previous|prior|above) (instructions|prompts?)/i, "override"],
  [/disregard (all |any |the )?(previous|prior|above)/i, "override"],
  [/you are now\b/i, "role"],
  [/system prompt/i, "prompt-probe"],
  [/reveal (your|the) (instructions|prompt|keys?|secrets?)/i, "exfiltration"],
  [/(send|post|upload) .{0,40}(api key|token|password|secret)/i, "exfiltration"],
];
export function sanitise(input, { maxLength = 20000 } = {}) {
  const raw = String(input ?? "");
  const flags = [];
  if (HIDDEN.test(raw)) flags.push("hidden-characters");
  HIDDEN.lastIndex = 0;
  let text = raw.normalize("NFKC").replace(HIDDEN, "").replace(CONTROL, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const [re, name] of PATTERNS) if (re.test(text)) flags.push(name);
  if (text.length > maxLength) { text = text.slice(0, maxLength); flags.push("truncated"); }
  return { text, flags: [...new Set(flags)], safe: flags.every((f) => f === "truncated") };
}
