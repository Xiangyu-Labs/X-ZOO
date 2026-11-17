ALTER TABLE "refunds" ADD COLUMN "hidden_by_user_at" timestamp with time zone;--> statement-breakpoint
-- Previously `hideRefund` wrote `deleted_at` (no admin delete exists for `refunds`).
-- Move those timestamps to `hidden_by_user_at` so stats, admin actions, and idempotency see them again.
UPDATE "refunds"
SET "hidden_by_user_at" = "deleted_at",
    "deleted_at" = NULL
WHERE "deleted_at" IS NOT NULL;