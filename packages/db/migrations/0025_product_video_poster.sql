-- The cover the product page shows over its main video until it plays. Empty
-- means the product's 商品缩略图 (`image_url`), so existing products need nothing.
ALTER TABLE "products" ADD COLUMN "video_poster_url" varchar(512);
