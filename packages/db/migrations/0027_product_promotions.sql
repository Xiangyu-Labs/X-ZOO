CREATE TABLE "product_promotions" (
	"product_id" bigint PRIMARY KEY NOT NULL,
	"presale_activity_id" bigint,
	"groupbuy_activity_id" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_promotions_exclusive" CHECK ("product_promotions"."presale_activity_id" is null or "product_promotions"."groupbuy_activity_id" is null),
	CONSTRAINT "product_promotions_version_positive" CHECK ("product_promotions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "product_promotions" ADD CONSTRAINT "product_promotions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_promotions" ADD CONSTRAINT "product_promotions_presale_activity_id_presale_activities_id_fk" FOREIGN KEY ("presale_activity_id") REFERENCES "public"."presale_activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_promotions" ADD CONSTRAINT "product_promotions_groupbuy_activity_id_groupbuy_activities_id_fk" FOREIGN KEY ("groupbuy_activity_id") REFERENCES "public"."groupbuy_activities"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Adopt only unambiguous existing campaigns. Conflicting legacy rows are shown
-- in 商品编辑 for an explicit selection; no campaign is silently discarded.
WITH candidates AS (
  SELECT product_id, id, 'presale' AS kind FROM presale_activities
  WHERE deleted_at IS NULL AND status <> 'ended' AND end_at > now()
  UNION ALL
  SELECT product_id, id, 'groupbuy' AS kind FROM groupbuy_activities
  WHERE deleted_at IS NULL AND status <> 'ended' AND end_at > now()
), single_campaign AS (
  SELECT product_id FROM candidates GROUP BY product_id HAVING count(*) = 1
)
INSERT INTO product_promotions (product_id, presale_activity_id, groupbuy_activity_id)
SELECT c.product_id,
  CASE WHEN c.kind = 'presale' THEN c.id ELSE NULL END,
  CASE WHEN c.kind = 'groupbuy' THEN c.id ELSE NULL END
FROM candidates c JOIN single_campaign s USING (product_id);
