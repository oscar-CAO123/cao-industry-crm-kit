import type { MetadataRoute } from "next";

/** The CRM is private: nothing in it belongs in a search index. Sign-in is the only page reachable without a session. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: ["/"] } };
}
