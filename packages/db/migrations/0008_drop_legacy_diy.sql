-- destructive: approved — diy_pages was read only by the legacy diy editor and
-- the uni-app storefront, both deleted at the cutover (docs/mini/cutover.md §2.3,
-- §2.11); production keeps no data here worth saving. An automatic rollback to
-- the previous image breaks the old H5 home page and old admin 装修 only — accepted.
DROP TABLE "diy_pages" CASCADE;--> statement-breakpoint
-- destructive: approved — page_link_categories fed only the legacy diy link
-- library (deleted with the old editor, cutover §2.3/§2.11); no data to keep, and a
-- rolled-back previous image losing its old link picker is accepted.
DROP TABLE "page_link_categories" CASCADE;--> statement-breakpoint
-- destructive: approved — page_links held the uni-app page paths for the legacy
-- diy link library (cutover §2.3/§2.6/§2.11); nothing reads it now and no data is
-- kept. A rolled-back previous image losing its old link picker is accepted.
DROP TABLE "page_links" CASCADE;--> statement-breakpoint
-- destructive: approved — themes was the legacy diy 主题, replaced by decor v2 and
-- app/config (cutover §2.3/§2.11); no data to keep. A rolled-back previous image
-- falling back without a theme on the old storefront is accepted.
DROP TABLE "themes" CASCADE;--> statement-breakpoint
DROP TYPE "public"."diy_pages_kind";--> statement-breakpoint
DROP TYPE "public"."diy_pages_status";--> statement-breakpoint
DROP TYPE "public"."themes_kind";
