DROP INDEX "product_label_categories_name_uq";--> statement-breakpoint
DROP INDEX "product_labels_name_uq";--> statement-breakpoint
DROP INDEX "product_param_templates_name_uq";--> statement-breakpoint
DROP INDEX "product_protections_title_uq";--> statement-breakpoint
DROP INDEX "products_spu_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "product_label_categories_name_uq" ON "product_label_categories" USING btree ("name") WHERE "product_label_categories"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_name_uq" ON "product_labels" USING btree ("name") WHERE "product_labels"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_param_templates_name_uq" ON "product_param_templates" USING btree ("name") WHERE "product_param_templates"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_protections_title_uq" ON "product_protections" USING btree ("title") WHERE "product_protections"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_spu_uq" ON "products" USING btree ("spu") WHERE "products"."deleted_at" is null;