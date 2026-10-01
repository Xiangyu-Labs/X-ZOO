-- Stored values the code stopped reading at the cutover (docs/mini/cutover.md
-- §2.5, §2.7; docs/mini/status/X1-dead-code.md). Data only, no schema change.
-- Each statement matches nothing on a fresh database or on a second run.
--
-- destructive: approved — the 「店员与订单提醒」 group (`order-staff`: staffUserIds,
-- allowStaffRepricing, allowStaffRefundReview) went with the mobile staff console
-- (cutover §2.5) and nothing reads it. A rollback to an image from before the
-- cutover reads the defaults instead: the staff console closed to everyone, which
-- is accepted.
DELETE FROM "config_values" WHERE "group" = 'order-staff';--> statement-breakpoint
-- destructive: approved — the staff upload limits (「店员上传大小上限」「每店员每小时上传
-- 次数」) went with the staff upload branch (cutover §2.5). A rolled-back image
-- falls back to their defaults, which is accepted.
DELETE FROM "config_values"
WHERE "group" = 'storage' AND "key" IN ('maxStaffUploadBytes', 'staffUploadsPerHour');--> statement-breakpoint
-- destructive: approved — a template's `wechatMini.page` (「小程序页面」) is ignored
-- since cutover §2.7: a subscribe message opens its event's catalogue route. This
-- removes only that key and leaves the rest of the channel as saved. A rolled-back
-- image falls back to its own default page for the message, which is accepted.
UPDATE "notification_templates"
SET "channels" = jsonb_set("channels", '{wechatMini}', ("channels" -> 'wechatMini') - 'page')
WHERE jsonb_typeof("channels" -> 'wechatMini') = 'object'
  AND ("channels" -> 'wechatMini') #> '{page}' IS NOT NULL;
