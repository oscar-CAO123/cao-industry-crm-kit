// Proof that a person, not the agent running the command line, approved a live act.
//
// Two ways only:
// - The CRM shell's approval click. The signed-in staff member's click makes a short-lived ticket, signed with a key
//   derived from the CRM's own BETTER_AUTH_SECRET, bound to the approval id, the decision, who clicked and any
//   done|retry answer. The runner passes it to the child process in KIT_APPROVAL_TICKET.
// - A person at the terminal. The prompt is written to and read from /dev/tty, never stdin, so piping "yes" into the
//   command does nothing. A program that opens its own pseudo-terminal could type there, so the answer is followed by
//   the computer account's own password, checked by the operating system (sudo -k, which neither caches it nor grants
//   anything): an agent that can type into a terminal still does not know it. Where sudo needs no password, or is
//   missing, terminal approval is refused and the CRM click is the only way.
// Both ways are bound to a digest of the exact acts the person was shown, so an act changed in the store after that
// cannot run on the approval. An agent must never answer this prompt or build a ticket, even when it can.
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface Decision { id: string; decision: "approve"; who: string; confirm?: "done" | "retry"; acts: string }

/** JSON with object keys sorted at every level, so the same acts always give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
/** The digest of what a person approves. Taken from the JSON form (what the store keeps and the request sends), so values
 *  that only differ in memory cannot pass for each other. The CRM shell computes the same (shell/lib/shell/approval-ticket.ts). */
export function actsDigest(v: unknown): string {
  return crypto.createHash("sha256").update(canonical(JSON.parse(JSON.stringify(v ?? null)))).digest("base64url");
}
/** An approval's headline and acts: both are what the person reads and approves. */
export const approvalDigest = (ap: { summary?: unknown; acts?: unknown }) => actsDigest({ summary: ap.summary ?? "", acts: ap.acts ?? [] });
const TTL_MS = 2 * 60_000;

function key(): Buffer | null {
  const s = process.env.BETTER_AUTH_SECRET ?? "";
  return s.length >= 32 ? crypto.createHmac("sha256", s).update("kit-approval-ticket-v1").digest() : null;
}
const payload = (d: Decision, exp: number) => JSON.stringify([d.id, d.decision, d.who, d.confirm ?? "", d.acts, exp]);

/** The CRM shell signs one decision for its runner. Throws when the CRM has no usable secret. */
export function signTicket(d: Decision, now = Date.now()): string {
  const k = key();
  if (!k) throw new Error("BETTER_AUTH_SECRET is missing or shorter than 32 characters: approvals cannot be signed");
  const exp = now + TTL_MS;
  const mac = crypto.createHmac("sha256", k).update(payload(d, exp)).digest("base64url");
  return `${exp}.${mac}`;
}

/** True only for an unexpired ticket signed for exactly this decision. */
export function verifyTicket(ticket: string | undefined, d: Decision, now = Date.now()): boolean {
  const k = key();
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(ticket ?? "");
  if (!k || !m) return false;
  const exp = Number(m[1]);
  if (!(exp > now && exp <= now + TTL_MS)) return false;
  const want = crypto.createHmac("sha256", k).update(payload(d, exp)).digest();
  const got = Buffer.from(m[2], "base64url");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Asks the person at the controlling terminal. Returns their answer, or null when there is no terminal. */
export function askTerminal(question: string): string | null {
  let fd: number;
  try { fd = fs.openSync("/dev/tty", "r+"); } catch { return null; }
  try {
    fs.writeSync(fd, question);
    const buf = Buffer.alloc(1);
    let line = "";
    while (line.length < 200) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n <= 0 || buf[0] === 10) break;
      line += String.fromCharCode(buf[0]);
    }
    return line.replace(/\r$/, "").trim();
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** Text from the store or a vendor, made safe to print on the line a person reads: control, invisible, direction and tag
 *  characters (which could redraw, hide, reorder or smuggle text) are written out as \uXXXX, so they are seen and never applied. */
export const printable = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]|\udb40[\udc00-\udc7f\udd00-\uddef]|\ud834[\udd73-\udd7a]|\ud804[\udcbd\udccd]|\ud80d[\udc30-\udc3f]|\ud82f[\udca0-\udca3]/g, (c) => { const n = c.codePointAt(0) ?? 0; return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, "0")}`; });

/** Text a person approves, shown in full or not at all: each line escaped, and refused when the escaped text is too long to
 *  read at a terminal (a part cut off would be approved unseen). */
export function showInFull(text: string): string {
  const lines = text.split("\n").map(printable);
  if (lines.length > 200 || lines.some((l) => l.length > 2000)) throw new Error("not approved: this is too long to show in full at a terminal; approve it in the CRM, which shows every input");
  return lines.join("\n");
}

/** The computer account's own password, checked by the operating system: true only when sudo asks for it and accepts it.
 *  sudo -k runs `true` without using or updating cached credentials, so no privilege outlives the check. Where sudo needs
 *  no password, or is missing, this is false: a terminal there proves nothing about who is typing. */
export function accountPassword(prompt: string): boolean {
  const opts = { stdio: "ignore" as const, timeout: 10_000, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" } };
  if (spawnSync("sudo", ["-k", "-n", "--", "true"], opts).status === 0) return false; // passwordless sudo
  const r = spawnSync("sudo", ["-k", "-p", printable(prompt).slice(0, 120).replace(/%/g, "%%"), "--", "true"], { ...opts, stdio: "inherit", timeout: 120_000 });
  return r.status === 0;
}

/** The approve command's check: a valid CRM ticket for exactly these acts, or a person at the terminal who reads the acts,
 *  types approve and then gives the account password. Throws otherwise. */
export function requirePerson(d: Decision, shown: string, ask: (q: string) => string | null = askTerminal,
                              present: (prompt: string) => boolean = accountPassword): "ticket" | "terminal" {
  const ticket = process.env.KIT_APPROVAL_TICKET;
  delete process.env.KIT_APPROVAL_TICKET; // used once here; nothing this process starts later inherits it
  if (verifyTicket(ticket, d)) return "ticket";
  const answer = ask(`Approve ${printable(d.id)}${d.confirm ? ` (${d.confirm})` : ""}:\n${showInFull(shown)}\nType approve to run exactly this: `);
  if (answer === null) throw new Error("approve needs a person: click Approve in the CRM, or run this command yourself in a terminal (it asks there, not on stdin)");
  if (answer !== "approve") throw new Error("not approved: nothing was run");
  if (!present("Your computer password, to confirm it is you: ")) throw new Error("not approved: the account password was not given (where sudo needs no password, approve in the CRM)");
  return "terminal";
}
