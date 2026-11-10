import type { PoolConfig } from "pg";

const TLS_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslpassword", "uselibpqcompat"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "placeholder", "db"]);

/**
 * Pool settings for every Postgres connection, on any provider. The URL's sslmode is read, then its TLS settings are
 * removed so pg cannot switch checking off (sslmode=no-verify is ignored):
 * - sslmode=disable: plain text, allowed only for a database on this machine or the compose network ("db").
 * - no sslmode on a database on this machine or the compose network: plain text, as before.
 * - every other case (require, verify-ca, verify-full, or none on a remote host): encrypted, and the server's
 *   certificate and host name are checked. The check uses the system's trusted roots, or the provider's own root
 *   certificate when DATABASE_CA_CERT holds it (PEM text, from the secret store).
 * A missing or unreadable URL passes through untouched, so a module that imports the client without a database still
 * loads and fails only if it queries.
 */
export function pgPoolConfig(connectionString: string, ca: string | undefined = process.env.DATABASE_CA_CERT): PoolConfig {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return { connectionString };
  }
  const mode = (u.searchParams.get("sslmode") ?? "").toLowerCase();
  for (const p of TLS_PARAMS) u.searchParams.delete(p);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = LOCAL_HOSTS.has(host);
  if (mode === "disable") {
    if (!local) throw new Error("sslmode=disable is refused for a database that is not on this machine or the compose network");
    return { connectionString: u.toString(), ssl: false };
  }
  if (!mode && local) return { connectionString: u.toString(), ssl: false };
  return { connectionString: u.toString(), ssl: { ...(ca ? { ca } : {}), rejectUnauthorized: true, servername: host } };
}
