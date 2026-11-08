import type { PoolConfig } from "pg";

const TLS_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslpassword", "uselibpqcompat"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "placeholder", "db"]);

/**
 * Pool settings for every Postgres connection, on any provider: encrypted, with the server's certificate and host
 * name checked. pg lets TLS settings in the URL override these (sslmode=no-verify turns checking off), so they are
 * removed from the URL first. The certificate is checked against the system's trusted roots, or against the
 * provider's own root certificate when DATABASE_CA_CERT holds it (PEM text, from the secret store). A database on
 * the same machine or the compose network ("db") connects without TLS. A missing or unreadable URL passes through
 * untouched, so a module that imports the client without a database still loads and fails only if it queries.
 */
export function pgPoolConfig(connectionString: string, ca: string | undefined = process.env.DATABASE_CA_CERT): PoolConfig {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return { connectionString };
  }
  for (const p of TLS_PARAMS) u.searchParams.delete(p);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTS.has(host)) return { connectionString: u.toString(), ssl: false };
  return {
    connectionString: u.toString(),
    ssl: { ...(ca ? { ca } : {}), rejectUnauthorized: true, servername: host },
  };
}
