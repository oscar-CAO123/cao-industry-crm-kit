-- better-auth 1.7.x admin plugin reads and writes session."impersonatedBy" (who is acting as this user). Additive only.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "impersonatedBy" TEXT;
