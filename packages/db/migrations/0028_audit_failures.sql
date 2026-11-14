ALTER TABLE "audit_logs" ADD COLUMN "error_code" varchar(64);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "error_detail" text;--> statement-breakpoint
CREATE INDEX "audit_logs_failed_idx" ON "audit_logs" USING btree ("created_at") WHERE "audit_logs"."status" >= 400;--> statement-breakpoint
-- Refused sign-ins written before these columns kept the code only in the payload; give them the
-- same 失败原因 a new row gets (the messages are packages/contracts/src/auth/errors.ts).
UPDATE "audit_logs" SET
  "error_code" = coalesce(substring("payload" from '"code":"([A-Z_]+)"'), 'INTERNAL'),
  "error_message" = CASE coalesce(substring("payload" from '"code":"([A-Z_]+)"'), 'INTERNAL')
    WHEN 'AUTH_INVALID_CREDENTIALS' THEN '账号或密码不正确'
    WHEN 'AUTH_ACCOUNT_DISABLED' THEN '账号已被禁用，请联系管理员'
    WHEN 'AUTH_TOO_MANY_ATTEMPTS' THEN '登录尝试过于频繁，请稍后再试'
    WHEN 'AUTH_CAPTCHA_REQUIRED' THEN '请先完成滑块验证'
    WHEN 'AUTH_CAPTCHA_INVALID' THEN '滑块验证未通过，请重试'
    ELSE '服务器开小差了，请稍后再试'
  END
WHERE "route_id" = 'auth.adminLogin' AND "status" >= 400 AND "error_code" IS NULL;
