const withNextIntl = require("next-intl/plugin")("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // One self-contained server: runs the same way in Docker on any host (see tools/shell-deploy.ts).
  output: "standalone",
  // The shell reads the kit repo at run time (industry templates and workflow records), and runs workflow decisions
  // through shell/workflows/run.ts, so the tracer must carry those files and the kit code that script imports.
  outputFileTracingRoot: require("path").join(__dirname, ".."),
  outputFileTracingIncludes: {
    "/**": ["../industries/**/*.json", "../industries/**/*.ts", "../core/**", "../tools/workflow.ts", "./workflows/**", "./lib/db-ssl.ts"],
  },
  poweredByHeader: false,
  images: {
    // Pictures come from the business's own file store (FILES_PUBLIC_ORIGIN) and Google profile pictures only.
    remotePatterns: [
      ...(process.env.FILES_PUBLIC_ORIGIN ? [{ protocol: new URL(process.env.FILES_PUBLIC_ORIGIN).protocol.replace(":", ""), hostname: new URL(process.env.FILES_PUBLIC_ORIGIN).hostname }] : []),
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
};

module.exports = withNextIntl(nextConfig);
