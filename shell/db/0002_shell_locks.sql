-- The approval lock as a lease row (see workflows/pg-store.ts). Additive only: a new table.
CREATE TABLE IF NOT EXISTS "shell_Locks" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shell_Locks_pkey" PRIMARY KEY ("name")
);
