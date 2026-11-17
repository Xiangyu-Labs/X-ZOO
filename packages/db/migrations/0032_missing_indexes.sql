CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "product_reviews_status_idx" ON "product_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "product_virtual_cards_product_idx" ON "product_virtual_cards" USING btree ("product_id","state","id");--> statement-breakpoint
CREATE INDEX "product_virtual_cards_sku_idx" ON "product_virtual_cards" USING btree ("sku_id","card_no");--> statement-breakpoint
CREATE INDEX "orders_completion_due_idx" ON "orders" USING btree ("received_at") WHERE status = 'received';--> statement-breakpoint
CREATE INDEX "orders_completed_at_idx" ON "orders" USING btree ("completed_at") WHERE status = 'completed';--> statement-breakpoint
CREATE INDEX "payment_attempts_stale_idx" ON "payment_attempts" USING btree ("updated_at") WHERE status in ('creating','submitted','closing','unknown');--> statement-breakpoint
CREATE INDEX "payment_exceptions_unsettled_idx" ON "payment_exceptions" USING btree ("updated_at") WHERE status in ('refunding','refund_unknown');--> statement-breakpoint
CREATE INDEX "refunds_executable_idx" ON "refunds" USING btree ("updated_at") WHERE status in ('processing','unknown');--> statement-breakpoint
CREATE INDEX "product_events_kind_idx" ON "product_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "attachments_tombstone_idx" ON "attachments" USING btree ("id") WHERE deleted_at is not null;--> statement-breakpoint
CREATE INDEX "effects_prunable_idx" ON "effects" USING btree ("id") WHERE status = 'done' and scope not in ('shipment');--> statement-breakpoint
CREATE INDEX "failed_jobs_open_idx" ON "failed_jobs" USING btree ("id") WHERE resolved_at is null;