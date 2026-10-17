-- 商品详情 becomes an ordered list of blocks (富文本 and 视频). `content_html`
-- stays, written as the rich-text blocks joined, for mini-program versions and
-- readers that only know the HTML.
ALTER TABLE "product_descriptions" ADD COLUMN "blocks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Each description written so far is one rich-text block. An empty one has no
-- blocks. A second run matches nothing: the rows it filled are no longer empty.
UPDATE "product_descriptions"
SET "blocks" = jsonb_build_array(
  jsonb_build_object('id', 'html', 'type', 'richText', 'html', "content_html")
)
WHERE "blocks" = '[]'::jsonb
  AND btrim("content_html") <> '';
