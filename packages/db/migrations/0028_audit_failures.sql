ALTER TABLE "audit_logs" ADD COLUMN "error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "error_detail" text;--> statement-breakpoint
CREATE INDEX "audit_logs_failed_idx" ON "audit_logs" USING btree ("created_at") WHERE "audit_logs"."status" >= 400;