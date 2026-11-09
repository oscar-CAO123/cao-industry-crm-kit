import { defineConfig, env } from "prisma/config";

export default defineConfig({
  datasource: {
    // Prisma's CLI (generate, migrate, seed) connects directly when DIRECT_URL is set, because a pooler cannot run
    // migrations. Otherwise it uses DATABASE_URL. The running app always uses DATABASE_URL through its pool.
    url: process.env.DIRECT_URL || env("DATABASE_URL"),
  },
  migrations: {
    seed: "npx tsx prisma/seeds/seed.ts",
  },
});
