-- What staff read about a failed background job and a refused 公众号菜单 publish, in
-- Chinese, next to the raw `error` / `publish_error` that now sits under 技术详情
-- (AGENTS.md rule 1). Written with the raw text by the code that failed. Additive and
-- nullable: existing rows read as a generic line, and a rolled-back image neither
-- reads nor writes the column.
ALTER TABLE "failed_jobs" ADD COLUMN "error_summary" text;--> statement-breakpoint
ALTER TABLE "wechat_oa_menus" ADD COLUMN "publish_error_summary" varchar(255);