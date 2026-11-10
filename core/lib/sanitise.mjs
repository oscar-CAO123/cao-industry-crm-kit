// Clean outside text before an agent reads it. Returns the text and any flags.
// Hidden characters: zero width space, bidirectional marks and isolates, variation selectors, annotation marks and the whole tag
// block (U+E0000 to U+E007F) that can spell a message no person sees. The joiners used in emoji and in Persian and Indic scripts
// (U+200C, U+200D), the emoji variation selector (U+FE0F) and the soft hyphen are ordinary text and are left alone.
const HIDDEN = /[\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0D\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Letters from other alphabets that look like Latin ones. Used to MATCH the patterns only; the returned text is not changed by it.
const LOOKALIKE = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d", "ӏ": "l", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h",
  "А": "a", "В": "b", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t", "Х": "x",
  "ο": "o", "α": "a", "ν": "v", "ι": "i", "ρ": "p", "τ": "t", "κ": "k", "ε": "e", "Ο": "o", "Α": "a", "Ε": "e", "Ι": "i", "Κ": "k", "Ν": "n", "Ρ": "p", "Τ": "t",
};
const fold = (s) => s.replace(/[^\u0000-\u007F]/g, (c) => LOOKALIKE[c] ?? c);
const PATTERNS = [
  [/ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)/i, "override"],
  [/disregard (all |any |the )?(previous|prior|above|earlier)/i, "override"],
  [/forget (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)/i, "override"],
  [/you are now\b/i, "role"],
  [/system prompt/i, "prompt-probe"],
  [/reveal (your|the) (instructions|prompt|keys?|secrets?)/i, "exfiltration"],
  [/(send|post|upload|email|forward) .{0,40}(api key|token|password|secret)/i, "exfiltration"],
];
// Markup that would run if the text were ever shown in a page. Each pass removes one level, and the pass repeats until nothing
// changes, so "<scr<script>x</script>ipt>" cannot rebuild a tag. The spans are bounded so a long input cannot make this slow.
const MARKUP = [/<script\b[^>]{0,200}>[\s\S]{0,20000}?<\/script\s*>/gi, /<style\b[^>]{0,200}>[\s\S]{0,20000}?<\/style\s*>/gi, /<!--[\s\S]{0,20000}?-->/g, /<\/?script\b[^>]{0,200}>/gi, /<\/?style\b[^>]{0,200}>/gi];
function stripMarkup(t) {
  for (let i = 0; i < 8; i++) {
    const before = t;
    for (const re of MARKUP) t = t.replace(re, "");
    if (t === before) break;
  }
  return t;
}
export function sanitise(input, { maxLength = 20000 } = {}) {
  let raw = String(input ?? "");
  const flags = [];
  // Cut first: every step below then works on a bounded string, whatever the vendor sent.
  if (raw.length > maxLength) { raw = raw.slice(0, maxLength); flags.push("truncated"); }
  if (new RegExp(HIDDEN.source, HIDDEN.flags.replace("g", "")).test(raw)) flags.push("hidden-characters");
  let text = raw.normalize("NFKC").replace(HIDDEN, "").replace(CONTROL, "");
  text = stripMarkup(text);
  // Match on a copy with lookalike letters folded and all runs of white space (line breaks, doubled spaces) made single.
  const probe = fold(text).replace(/\s+/g, " ");
  for (const [re, name] of PATTERNS) if (re.test(probe)) flags.push(name);
  return { text, flags: [...new Set(flags)], safe: flags.every((f) => f === "truncated") };
}

/**
 * Looks through what a vendor sent (any JSON shape) and lists the flags found, with how many strings carried each.
 * The data is not changed: the caller decides what to do with text that is marked. Bounded in depth and in strings read.
 */
export function scanData(data, { maxStrings = 50000, maxDepth = 12, window = 5000, maxWindows = 20 } = {}) {
  const found = new Map();
  let seen = 0, limited = false;
  const add = (f) => found.set(f, (found.get(f) ?? 0) + 1);
  const walk = (v, depth) => {
    if (seen >= maxStrings || depth > maxDepth) { if (v != null) limited = true; return; }
    if (v == null) return;
    if (typeof v === "string") {
      seen++;
      if (v.length < 4) return;
      // A long string is read in overlapping windows, so words cannot hide behind padding or straddle a cut.
      const step = window - 200, count = Math.min(maxWindows, Math.ceil(v.length / step));
      for (let w = 0; w < count; w++) for (const f of sanitise(v.slice(w * step, w * step + window), { maxLength: window }).flags) if (f !== "truncated") add(f);
      if (v.length > maxWindows * step + 200) limited = true;
    } else if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); }
    else if (typeof v === "object") { for (const x of Object.values(v)) walk(x, depth + 1); }
  };
  walk(data, 0);
  if (limited) found.set("scan-limit", 1);   // part of a very large answer was not read
  return [...found.entries()].map(([flag, strings]) => ({ flag, strings }));
}
