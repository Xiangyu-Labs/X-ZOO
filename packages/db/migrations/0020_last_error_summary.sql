-- What staff read about a failure, in Chinese, next to the raw `last_error` that
-- now sits under 技术详情 (AGENTS.md rule 1). Written with `last_error` by the code
-- that failed. Additive and nullable: existing rows read as the generic line, and
-- a rolled-back image neither reads nor writes the column (a retry it records
-- leaves the old summary beside a newer `last_error`, until the next write).
ALTER TABLE "refunds" ADD COLUMN "last_error_summary" varchar(512);--> statement-breakpoint
ALTER TABLE "effects" ADD COLUMN "last_error_summary" text;