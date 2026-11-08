/**
 * A single plain mailbox address, safe to place in a MIME To/Cc header.
 * Rejects display names, angle brackets, commas, semicolons, whitespace and
 * line breaks, which is what header injection needs.
 */
const PLAIN_ADDRESS = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function isPlainEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && PLAIN_ADDRESS.test(value);
}
