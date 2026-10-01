ALTER TABLE "audit_logs" ADD COLUMN "actor_kind" varchar(16) DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "user_id" bigint;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_kind_known" CHECK ("audit_logs"."actor_kind" in ('admin', 'staff'));