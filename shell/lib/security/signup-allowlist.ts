/**
 * Who may create an account.
 *
 * Sign-in with Google or an emailed code creates a user row on first use, so this is the sign-up gate. Accounts may
 * be created only for the email domains in AUTH_SIGNUP_DOMAINS (comma separated, set at deploy). There is no default
 * list: with nothing set, nobody can sign up. New users still land as PENDING and an admin approves them.
 */
export function allowedSignupDomains(envValue: string | undefined = process.env.AUTH_SIGNUP_DOMAINS): string[] {
  return (envValue ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedSignupEmail(email: unknown, domains: string[] = allowedSignupDomains()): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  const parts = trimmed.split("@");
  // Exactly one "@", a non-empty local part, and no whitespace anywhere.
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(trimmed)) return false;
  const domain = parts[1].toLowerCase();
  if (/[/\\]/.test(domain)) return false;
  return domains.includes(domain);
}
