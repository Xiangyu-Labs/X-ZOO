-- 商家发起售后: the operator who opened a refund from the order screen, usually on a
-- completed order the buyer can no longer apply on. Additive and nullable: every existing
-- row is a buyer's request or an automatic one, and reads as such.
ALTER TABLE "refunds" ADD COLUMN "initiated_by_admin_id" bigint;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiated_by_admin_id_admins_id_fk" FOREIGN KEY ("initiated_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;