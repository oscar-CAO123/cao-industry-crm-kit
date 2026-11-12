/** Connection selection is deployment configuration, not a request argument. */
export function composioEnabled(id: string): boolean {
  const provider = process.env[`KIT_${id.toUpperCase().replace(/-/g, "_")}_CONNECTION`];
  if (provider !== undefined && provider !== "direct" && provider !== "composio") throw new Error(`${id}: unknown connection provider`);
  return provider === "composio";
}
