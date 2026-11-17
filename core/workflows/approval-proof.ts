// Proof that a person, not the agent running the command line, approved a live act.
//
// Two ways only:
// - The CRM shell's approval click. The signed-in staff member's click makes a short-lived ticket, signed with a key
//   derived from the CRM's own BETTER_AUTH_SECRET, bound to the approval id, the decision, who clicked and any
//   done|retry answer. The runner passes it to the child process in KIT_APPROVAL_TICKET.
// - A person at the terminal. The prompt is written to and read from /dev/tty, never stdin, so piping "yes" into the
//   command does nothing, and an agent's plain shell (no terminal) cannot answer. A program that opens its own
//   pseudo-terminal could, so this stops an agent following the kit's commands, not one working around them on purpose;
//   the hard limit is that keys reach a laptop run only through op-scoped, behind Touch ID.
// An agent must never answer this prompt or build a ticket, even when it can.
import crypto from "node:crypto";
import fs from "node:fs";

export interface Decision { id: string; decision: "approve"; who: string; confirm?: "done" | "retry" }
const TTL_MS = 2 * 60_000;

function key(): Buffer | null {
  const s = process.env.BETTER_AUTH_SECRET ?? "";
  return s.length >= 32 ? crypto.createHmac("sha256", s).update("kit-approval-ticket-v1").digest() : null;
}
const payload = (d: Decision, exp: number) => JSON.stringify([d.id, d.decision, d.who, d.confirm ?? "", exp]);

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

/** The approve command's check: a valid CRM ticket, or a person typing "approve" at the terminal. Throws otherwise. */
export function requirePerson(d: Decision, summary: string, ask: (q: string) => string | null = askTerminal): "ticket" | "terminal" {
  const ticket = process.env.KIT_APPROVAL_TICKET;
  delete process.env.KIT_APPROVAL_TICKET; // used once here; nothing this process starts later inherits it
  if (verifyTicket(ticket, d)) return "ticket";
  // Summaries carry customer text: control characters could redraw the line the person reads, so they are replaced.
  const shown = summary.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 300);
  const answer = ask(`Approve ${d.id}${d.confirm ? ` (${d.confirm})` : ""}: ${shown}\nType approve to run it now: `);
  if (answer === "approve") return "terminal";
  throw new Error(answer === null
    ? "approve needs a person: click Approve in the CRM, or run this command yourself in a terminal (it asks there, not on stdin)"
    : "not approved: nothing was run");
}
