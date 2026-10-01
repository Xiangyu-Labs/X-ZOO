-- Drizzle does not emit extension DDL; the trigram indexes on products need this.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."product_labels_style" AS ENUM('text', 'image');--> statement-breakpoint
CREATE TYPE "public"."product_reviews_status" AS ENUM('pending', 'published', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."product_virtual_cards_state" AS ENUM('unclaimed', 'claimed', 'void');--> statement-breakpoint
CREATE TYPE "public"."products_freight_mode" AS ENUM('free', 'fixed', 'template');--> statement-breakpoint
CREATE TYPE "public"."products_kind" AS ENUM('physical', 'virtual_card', 'virtual_coupon', 'virtual_manual');--> statement-breakpoint
CREATE TYPE "public"."products_purchase_limit_mode" AS ENUM('none', 'per_order', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."products_status" AS ENUM('draft', 'on_shelf', 'off_shelf');--> statement-breakpoint
CREATE TYPE "public"."article_categories_status" AS ENUM('visible', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."articles_status" AS ENUM('draft', 'published', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."coupon_templates_claim_mode" AS ENUM('manual', 'new_user', 'order_gift', 'admin_grant');--> statement-breakpoint
CREATE TYPE "public"."coupon_templates_scope" AS ENUM('all_products', 'categories', 'products');--> statement-breakpoint
CREATE TYPE "public"."coupon_templates_status" AS ENUM('draft', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."coupon_templates_validity_mode" AS ENUM('fixed_window', 'days_after_claim');--> statement-breakpoint
CREATE TYPE "public"."user_coupons_source_kind" AS ENUM('claim', 'gift_order', 'gift_new_user', 'admin_grant');--> statement-breakpoint
CREATE TYPE "public"."user_coupons_status" AS ENUM('unused', 'used', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."diy_pages_kind" AS ENUM('home', 'category', 'product_detail', 'user_center', 'micro');--> statement-breakpoint
CREATE TYPE "public"."diy_pages_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."themes_kind" AS ENUM('built_in', 'custom');--> statement-breakpoint
CREATE TYPE "public"."groupbuy_activities_status" AS ENUM('draft', 'active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."groupbuy_groups_status" AS ENUM('forming', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."groupbuy_members_role" AS ENUM('leader', 'member');--> statement-breakpoint
CREATE TYPE "public"."groupbuy_members_status" AS ENUM('joined', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_templates_audience" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."sms_logs_status" AS ENUM('sent', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."order_invoices_header_type" AS ENUM('personal', 'company');--> statement-breakpoint
CREATE TYPE "public"."order_invoices_invoice_type" AS ENUM('plain', 'special');--> statement-breakpoint
CREATE TYPE "public"."order_invoices_status" AS ENUM('requested', 'issued', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."order_status_logs_change_type" AS ENUM('created', 'paid', 'pay_failed', 'cancelled', 'auto_cancelled', 'price_adjusted', 'address_updated', 'remark_updated', 'shipped', 'shipment_cancelled', 'shipment_updated', 'virtual_delivered', 'received', 'auto_received', 'reviewed', 'completed', 'refund_applied', 'refund_approved', 'refund_rejected', 'refund_cancelled', 'refund_succeeded', 'refund_failed', 'coupon_returned', 'coupon_granted', 'invoice_requested', 'invoice_issued', 'invoice_rejected', 'groupbuy_joined', 'groupbuy_succeeded', 'groupbuy_failed', 'hidden_by_user', 'deleted_by_admin');--> statement-breakpoint
CREATE TYPE "public"."order_status_logs_operator_kind" AS ENUM('system', 'user', 'admin', 'gateway');--> statement-breakpoint
CREATE TYPE "public"."orders_fulfillment_status" AS ENUM('unfulfilled', 'partially_fulfilled', 'fulfilled');--> statement-breakpoint
CREATE TYPE "public"."orders_kind" AS ENUM('normal', 'groupbuy', 'presale');--> statement-breakpoint
CREATE TYPE "public"."orders_platform" AS ENUM('h5', 'wechat_oa', 'wechat_mini');--> statement-breakpoint
CREATE TYPE "public"."orders_refund_status" AS ENUM('none', 'requested', 'partially_refunded', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."orders_status" AS ENUM('pending_payment', 'paid', 'shipped', 'received', 'completed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."shipments_delivery_mode" AS ENUM('express', 'merchant_delivery', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."shipments_status" AS ENUM('dispatched', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."capital_flows_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."capital_flows_kind" AS ENUM('order_payment', 'order_refund', 'exception_refund');--> statement-breakpoint
CREATE TYPE "public"."payment_attempts_channel" AS ENUM('wechat_mini', 'wechat_oa', 'wechat_h5');--> statement-breakpoint
CREATE TYPE "public"."payment_attempts_provider" AS ENUM('wechat_v3');--> statement-breakpoint
CREATE TYPE "public"."payment_attempts_status" AS ENUM('creating', 'submitted', 'paid', 'closing', 'closed', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."payment_callbacks_kind" AS ENUM('transaction_success', 'refund_success', 'refund_abnormal', 'refund_closed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."payment_exceptions_reason" AS ENUM('duplicate_payment', 'cancelled_order_payment', 'unmatched_payment', 'amount_mismatch');--> statement-breakpoint
CREATE TYPE "public"."payment_exceptions_status" AS ENUM('open', 'refunding', 'refunded', 'refund_unknown', 'refund_failed', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."presale_activities_payment_mode" AS ENUM('full', 'deposit');--> statement-breakpoint
CREATE TYPE "public"."presale_activities_status" AS ENUM('draft', 'active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."presale_orders_stage" AS ENUM('deposit_pending', 'deposit_paid', 'final_pending', 'final_paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."presale_stock_ledger_reason" AS ENUM('reserve', 'release');--> statement-breakpoint
CREATE TYPE "public"."agreements_code" AS ENUM('user_service', 'privacy_policy', 'account_cancellation', 'about_us');--> statement-breakpoint
CREATE TYPE "public"."refunds_kind" AS ENUM('refund_only', 'return_and_refund');--> statement-breakpoint
CREATE TYPE "public"."refunds_return_stage" AS ENUM('not_required', 'awaiting_shipment', 'shipped_back', 'received');--> statement-breakpoint
CREATE TYPE "public"."refunds_status" AS ENUM('applied', 'approved', 'rejected', 'processing', 'succeeded', 'failed', 'unknown', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."shipping_templates_charge_mode" AS ENUM('quantity', 'weight', 'volume');--> statement-breakpoint
CREATE TYPE "public"."product_events_kind" AS ENUM('view', 'cart', 'order', 'pay', 'refund', 'favorite');--> statement-breakpoint
CREATE TYPE "public"."attachments_driver" AS ENUM('local', 's3');--> statement-breakpoint
CREATE TYPE "public"."attachments_kind" AS ENUM('image', 'video', 'audio', 'file');--> statement-breakpoint
CREATE TYPE "public"."user_cancellation_requests_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."user_invoice_profiles_header_type" AS ENUM('personal', 'company');--> statement-breakpoint
CREATE TYPE "public"."user_invoice_profiles_invoice_type" AS ENUM('plain', 'special');--> statement-breakpoint
CREATE TYPE "public"."users_password_algo" AS ENUM('bcrypt', 'md5_legacy');--> statement-breakpoint
CREATE TYPE "public"."users_register_source" AS ENUM('h5', 'wechat_oa', 'wechat_mini', 'admin');--> statement-breakpoint
CREATE TYPE "public"."users_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."wechat_auto_replies_match_mode" AS ENUM('exact', 'contains');--> statement-breakpoint
CREATE TYPE "public"."wechat_auto_replies_reply_type" AS ENUM('text', 'image', 'voice', 'video', 'news');--> statement-breakpoint
CREATE TYPE "public"."wechat_auto_replies_trigger" AS ENUM('subscribe', 'keyword', 'default');--> statement-breakpoint
CREATE TYPE "public"."wechat_identities_platform" AS ENUM('oa', 'mini');--> statement-breakpoint
CREATE TYPE "public"."wechat_media_kind" AS ENUM('image', 'voice', 'video', 'thumb', 'news');--> statement-breakpoint
CREATE TYPE "public"."wechat_qrcodes_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "admin_roles" (
	"admin_id" bigint NOT NULL,
	"role_id" bigint NOT NULL,
	CONSTRAINT "admin_roles_admin_id_role_id_pk" PRIMARY KEY("admin_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "admins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account" varchar(64) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"password_algo" varchar(16) DEFAULT 'bcrypt' NOT NULL,
	"password_version" integer DEFAULT 1 NOT NULL,
	"name" varchar(64) NOT NULL,
	"avatar" varchar(512),
	"phone" varchar(32),
	"is_super" boolean DEFAULT false NOT NULL,
	"status" smallint DEFAULT 1 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"admin_id" bigint,
	"admin_account" varchar(64) NOT NULL,
	"route_id" varchar(128) NOT NULL,
	"method" varchar(8) NOT NULL,
	"path" varchar(512) NOT NULL,
	"target" varchar(128),
	"status" integer NOT NULL,
	"payload" text,
	"request_id" varchar(64) NOT NULL,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" bigint NOT NULL,
	"permission" varchar(128) NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"remark" varchar(255),
	"status" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"password_version" integer DEFAULT 1 NOT NULL,
	"platform" varchar(24) NOT NULL,
	"user_agent" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "cart_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"is_selected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cart_items_quantity_positive" CHECK ("cart_items"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"parent_id" bigint,
	"name" varchar(100) NOT NULL,
	"path" varchar(255) DEFAULT '/' NOT NULL,
	"level" smallint DEFAULT 0 NOT NULL,
	"icon_url" varchar(512),
	"banner_url" varchar(512),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_categories_level_non_negative" CHECK ("product_categories"."level" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_categories_map" (
	"product_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	CONSTRAINT "product_categories_map_product_id_category_id_pk" PRIMARY KEY("product_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "product_descriptions" (
	"product_id" bigint PRIMARY KEY NOT NULL,
	"content_html" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_favorites" (
	"user_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_favorites_user_id_product_id_pk" PRIMARY KEY("user_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "product_label_categories" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_label_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_labels" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" bigint,
	"name" varchar(64) NOT NULL,
	"style" "product_labels_style" DEFAULT 'text' NOT NULL,
	"font_color" varchar(32),
	"background_color" varchar(32),
	"border_color" varchar(32),
	"image_url" varchar(512),
	"is_visible" boolean DEFAULT true NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_labels_map" (
	"product_id" bigint NOT NULL,
	"label_id" bigint NOT NULL,
	CONSTRAINT "product_labels_map_product_id_label_id_pk" PRIMARY KEY("product_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "product_param_templates" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_param_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"suggested_values" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_params" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_params_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"template_id" bigint,
	"name" varchar(64) NOT NULL,
	"value" varchar(255) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_protections" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_protections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" varchar(64) NOT NULL,
	"content" varchar(2000),
	"icon_url" varchar(512),
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_protections_map" (
	"product_id" bigint NOT NULL,
	"protection_id" bigint NOT NULL,
	CONSTRAINT "product_protections_map_product_id_protection_id_pk" PRIMARY KEY("product_id","protection_id")
);
--> statement-breakpoint
CREATE TABLE "product_recommendations" (
	"product_id" bigint NOT NULL,
	"recommended_product_id" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_recommendations_product_id_recommended_product_id_pk" PRIMARY KEY("product_id","recommended_product_id"),
	CONSTRAINT "product_recommendations_not_self" CHECK ("product_recommendations"."product_id" <> "product_recommendations"."recommended_product_id")
);
--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"sku_id" bigint,
	"user_id" bigint,
	"order_id" bigint,
	"order_item_id" bigint,
	"author_nickname" varchar(64),
	"author_avatar_url" varchar(512),
	"spec_text" varchar(255),
	"product_score" smallint NOT NULL,
	"service_score" smallint NOT NULL,
	"content" varchar(1000),
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "product_reviews_status" DEFAULT 'published' NOT NULL,
	"reply_content" varchar(500),
	"reply_at" timestamp with time zone,
	"reply_by_admin_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_reviews_scores_range" CHECK ("product_reviews"."product_score" between 1 and 5 and "product_reviews"."service_score" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "product_skus" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_skus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"sku_code" varchar(32) NOT NULL,
	"spec_text" varchar(255) DEFAULT '' NOT NULL,
	"spec_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"image_url" varchar(512),
	"price" numeric(12, 2) NOT NULL,
	"original_price" numeric(12, 2),
	"cost" numeric(12, 2),
	"stock" integer DEFAULT 0 NOT NULL,
	"sales" integer DEFAULT 0 NOT NULL,
	"bar_code" varchar(50),
	"weight" numeric(12, 3),
	"volume" numeric(12, 4),
	"is_default" boolean DEFAULT false NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_skus_stock_non_negative" CHECK ("product_skus"."stock" >= 0),
	CONSTRAINT "product_skus_sales_non_negative" CHECK ("product_skus"."sales" >= 0),
	CONSTRAINT "product_skus_prices_non_negative" CHECK ("product_skus"."price" >= 0 and ("product_skus"."original_price" is null or "product_skus"."original_price" >= 0) and ("product_skus"."cost" is null or "product_skus"."cost" >= 0)),
	CONSTRAINT "product_skus_measures_non_negative" CHECK (("product_skus"."weight" is null or "product_skus"."weight" >= 0) and ("product_skus"."volume" is null or "product_skus"."volume" >= 0))
);
--> statement-breakpoint
CREATE TABLE "product_spec_values" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_spec_values_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"spec_id" bigint NOT NULL,
	"value" varchar(64) NOT NULL,
	"image_url" varchar(512),
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_specs" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_specs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"name" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_virtual_cards" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_virtual_cards_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"card_key" varchar(32) NOT NULL,
	"card_no" varchar(255) NOT NULL,
	"card_secret" varchar(255),
	"state" "product_virtual_cards_state" DEFAULT 'unclaimed' NOT NULL,
	"order_item_id" bigint,
	"claimed_by_user_id" bigint,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_virtual_cards_claim_consistent" CHECK (("product_virtual_cards"."state" = 'claimed') = ("product_virtual_cards"."order_item_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(128) NOT NULL,
	"subtitle" varchar(255),
	"keyword" varchar(255),
	"spu" varchar(32),
	"bar_code" varchar(32),
	"kind" "products_kind" DEFAULT 'physical' NOT NULL,
	"status" "products_status" DEFAULT 'draft' NOT NULL,
	"image_url" varchar(512) NOT NULL,
	"card_image_url" varchar(512),
	"slider_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"video_url" varchar(512),
	"unit_name" varchar(32),
	"price" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"original_price" numeric(12, 2),
	"cost" numeric(12, 2),
	"stock" integer DEFAULT 0 NOT NULL,
	"sales" integer DEFAULT 0 NOT NULL,
	"display_sales_boost" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"spec_mode" boolean DEFAULT false NOT NULL,
	"freight_mode" "products_freight_mode" DEFAULT 'template' NOT NULL,
	"fixed_freight" numeric(12, 2),
	"shipping_template_id" bigint,
	"purchase_limit_mode" "products_purchase_limit_mode" DEFAULT 'none' NOT NULL,
	"purchase_limit_quantity" integer,
	"min_purchase_quantity" integer DEFAULT 1 NOT NULL,
	"is_hot" boolean DEFAULT false NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	"is_best" boolean DEFAULT false NOT NULL,
	"is_benefit" boolean DEFAULT false NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"custom_form" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "products_counters_non_negative" CHECK ("products"."stock" >= 0 and "products"."sales" >= 0 and "products"."views" >= 0 and "products"."display_sales_boost" >= 0),
	CONSTRAINT "products_prices_non_negative" CHECK ("products"."price" >= 0 and ("products"."original_price" is null or "products"."original_price" >= 0) and ("products"."cost" is null or "products"."cost" >= 0) and ("products"."fixed_freight" is null or "products"."fixed_freight" >= 0)),
	CONSTRAINT "products_min_purchase_positive" CHECK ("products"."min_purchase_quantity" >= 1),
	CONSTRAINT "products_limit_quantity" CHECK (("products"."purchase_limit_mode" = 'none' and "products"."purchase_limit_quantity" is null) or ("products"."purchase_limit_mode" <> 'none' and "products"."purchase_limit_quantity" >= 1)),
	CONSTRAINT "products_freight_source" CHECK (("products"."freight_mode" = 'fixed' and "products"."fixed_freight" is not null) or ("products"."freight_mode" = 'template' and "products"."shipping_template_id" is not null) or "products"."freight_mode" = 'free')
);
--> statement-breakpoint
CREATE TABLE "article_categories" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "article_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"parent_id" bigint,
	"title" varchar(100) NOT NULL,
	"intro" varchar(255),
	"image_url" varchar(512),
	"status" "article_categories_status" DEFAULT 'visible' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "article_contents" (
	"article_id" bigint PRIMARY KEY NOT NULL,
	"content_html" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "articles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" bigint,
	"title" varchar(255) NOT NULL,
	"slug" varchar(255),
	"author" varchar(64),
	"cover_image_url" varchar(512),
	"summary" varchar(255),
	"share_title" varchar(255),
	"share_summary" varchar(255),
	"source_url" varchar(512),
	"product_id" bigint,
	"status" "articles_status" DEFAULT 'draft' NOT NULL,
	"is_hot" boolean DEFAULT false NOT NULL,
	"is_banner" boolean DEFAULT false NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "articles_views_non_negative" CHECK ("articles"."views" >= 0),
	CONSTRAINT "articles_published_shape" CHECK ("articles"."status" <> 'published' or "articles"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "coupon_template_categories" (
	"template_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	CONSTRAINT "coupon_template_categories_template_id_category_id_pk" PRIMARY KEY("template_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "coupon_template_products" (
	"template_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	CONSTRAINT "coupon_template_products_template_id_product_id_pk" PRIMARY KEY("template_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "coupon_templates" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "coupon_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"scope" "coupon_templates_scope" DEFAULT 'all_products' NOT NULL,
	"claim_mode" "coupon_templates_claim_mode" DEFAULT 'manual' NOT NULL,
	"status" "coupon_templates_status" DEFAULT 'draft' NOT NULL,
	"discount_amount" numeric(12, 2) NOT NULL,
	"min_spend" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"validity_mode" "coupon_templates_validity_mode" NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"valid_days" integer,
	"claim_from" timestamp with time zone,
	"claim_to" timestamp with time zone,
	"is_unlimited_supply" boolean DEFAULT false NOT NULL,
	"total_count" integer,
	"remaining_count" integer,
	"per_user_limit" integer,
	"gift_min_order_amount" numeric(12, 2),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "coupon_templates_discount_positive" CHECK ("coupon_templates"."discount_amount" > 0),
	CONSTRAINT "coupon_templates_min_spend_non_negative" CHECK ("coupon_templates"."min_spend" >= 0),
	CONSTRAINT "coupon_templates_counts_non_negative" CHECK (("coupon_templates"."total_count" is null or "coupon_templates"."total_count" >= 0) and ("coupon_templates"."remaining_count" is null or "coupon_templates"."remaining_count" >= 0)),
	CONSTRAINT "coupon_templates_remaining_within_total" CHECK ("coupon_templates"."remaining_count" is null or "coupon_templates"."total_count" is null or "coupon_templates"."remaining_count" <= "coupon_templates"."total_count"),
	CONSTRAINT "coupon_templates_supply_shape" CHECK (("coupon_templates"."is_unlimited_supply" and "coupon_templates"."total_count" is null and "coupon_templates"."remaining_count" is null) or (not "coupon_templates"."is_unlimited_supply" and "coupon_templates"."total_count" is not null and "coupon_templates"."remaining_count" is not null)),
	CONSTRAINT "coupon_templates_validity_shape" CHECK (("coupon_templates"."validity_mode" = 'fixed_window' and "coupon_templates"."valid_from" is not null and "coupon_templates"."valid_to" is not null and "coupon_templates"."valid_days" is null) or ("coupon_templates"."validity_mode" = 'days_after_claim' and "coupon_templates"."valid_days" >= 1 and "coupon_templates"."valid_from" is null and "coupon_templates"."valid_to" is null)),
	CONSTRAINT "coupon_templates_per_user_limit_positive" CHECK ("coupon_templates"."per_user_limit" is null or "coupon_templates"."per_user_limit" >= 1)
);
--> statement-breakpoint
CREATE TABLE "product_gift_coupons" (
	"product_id" bigint NOT NULL,
	"template_id" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_gift_coupons_product_id_template_id_pk" PRIMARY KEY("product_id","template_id")
);
--> statement-breakpoint
CREATE TABLE "user_coupons" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_coupons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"template_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"claim_slot" integer NOT NULL,
	"source_kind" "user_coupons_source_kind" NOT NULL,
	"source_order_id" bigint,
	"title" varchar(64) NOT NULL,
	"discount_amount" numeric(12, 2) NOT NULL,
	"min_spend" numeric(12, 2) NOT NULL,
	"status" "user_coupons_status" DEFAULT 'unused' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_coupons_slot_positive" CHECK ("user_coupons"."claim_slot" >= 1),
	CONSTRAINT "user_coupons_amounts_non_negative" CHECK ("user_coupons"."discount_amount" > 0 and "user_coupons"."min_spend" >= 0),
	CONSTRAINT "user_coupons_window_ordered" CHECK ("user_coupons"."valid_to" > "user_coupons"."valid_from"),
	CONSTRAINT "user_coupons_used_at_present" CHECK (("user_coupons"."status" = 'used') = ("user_coupons"."used_at" is not null)),
	CONSTRAINT "user_coupons_gift_order_present" CHECK ("user_coupons"."source_kind" <> 'gift_order' or "user_coupons"."source_order_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "diy_pages" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "diy_pages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"kind" "diy_pages_kind" NOT NULL,
	"title" varchar(100),
	"status" "diy_pages_status" DEFAULT 'draft' NOT NULL,
	"is_home" boolean DEFAULT false NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"background" jsonb,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "diy_pages_schema_version_positive" CHECK ("diy_pages"."schema_version" >= 1),
	CONSTRAINT "diy_pages_published_shape" CHECK ("diy_pages"."status" <> 'published' or "diy_pages"."published_at" is not null),
	CONSTRAINT "diy_pages_home_is_home_kind" CHECK (not "diy_pages"."is_home" or "diy_pages"."kind" = 'home')
);
--> statement-breakpoint
CREATE TABLE "page_link_categories" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "page_link_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"parent_id" bigint,
	"name" varchar(64) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_links" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "page_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" bigint,
	"name" varchar(64) NOT NULL,
	"url" varchar(255) NOT NULL,
	"param_name" varchar(64),
	"example" varchar(255),
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "themes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"intro" varchar(255),
	"kind" "themes_kind" DEFAULT 'custom' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_data" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"preview_images" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "themes_schema_version_positive" CHECK ("themes"."schema_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "groupbuy_activities" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "groupbuy_activities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"title" varchar(255) NOT NULL,
	"intro" varchar(255),
	"image_url" varchar(512),
	"slider_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "groupbuy_activities_status" DEFAULT 'draft' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"original_price" numeric(12, 2),
	"cost" numeric(12, 2),
	"seats_required" integer NOT NULL,
	"group_ttl_seconds" integer NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"sales" integer DEFAULT 0 NOT NULL,
	"total_quota" integer,
	"per_order_quantity" integer DEFAULT 1 NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"shipping_template_id" bigint,
	"views" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "groupbuy_activities_seats_required" CHECK ("groupbuy_activities"."seats_required" >= 2),
	CONSTRAINT "groupbuy_activities_ttl_positive" CHECK ("groupbuy_activities"."group_ttl_seconds" > 0),
	CONSTRAINT "groupbuy_activities_counters_non_negative" CHECK ("groupbuy_activities"."stock" >= 0 and "groupbuy_activities"."sales" >= 0 and "groupbuy_activities"."views" >= 0 and ("groupbuy_activities"."total_quota" is null or "groupbuy_activities"."total_quota" >= 0)),
	CONSTRAINT "groupbuy_activities_per_order_positive" CHECK ("groupbuy_activities"."per_order_quantity" >= 1),
	CONSTRAINT "groupbuy_activities_prices_non_negative" CHECK ("groupbuy_activities"."price" >= 0 and ("groupbuy_activities"."original_price" is null or "groupbuy_activities"."original_price" >= 0) and ("groupbuy_activities"."cost" is null or "groupbuy_activities"."cost" >= 0)),
	CONSTRAINT "groupbuy_activities_window_ordered" CHECK ("groupbuy_activities"."end_at" > "groupbuy_activities"."start_at")
);
--> statement-breakpoint
CREATE TABLE "groupbuy_activity_skus" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "groupbuy_activity_skus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"activity_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"sales" integer DEFAULT 0 NOT NULL,
	"quota" integer,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "groupbuy_activity_skus_stock_non_negative" CHECK ("groupbuy_activity_skus"."stock" >= 0),
	CONSTRAINT "groupbuy_activity_skus_sales_non_negative" CHECK ("groupbuy_activity_skus"."sales" >= 0),
	CONSTRAINT "groupbuy_activity_skus_quota_non_negative" CHECK ("groupbuy_activity_skus"."quota" is null or "groupbuy_activity_skus"."quota" >= 0),
	CONSTRAINT "groupbuy_activity_skus_price_non_negative" CHECK ("groupbuy_activity_skus"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "groupbuy_groups" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "groupbuy_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"activity_id" bigint NOT NULL,
	"leader_user_id" bigint NOT NULL,
	"seats_total" integer NOT NULL,
	"seats_taken" integer DEFAULT 0 NOT NULL,
	"status" "groupbuy_groups_status" DEFAULT 'forming' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupbuy_groups_seats_total_positive" CHECK ("groupbuy_groups"."seats_total" >= 2),
	CONSTRAINT "groupbuy_groups_seats_taken_non_negative" CHECK ("groupbuy_groups"."seats_taken" >= 0),
	CONSTRAINT "groupbuy_groups_seats_within_total" CHECK ("groupbuy_groups"."seats_taken" <= "groupbuy_groups"."seats_total"),
	CONSTRAINT "groupbuy_groups_succeeded_shape" CHECK (("groupbuy_groups"."status" = 'succeeded') = ("groupbuy_groups"."succeeded_at" is not null)),
	CONSTRAINT "groupbuy_groups_succeeded_is_full" CHECK ("groupbuy_groups"."status" <> 'succeeded' or "groupbuy_groups"."seats_taken" = "groupbuy_groups"."seats_total")
);
--> statement-breakpoint
CREATE TABLE "groupbuy_members" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "groupbuy_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"group_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"role" "groupbuy_members_role" NOT NULL,
	"status" "groupbuy_members_status" DEFAULT 'joined' NOT NULL,
	"nickname" varchar(64),
	"avatar_url" varchar(512),
	"quantity" integer DEFAULT 1 NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groupbuy_members_quantity_positive" CHECK ("groupbuy_members"."quantity" >= 1),
	CONSTRAINT "groupbuy_members_left_shape" CHECK (("groupbuy_members"."status" = 'joined') = ("groupbuy_members"."left_at" is null))
);
--> statement-breakpoint
CREATE TABLE "notification_messages" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "notification_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" varchar(64),
	"audience" "notification_templates_audience" NOT NULL,
	"user_id" bigint,
	"admin_id" bigint,
	"title" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notification_messages_recipient" CHECK (("notification_messages"."audience" = 'user' and "notification_messages"."user_id" is not null) or ("notification_messages"."audience" = 'admin'))
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "notification_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(255),
	"audience" "notification_templates_audience" DEFAULT 'user' NOT NULL,
	"channels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_logs" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "sms_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"phone" varchar(20) NOT NULL,
	"template_code" varchar(64) NOT NULL,
	"notification_code" varchar(64),
	"params" jsonb,
	"status" "sms_logs_status" NOT NULL,
	"provider_message_id" varchar(64),
	"error_code" varchar(64),
	"error_message" varchar(255),
	"request_ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_invoices" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "order_invoices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"status" "order_invoices_status" DEFAULT 'requested' NOT NULL,
	"header_type" "order_invoices_header_type" NOT NULL,
	"invoice_type" "order_invoices_invoice_type" DEFAULT 'plain' NOT NULL,
	"name" varchar(100) NOT NULL,
	"duty_number" varchar(50),
	"drawer_phone" varchar(20),
	"email" varchar(100),
	"registered_tel" varchar(30),
	"registered_address" varchar(255),
	"bank_name" varchar(100),
	"bank_account" varchar(50),
	"amount" numeric(12, 2) NOT NULL,
	"invoice_number" varchar(50),
	"remark" varchar(255),
	"issued_by_admin_id" bigint,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_invoices_amount_non_negative" CHECK ("order_invoices"."amount" >= 0),
	CONSTRAINT "order_invoices_issued_shape" CHECK (("order_invoices"."status" = 'issued') = ("order_invoices"."issued_at" is not null and "order_invoices"."invoice_number" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "order_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"item_key" varchar(32) NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"original_unit_price" numeric(12, 2),
	"cost_unit_price" numeric(12, 2),
	"discount_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"total_amount" numeric(12, 2) NOT NULL,
	"refunded_quantity" integer DEFAULT 0 NOT NULL,
	"refunded_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"shipped_quantity" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" >= 1),
	CONSTRAINT "order_items_prices_non_negative" CHECK ("order_items"."unit_price" >= 0 and "order_items"."discount_amount" >= 0 and "order_items"."total_amount" >= 0 and "order_items"."refunded_amount" >= 0 and ("order_items"."original_unit_price" is null or "order_items"."original_unit_price" >= 0) and ("order_items"."cost_unit_price" is null or "order_items"."cost_unit_price" >= 0)),
	CONSTRAINT "order_items_refunded_within_quantity" CHECK ("order_items"."refunded_quantity" >= 0 and "order_items"."refunded_quantity" <= "order_items"."quantity"),
	CONSTRAINT "order_items_shipped_within_quantity" CHECK ("order_items"."shipped_quantity" >= 0 and "order_items"."shipped_quantity" <= "order_items"."quantity"),
	CONSTRAINT "order_items_refunded_amount_within_total" CHECK ("order_items"."refunded_amount" <= "order_items"."total_amount")
);
--> statement-breakpoint
CREATE TABLE "order_status_logs" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "order_status_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"change_type" "order_status_logs_change_type" NOT NULL,
	"from_status" "orders_status",
	"to_status" "orders_status",
	"message" varchar(512),
	"operator_kind" "order_status_logs_operator_kind" DEFAULT 'system' NOT NULL,
	"operator_admin_id" bigint,
	"operator_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_no" varchar(32) NOT NULL,
	"idempotency_key" varchar(64),
	"user_id" bigint NOT NULL,
	"kind" "orders_kind" DEFAULT 'normal' NOT NULL,
	"status" "orders_status" DEFAULT 'pending_payment' NOT NULL,
	"fulfillment_status" "orders_fulfillment_status" DEFAULT 'unfulfilled' NOT NULL,
	"refund_status" "orders_refund_status" DEFAULT 'none' NOT NULL,
	"platform" "orders_platform" NOT NULL,
	"total_quantity" integer NOT NULL,
	"items_amount" numeric(12, 2) NOT NULL,
	"freight_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"coupon_discount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"payable_amount" numeric(12, 2) NOT NULL,
	"paid_amount" numeric(12, 2),
	"refunded_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"cost_amount" numeric(12, 2),
	"user_coupon_id" bigint,
	"transaction_no" varchar(64),
	"paid_at" timestamp with time zone,
	"receiver_name" varchar(32) NOT NULL,
	"receiver_phone" varchar(20) NOT NULL,
	"receiver_province" varchar(64) NOT NULL,
	"receiver_city" varchar(64) NOT NULL,
	"receiver_district" varchar(64),
	"receiver_detail" varchar(255) NOT NULL,
	"receiver_post_code" varchar(10),
	"receiver_city_id" bigint,
	"buyer_remark" varchar(512),
	"admin_remark" varchar(512),
	"custom_form" jsonb,
	"pay_expires_at" timestamp with time zone,
	"auto_receive_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_by_user_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "orders_quantity_positive" CHECK ("orders"."total_quantity" >= 1),
	CONSTRAINT "orders_amounts_non_negative" CHECK ("orders"."items_amount" >= 0 and "orders"."freight_amount" >= 0 and "orders"."coupon_discount" >= 0 and "orders"."payable_amount" >= 0 and "orders"."refunded_amount" >= 0 and ("orders"."paid_amount" is null or "orders"."paid_amount" >= 0) and ("orders"."cost_amount" is null or "orders"."cost_amount" >= 0)),
	CONSTRAINT "orders_refunded_within_paid" CHECK ("orders"."paid_amount" is null or "orders"."refunded_amount" <= "orders"."paid_amount"),
	CONSTRAINT "orders_paid_shape" CHECK (("orders"."status" in ('pending_payment','cancelled') and "orders"."paid_at" is null and "orders"."paid_amount" is null)
          or ("orders"."status" not in ('pending_payment','cancelled') and "orders"."paid_at" is not null and "orders"."paid_amount" is not null)),
	CONSTRAINT "orders_cancelled_shape" CHECK (("orders"."status" = 'cancelled') = ("orders"."cancelled_at" is not null)),
	CONSTRAINT "orders_fulfillment_matches_status" CHECK ("orders"."status" not in ('shipped','received','completed') or "orders"."fulfillment_status" = 'fulfilled')
);
--> statement-breakpoint
CREATE TABLE "shipment_items" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "shipment_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shipment_id" bigint NOT NULL,
	"order_item_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "shipment_items_quantity_positive" CHECK ("shipment_items"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "shipments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"shipment_no" varchar(32) NOT NULL,
	"delivery_mode" "shipments_delivery_mode" NOT NULL,
	"status" "shipments_status" DEFAULT 'dispatched' NOT NULL,
	"express_company_id" bigint,
	"tracking_no" varchar(64),
	"courier_name" varchar(64),
	"courier_phone" varchar(20),
	"virtual_content" text,
	"remark" varchar(255),
	"operator_admin_id" bigint,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_express_needs_tracking" CHECK ("shipments"."delivery_mode" <> 'express' or ("shipments"."express_company_id" is not null and "shipments"."tracking_no" is not null)),
	CONSTRAINT "shipments_virtual_needs_content" CHECK ("shipments"."delivery_mode" <> 'virtual' or "shipments"."virtual_content" is not null)
);
--> statement-breakpoint
CREATE TABLE "capital_flows" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "capital_flows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "capital_flows_kind" NOT NULL,
	"reference" varchar(64) NOT NULL,
	"direction" "capital_flows_direction" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"order_id" bigint,
	"user_id" bigint,
	"provider" "payment_attempts_provider" DEFAULT 'wechat_v3' NOT NULL,
	"mch_id" varchar(64),
	"transaction_id" varchar(64),
	"note" varchar(255),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_flows_amount_positive" CHECK ("capital_flows"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "payment_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"out_trade_no" varchar(64) NOT NULL,
	"provider" "payment_attempts_provider" DEFAULT 'wechat_v3' NOT NULL,
	"channel" "payment_attempts_channel" NOT NULL,
	"mch_id" varchar(64) NOT NULL,
	"app_id" varchar(64) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"payer_user_id" bigint,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "payment_attempts_status" DEFAULT 'creating' NOT NULL,
	"transaction_id" varchar(64),
	"prepay_id" varchar(128),
	"last_result" varchar(512),
	"paid_at" timestamp with time zone,
	"closed_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount" > 0),
	CONSTRAINT "payment_attempts_paid_shape" CHECK (("payment_attempts"."status" = 'paid') = ("payment_attempts"."paid_at" is not null and "payment_attempts"."transaction_id" is not null)),
	CONSTRAINT "payment_attempts_closed_shape" CHECK ("payment_attempts"."status" <> 'closed' or "payment_attempts"."closed_confirmed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "payment_callbacks" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "payment_callbacks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"provider" "payment_attempts_provider" DEFAULT 'wechat_v3' NOT NULL,
	"kind" "payment_callbacks_kind" NOT NULL,
	"mch_id" varchar(64) NOT NULL,
	"provider_notify_id" varchar(64) NOT NULL,
	"out_trade_no" varchar(64),
	"transaction_id" varchar(64),
	"signature_verified" boolean NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"result" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_exceptions" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "payment_exceptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint,
	"payment_attempt_id" bigint,
	"mch_id" varchar(64) NOT NULL,
	"transaction_id" varchar(64) NOT NULL,
	"out_trade_no" varchar(64),
	"reason" "payment_exceptions_reason" NOT NULL,
	"paid_amount" numeric(12, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "payment_exceptions_status" DEFAULT 'open' NOT NULL,
	"refund_no" varchar(64),
	"refund_request" jsonb,
	"operator_admin_id" bigint,
	"note" text,
	"refunded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"alarmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_exceptions_amount_positive" CHECK ("payment_exceptions"."paid_amount" > 0),
	CONSTRAINT "payment_exceptions_resolved_shape" CHECK ("payment_exceptions"."status" not in ('refunded','ignored') or "payment_exceptions"."resolved_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "presale_activities" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "presale_activities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"title" varchar(255) NOT NULL,
	"intro" varchar(255),
	"image_url" varchar(512),
	"slider_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "presale_activities_status" DEFAULT 'draft' NOT NULL,
	"payment_mode" "presale_activities_payment_mode" DEFAULT 'full' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"original_price" numeric(12, 2),
	"deposit_amount" numeric(12, 2),
	"stock" integer DEFAULT 0 NOT NULL,
	"sales" integer DEFAULT 0 NOT NULL,
	"total_quota" integer,
	"per_order_quantity" integer DEFAULT 1 NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"final_payment_start_at" timestamp with time zone,
	"final_payment_end_at" timestamp with time zone,
	"ship_after_days" integer DEFAULT 0 NOT NULL,
	"shipping_template_id" bigint,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "presale_activities_counters_non_negative" CHECK ("presale_activities"."stock" >= 0 and "presale_activities"."sales" >= 0 and "presale_activities"."ship_after_days" >= 0 and ("presale_activities"."total_quota" is null or "presale_activities"."total_quota" >= 0)),
	CONSTRAINT "presale_activities_per_order_positive" CHECK ("presale_activities"."per_order_quantity" >= 1),
	CONSTRAINT "presale_activities_prices_non_negative" CHECK ("presale_activities"."price" >= 0 and ("presale_activities"."original_price" is null or "presale_activities"."original_price" >= 0) and ("presale_activities"."deposit_amount" is null or "presale_activities"."deposit_amount" >= 0)),
	CONSTRAINT "presale_activities_window_ordered" CHECK ("presale_activities"."end_at" > "presale_activities"."start_at"),
	CONSTRAINT "presale_activities_deposit_shape" CHECK (("presale_activities"."payment_mode" = 'deposit' and "presale_activities"."deposit_amount" is not null and "presale_activities"."deposit_amount" < "presale_activities"."price" and "presale_activities"."final_payment_start_at" is not null and "presale_activities"."final_payment_end_at" is not null and "presale_activities"."final_payment_end_at" > "presale_activities"."final_payment_start_at")
          or ("presale_activities"."payment_mode" = 'full' and "presale_activities"."deposit_amount" is null and "presale_activities"."final_payment_start_at" is null and "presale_activities"."final_payment_end_at" is null))
);
--> statement-breakpoint
CREATE TABLE "presale_activity_skus" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "presale_activity_skus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"activity_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"deposit_amount" numeric(12, 2),
	"stock" integer DEFAULT 0 NOT NULL,
	"sales" integer DEFAULT 0 NOT NULL,
	"quota" integer,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "presale_activity_skus_stock_non_negative" CHECK ("presale_activity_skus"."stock" >= 0),
	CONSTRAINT "presale_activity_skus_sales_non_negative" CHECK ("presale_activity_skus"."sales" >= 0),
	CONSTRAINT "presale_activity_skus_quota_non_negative" CHECK ("presale_activity_skus"."quota" is null or "presale_activity_skus"."quota" >= 0),
	CONSTRAINT "presale_activity_skus_prices_non_negative" CHECK ("presale_activity_skus"."price" >= 0 and ("presale_activity_skus"."deposit_amount" is null or "presale_activity_skus"."deposit_amount" >= 0))
);
--> statement-breakpoint
CREATE TABLE "presale_orders" (
	"order_id" bigint PRIMARY KEY NOT NULL,
	"activity_id" bigint NOT NULL,
	"payment_mode" "presale_activities_payment_mode" NOT NULL,
	"stage" "presale_orders_stage" NOT NULL,
	"deposit_amount" numeric(12, 2),
	"final_amount" numeric(12, 2),
	"deposit_paid_at" timestamp with time zone,
	"final_paid_at" timestamp with time zone,
	"final_due_at" timestamp with time zone,
	"ship_not_before_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presale_orders_amounts_non_negative" CHECK (("presale_orders"."deposit_amount" is null or "presale_orders"."deposit_amount" >= 0) and ("presale_orders"."final_amount" is null or "presale_orders"."final_amount" >= 0)),
	CONSTRAINT "presale_orders_full_mode_shape" CHECK ("presale_orders"."payment_mode" <> 'full' or ("presale_orders"."deposit_amount" is null and "presale_orders"."stage" in ('final_pending','final_paid','expired','cancelled')))
);
--> statement-breakpoint
CREATE TABLE "presale_stock_ledger" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "presale_stock_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"activity_id" bigint NOT NULL,
	"activity_sku_id" bigint,
	"sku_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"reason" "presale_stock_ledger_reason" NOT NULL,
	"quantity" integer NOT NULL,
	"activity_stock_delta" integer NOT NULL,
	"activity_sales_delta" integer NOT NULL,
	"product_stock_delta" integer NOT NULL,
	"product_sales_delta" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presale_stock_ledger_quantity_positive" CHECK ("presale_stock_ledger"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "agreements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" "agreements_code" NOT NULL,
	"title" varchar(200) NOT NULL,
	"content_html" text,
	"is_visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "cities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"parent_id" bigint,
	"level" integer NOT NULL,
	"code" varchar(12),
	"name" varchar(64) NOT NULL,
	"merger_name" varchar(255),
	"lng" numeric(10, 6),
	"lat" numeric(10, 6),
	"is_visible" boolean DEFAULT true NOT NULL,
	CONSTRAINT "cities_level_range" CHECK ("cities"."level" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "express_companies" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "express_companies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_items" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "refund_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"refund_id" bigint NOT NULL,
	"order_item_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	CONSTRAINT "refund_items_quantity_positive" CHECK ("refund_items"."quantity" >= 1),
	CONSTRAINT "refund_items_amount_non_negative" CHECK ("refund_items"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refund_logs" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "refund_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"refund_id" bigint NOT NULL,
	"from_status" "refunds_status",
	"to_status" "refunds_status" NOT NULL,
	"message" text,
	"operator_admin_id" bigint,
	"operator_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "refunds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"refund_no" varchar(32) NOT NULL,
	"out_refund_no" varchar(64) NOT NULL,
	"order_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"payment_attempt_id" bigint,
	"kind" "refunds_kind" NOT NULL,
	"status" "refunds_status" DEFAULT 'applied' NOT NULL,
	"return_stage" "refunds_return_stage" DEFAULT 'not_required' NOT NULL,
	"quantity" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"includes_freight" boolean DEFAULT false NOT NULL,
	"refunded_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"request_context" jsonb,
	"gateway_refund_id" varchar(64),
	"reason" varchar(255),
	"explanation" varchar(512),
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reject_reason" varchar(255),
	"last_error" varchar(512),
	"admin_remark" varchar(255),
	"return_express_company_id" bigint,
	"return_tracking_no" varchar(64),
	"return_phone" varchar(20),
	"return_address" jsonb,
	"is_automatic" boolean DEFAULT false NOT NULL,
	"reviewed_by_admin_id" bigint,
	"reviewed_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "refunds_quantity_positive" CHECK ("refunds"."quantity" >= 1),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount" > 0),
	CONSTRAINT "refunds_refunded_within_amount" CHECK ("refunds"."refunded_amount" >= 0 and "refunds"."refunded_amount" <= "refunds"."amount"),
	CONSTRAINT "refunds_succeeded_shape" CHECK (("refunds"."status" = 'succeeded') = ("refunds"."succeeded_at" is not null)),
	CONSTRAINT "refunds_rejected_needs_reason" CHECK ("refunds"."status" <> 'rejected' or "refunds"."reject_reason" is not null),
	CONSTRAINT "refunds_return_stage_shape" CHECK (("refunds"."kind" = 'return_and_refund') = ("refunds"."return_stage" <> 'not_required'))
);
--> statement-breakpoint
CREATE TABLE "shipping_template_free_rule_cities" (
	"free_rule_id" bigint NOT NULL,
	"city_id" bigint NOT NULL,
	CONSTRAINT "shipping_template_free_rule_cities_free_rule_id_city_id_pk" PRIMARY KEY("free_rule_id","city_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_template_free_rules" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "shipping_template_free_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"template_id" bigint NOT NULL,
	"min_units" numeric(12, 2),
	"min_amount" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_template_free_rules_non_negative" CHECK (("shipping_template_free_rules"."min_units" is null or "shipping_template_free_rules"."min_units" >= 0) and ("shipping_template_free_rules"."min_amount" is null or "shipping_template_free_rules"."min_amount" >= 0)),
	CONSTRAINT "shipping_template_free_rules_needs_threshold" CHECK ("shipping_template_free_rules"."min_units" is not null or "shipping_template_free_rules"."min_amount" is not null)
);
--> statement-breakpoint
CREATE TABLE "shipping_template_no_delivery_cities" (
	"template_id" bigint NOT NULL,
	"city_id" bigint NOT NULL,
	CONSTRAINT "shipping_template_no_delivery_cities_template_id_city_id_pk" PRIMARY KEY("template_id","city_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_template_region_cities" (
	"region_id" bigint NOT NULL,
	"city_id" bigint NOT NULL,
	CONSTRAINT "shipping_template_region_cities_region_id_city_id_pk" PRIMARY KEY("region_id","city_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_template_regions" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "shipping_template_regions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"template_id" bigint NOT NULL,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"first_unit" numeric(12, 2) NOT NULL,
	"first_price" numeric(12, 2) NOT NULL,
	"additional_unit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"additional_price" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_template_regions_non_negative" CHECK ("shipping_template_regions"."first_unit" >= 0 and "shipping_template_regions"."first_price" >= 0 and "shipping_template_regions"."additional_unit" >= 0 and "shipping_template_regions"."additional_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shipping_templates" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "shipping_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"charge_mode" "shipping_templates_charge_mode" DEFAULT 'quantity' NOT NULL,
	"has_free_rules" boolean DEFAULT false NOT NULL,
	"has_no_delivery_rules" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "product_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"sku_id" bigint,
	"user_id" bigint,
	"order_id" bigint,
	"kind" "product_events_kind" NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"cost_amount" numeric(12, 2) DEFAULT '0.00' NOT NULL,
	"platform" "orders_platform",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_events_non_negative" CHECK ("product_events"."quantity" >= 0 and "product_events"."amount" >= 0 and "product_events"."cost_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "search_logs" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "search_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"keyword" varchar(128) NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"platform" "orders_platform",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_logs_result_count_non_negative" CHECK ("search_logs"."result_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_visits" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_visits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"path" varchar(255) NOT NULL,
	"platform" "orders_platform",
	"ip" varchar(45),
	"province" varchar(64),
	"stay_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_visits_stay_non_negative" CHECK ("user_visits"."stay_ms" is null or "user_visits"."stay_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attachment_categories" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "attachment_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"parent_id" bigint,
	"name" varchar(64) NOT NULL,
	"path" varchar(255) DEFAULT '/' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" bigint,
	"storage_key" varchar(512) NOT NULL,
	"driver" "attachments_driver" NOT NULL,
	"bucket" varchar(128),
	"url" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"original_name" varchar(255),
	"kind" "attachments_kind" NOT NULL,
	"mime" varchar(128) NOT NULL,
	"size" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"thumbnail_url" text,
	"uploaded_by_admin_id" bigint,
	"uploaded_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attachments_size_non_negative" CHECK ("attachments"."size" >= 0),
	CONSTRAINT "attachments_dimensions_non_negative" CHECK (("attachments"."width" is null or "attachments"."width" > 0) and ("attachments"."height" is null or "attachments"."height" > 0) and ("attachments"."duration_ms" is null or "attachments"."duration_ms" >= 0)),
	CONSTRAINT "attachments_sha256_format" CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "config_values" (
	"group" varchar(64) NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint,
	CONSTRAINT "config_values_group_key_pk" PRIMARY KEY("group","key")
);
--> statement-breakpoint
CREATE TABLE "effects" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "effects_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" varchar(32) NOT NULL,
	"scope_id" varchar(64) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failed_jobs" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "failed_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"queue" varchar(64) NOT NULL,
	"job_name" varchar(64) NOT NULL,
	"job_id" varchar(128),
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_addresses" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_addresses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"receiver_name" varchar(32) NOT NULL,
	"receiver_phone" varchar(20) NOT NULL,
	"province_id" bigint,
	"city_id" bigint,
	"district_id" bigint,
	"province_name" varchar(64) NOT NULL,
	"city_name" varchar(64) NOT NULL,
	"district_name" varchar(64),
	"detail" varchar(255) NOT NULL,
	"post_code" varchar(10),
	"lng" numeric(10, 6),
	"lat" numeric(10, 6),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_cancellation_requests" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_cancellation_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"nickname" varchar(64),
	"phone" varchar(20),
	"reason" text,
	"status" "user_cancellation_requests_status" DEFAULT 'pending' NOT NULL,
	"review_remark" varchar(255),
	"reviewed_by_admin_id" bigint,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_groups_map" (
	"user_id" bigint NOT NULL,
	"group_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_groups_map_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "user_invoice_profiles" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_invoice_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"header_type" "user_invoice_profiles_header_type" NOT NULL,
	"invoice_type" "user_invoice_profiles_invoice_type" DEFAULT 'plain' NOT NULL,
	"name" varchar(100) NOT NULL,
	"duty_number" varchar(50),
	"drawer_phone" varchar(20),
	"email" varchar(100),
	"registered_tel" varchar(30),
	"registered_address" varchar(255),
	"bank_name" varchar(100),
	"bank_account" varchar(50),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_invoice_profiles_company_needs_duty_number" CHECK ("user_invoice_profiles"."header_type" <> 'company' or "user_invoice_profiles"."duty_number" is not null)
);
--> statement-breakpoint
CREATE TABLE "user_label_categories" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_label_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_labels" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "user_labels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" bigint,
	"name" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_labels_map" (
	"user_id" bigint NOT NULL,
	"label_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_labels_map_user_id_label_id_pk" PRIMARY KEY("user_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account" varchar(64) NOT NULL,
	"phone" varchar(20),
	"password_hash" varchar(255),
	"password_algo" "users_password_algo",
	"password_version" integer DEFAULT 1 NOT NULL,
	"nickname" varchar(64),
	"avatar_url" varchar(512),
	"real_name" varchar(32),
	"birthday" timestamp with time zone,
	"admin_remark" varchar(255),
	"status" "users_status" DEFAULT 'active' NOT NULL,
	"register_source" "users_register_source",
	"register_ip" varchar(45),
	"last_login_at" timestamp with time zone,
	"last_login_ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_password_version_positive" CHECK ("users"."password_version" >= 1),
	CONSTRAINT "users_password_pair" CHECK (("users"."password_hash" is null) = ("users"."password_algo" is null))
);
--> statement-breakpoint
CREATE TABLE "wechat_auto_replies" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "wechat_auto_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trigger_kind" "wechat_auto_replies_trigger" NOT NULL,
	"keyword" varchar(64),
	"match_mode" "wechat_auto_replies_match_mode",
	"reply_type" "wechat_auto_replies_reply_type" DEFAULT 'text' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "wechat_auto_replies_keyword_shape" CHECK (("wechat_auto_replies"."trigger_kind" = 'keyword') = ("wechat_auto_replies"."keyword" is not null and "wechat_auto_replies"."match_mode" is not null))
);
--> statement-breakpoint
CREATE TABLE "wechat_identities" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "wechat_identities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"platform" "wechat_identities_platform" NOT NULL,
	"openid" varchar(64) NOT NULL,
	"unionid" varchar(64),
	"nickname" varchar(64),
	"avatar_url" varchar(512),
	"subscribed" boolean DEFAULT false NOT NULL,
	"subscribed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wechat_media" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "wechat_media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "wechat_media_kind" NOT NULL,
	"media_id" varchar(128) NOT NULL,
	"attachment_id" bigint,
	"url" text,
	"is_permanent" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_media_temporary_expires" CHECK ("wechat_media"."is_permanent" or "wechat_media"."expires_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "wechat_oa_menus" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "wechat_oa_menus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"buttons" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"publish_error" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wechat_qrcode_categories" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "wechat_qrcode_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" varchar(64) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wechat_qrcode_scans" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "wechat_qrcode_scans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"qrcode_id" bigint NOT NULL,
	"user_id" bigint,
	"openid" varchar(64),
	"is_new_follower" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wechat_qrcodes" (
	"id" bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (sequence name "wechat_qrcodes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" bigint,
	"name" varchar(100) NOT NULL,
	"scene" varchar(64) NOT NULL,
	"ticket" text,
	"image_url" varchar(512),
	"expires_at" timestamp with time zone,
	"reply_type" "wechat_auto_replies_reply_type",
	"reply_payload" jsonb,
	"scan_count" integer DEFAULT 0 NOT NULL,
	"follow_count" integer DEFAULT 0 NOT NULL,
	"status" "wechat_qrcodes_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "wechat_qrcodes_counters_non_negative" CHECK ("wechat_qrcodes"."scan_count" >= 0 and "wechat_qrcodes"."follow_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_product_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories_map" ADD CONSTRAINT "product_categories_map_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories_map" ADD CONSTRAINT "product_categories_map_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_descriptions" ADD CONSTRAINT "product_descriptions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_favorites" ADD CONSTRAINT "product_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_favorites" ADD CONSTRAINT "product_favorites_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels" ADD CONSTRAINT "product_labels_category_id_product_label_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_label_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels_map" ADD CONSTRAINT "product_labels_map_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_labels_map" ADD CONSTRAINT "product_labels_map_label_id_product_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."product_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_params" ADD CONSTRAINT "product_params_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_params" ADD CONSTRAINT "product_params_template_id_product_param_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."product_param_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_protections_map" ADD CONSTRAINT "product_protections_map_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_protections_map" ADD CONSTRAINT "product_protections_map_protection_id_product_protections_id_fk" FOREIGN KEY ("protection_id") REFERENCES "public"."product_protections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_recommendations" ADD CONSTRAINT "product_recommendations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_recommendations" ADD CONSTRAINT "product_recommendations_recommended_product_id_products_id_fk" FOREIGN KEY ("recommended_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_reply_by_admin_id_admins_id_fk" FOREIGN KEY ("reply_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "product_skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_spec_values" ADD CONSTRAINT "product_spec_values_spec_id_product_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."product_specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_specs" ADD CONSTRAINT "product_specs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_virtual_cards" ADD CONSTRAINT "product_virtual_cards_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_virtual_cards" ADD CONSTRAINT "product_virtual_cards_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_virtual_cards" ADD CONSTRAINT "product_virtual_cards_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_virtual_cards" ADD CONSTRAINT "product_virtual_cards_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shipping_template_id_shipping_templates_id_fk" FOREIGN KEY ("shipping_template_id") REFERENCES "public"."shipping_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_categories" ADD CONSTRAINT "article_categories_parent_id_article_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."article_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_contents" ADD CONSTRAINT "article_contents_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_category_id_article_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."article_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_template_categories" ADD CONSTRAINT "coupon_template_categories_template_id_coupon_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."coupon_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_template_categories" ADD CONSTRAINT "coupon_template_categories_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_template_products" ADD CONSTRAINT "coupon_template_products_template_id_coupon_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."coupon_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_template_products" ADD CONSTRAINT "coupon_template_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_gift_coupons" ADD CONSTRAINT "product_gift_coupons_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_gift_coupons" ADD CONSTRAINT "product_gift_coupons_template_id_coupon_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."coupon_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_template_id_coupon_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."coupon_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_link_categories" ADD CONSTRAINT "page_link_categories_parent_id_page_link_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."page_link_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_category_id_page_link_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."page_link_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_activities" ADD CONSTRAINT "groupbuy_activities_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_activities" ADD CONSTRAINT "groupbuy_activities_shipping_template_id_shipping_templates_id_fk" FOREIGN KEY ("shipping_template_id") REFERENCES "public"."shipping_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_activity_skus" ADD CONSTRAINT "groupbuy_activity_skus_activity_id_groupbuy_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."groupbuy_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_activity_skus" ADD CONSTRAINT "groupbuy_activity_skus_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_groups" ADD CONSTRAINT "groupbuy_groups_activity_id_groupbuy_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."groupbuy_activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_groups" ADD CONSTRAINT "groupbuy_groups_leader_user_id_users_id_fk" FOREIGN KEY ("leader_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_members" ADD CONSTRAINT "groupbuy_members_group_id_groupbuy_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groupbuy_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_members" ADD CONSTRAINT "groupbuy_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groupbuy_members" ADD CONSTRAINT "groupbuy_members_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_messages" ADD CONSTRAINT "notification_messages_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_invoices" ADD CONSTRAINT "order_invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_invoices" ADD CONSTRAINT "order_invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_invoices" ADD CONSTRAINT "order_invoices_issued_by_admin_id_admins_id_fk" FOREIGN KEY ("issued_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_logs" ADD CONSTRAINT "order_status_logs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_logs" ADD CONSTRAINT "order_status_logs_operator_admin_id_admins_id_fk" FOREIGN KEY ("operator_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_logs" ADD CONSTRAINT "order_status_logs_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_coupon_id_user_coupons_id_fk" FOREIGN KEY ("user_coupon_id") REFERENCES "public"."user_coupons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_receiver_city_id_cities_id_fk" FOREIGN KEY ("receiver_city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_express_company_id_express_companies_id_fk" FOREIGN KEY ("express_company_id") REFERENCES "public"."express_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_operator_admin_id_admins_id_fk" FOREIGN KEY ("operator_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_flows" ADD CONSTRAINT "capital_flows_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_flows" ADD CONSTRAINT "capital_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_operator_admin_id_admins_id_fk" FOREIGN KEY ("operator_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_activities" ADD CONSTRAINT "presale_activities_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_activities" ADD CONSTRAINT "presale_activities_shipping_template_id_shipping_templates_id_fk" FOREIGN KEY ("shipping_template_id") REFERENCES "public"."shipping_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_activity_skus" ADD CONSTRAINT "presale_activity_skus_activity_id_presale_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."presale_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_activity_skus" ADD CONSTRAINT "presale_activity_skus_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_orders" ADD CONSTRAINT "presale_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_orders" ADD CONSTRAINT "presale_orders_activity_id_presale_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."presale_activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_stock_ledger" ADD CONSTRAINT "presale_stock_ledger_activity_id_presale_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."presale_activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_stock_ledger" ADD CONSTRAINT "presale_stock_ledger_activity_sku_id_presale_activity_skus_id_fk" FOREIGN KEY ("activity_sku_id") REFERENCES "public"."presale_activity_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_stock_ledger" ADD CONSTRAINT "presale_stock_ledger_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presale_stock_ledger" ADD CONSTRAINT "presale_stock_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_parent_id_cities_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_logs" ADD CONSTRAINT "refund_logs_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_logs" ADD CONSTRAINT "refund_logs_operator_admin_id_admins_id_fk" FOREIGN KEY ("operator_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_logs" ADD CONSTRAINT "refund_logs_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_return_express_company_id_express_companies_id_fk" FOREIGN KEY ("return_express_company_id") REFERENCES "public"."express_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reviewed_by_admin_id_admins_id_fk" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_free_rule_cities" ADD CONSTRAINT "shipping_template_free_rule_cities_free_rule_id_shipping_template_free_rules_id_fk" FOREIGN KEY ("free_rule_id") REFERENCES "public"."shipping_template_free_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_free_rule_cities" ADD CONSTRAINT "shipping_template_free_rule_cities_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_free_rules" ADD CONSTRAINT "shipping_template_free_rules_template_id_shipping_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."shipping_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_no_delivery_cities" ADD CONSTRAINT "shipping_template_no_delivery_cities_template_id_shipping_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."shipping_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_no_delivery_cities" ADD CONSTRAINT "shipping_template_no_delivery_cities_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_region_cities" ADD CONSTRAINT "shipping_template_region_cities_region_id_shipping_template_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."shipping_template_regions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_region_cities" ADD CONSTRAINT "shipping_template_region_cities_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_template_regions" ADD CONSTRAINT "shipping_template_regions_template_id_shipping_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."shipping_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_sku_id_product_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_logs" ADD CONSTRAINT "search_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_visits" ADD CONSTRAINT "user_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_categories" ADD CONSTRAINT "attachment_categories_parent_id_attachment_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."attachment_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_category_id_attachment_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."attachment_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_admin_id_admins_id_fk" FOREIGN KEY ("uploaded_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_province_id_cities_id_fk" FOREIGN KEY ("province_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_district_id_cities_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cancellation_requests" ADD CONSTRAINT "user_cancellation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cancellation_requests" ADD CONSTRAINT "user_cancellation_requests_reviewed_by_admin_id_admins_id_fk" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups_map" ADD CONSTRAINT "user_groups_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups_map" ADD CONSTRAINT "user_groups_map_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invoice_profiles" ADD CONSTRAINT "user_invoice_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_labels" ADD CONSTRAINT "user_labels_category_id_user_label_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."user_label_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_labels_map" ADD CONSTRAINT "user_labels_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_labels_map" ADD CONSTRAINT "user_labels_map_label_id_user_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."user_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_identities" ADD CONSTRAINT "wechat_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_media" ADD CONSTRAINT "wechat_media_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_qrcode_scans" ADD CONSTRAINT "wechat_qrcode_scans_qrcode_id_wechat_qrcodes_id_fk" FOREIGN KEY ("qrcode_id") REFERENCES "public"."wechat_qrcodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_qrcode_scans" ADD CONSTRAINT "wechat_qrcode_scans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_qrcodes" ADD CONSTRAINT "wechat_qrcodes_category_id_wechat_qrcode_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."wechat_qrcode_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_roles_role_idx" ON "admin_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admins_account_lower_key" ON "admins" USING btree (lower("account"));--> statement-breakpoint
CREATE INDEX "audit_logs_admin_idx" ON "audit_logs" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_route_idx" ON "audit_logs" USING btree ("route_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_key" ON "roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_expires_idx" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_user_sku_uq" ON "cart_items" USING btree ("user_id","sku_id");--> statement-breakpoint
CREATE INDEX "cart_items_user_idx" ON "cart_items" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "cart_items_product_idx" ON "cart_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_categories_parent_idx" ON "product_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "product_categories_path_idx" ON "product_categories" USING btree ("path");--> statement-breakpoint
CREATE INDEX "product_categories_visible_idx" ON "product_categories" USING btree ("is_visible","sort_order");--> statement-breakpoint
CREATE INDEX "product_categories_map_category_idx" ON "product_categories_map" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "product_favorites_product_idx" ON "product_favorites" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_label_categories_name_uq" ON "product_label_categories" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "product_labels_name_uq" ON "product_labels" USING btree ("name");--> statement-breakpoint
CREATE INDEX "product_labels_category_idx" ON "product_labels" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "product_labels_map_label_idx" ON "product_labels_map" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_param_templates_name_uq" ON "product_param_templates" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "product_params_name_uq" ON "product_params" USING btree ("product_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "product_protections_title_uq" ON "product_protections" USING btree ("title");--> statement-breakpoint
CREATE INDEX "product_protections_map_protection_idx" ON "product_protections_map" USING btree ("protection_id");--> statement-breakpoint
CREATE INDEX "product_reviews_product_idx" ON "product_reviews" USING btree ("product_id","status","created_at");--> statement-breakpoint
CREATE INDEX "product_reviews_user_idx" ON "product_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_order_item_uq" ON "product_reviews" USING btree ("order_item_id") WHERE order_item_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_skus_code_uq" ON "product_skus" USING btree ("sku_code");--> statement-breakpoint
CREATE UNIQUE INDEX "product_skus_spec_uq" ON "product_skus" USING btree ("product_id","spec_text");--> statement-breakpoint
CREATE INDEX "product_skus_product_idx" ON "product_skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_skus_default_uq" ON "product_skus" USING btree ("product_id") WHERE is_default;--> statement-breakpoint
CREATE UNIQUE INDEX "product_spec_values_value_uq" ON "product_spec_values" USING btree ("spec_id","value");--> statement-breakpoint
CREATE UNIQUE INDEX "product_specs_name_uq" ON "product_specs" USING btree ("product_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "product_virtual_cards_key_uq" ON "product_virtual_cards" USING btree ("card_key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_virtual_cards_order_item_uq" ON "product_virtual_cards" USING btree ("order_item_id") WHERE order_item_id is not null;--> statement-breakpoint
CREATE INDEX "product_virtual_cards_available_idx" ON "product_virtual_cards" USING btree ("sku_id","id") WHERE state = 'unclaimed';--> statement-breakpoint
CREATE UNIQUE INDEX "products_spu_uq" ON "products" USING btree ("spu");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status","sort_order");--> statement-breakpoint
CREATE INDEX "products_price_idx" ON "products" USING btree ("price");--> statement-breakpoint
CREATE INDEX "products_sales_idx" ON "products" USING btree ("sales");--> statement-breakpoint
CREATE INDEX "products_created_at_idx" ON "products" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "products_shipping_template_idx" ON "products" USING btree ("shipping_template_id");--> statement-breakpoint
CREATE INDEX "products_name_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_keyword_trgm_idx" ON "products" USING gin ("keyword" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "article_categories_parent_idx" ON "article_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "article_categories_status_idx" ON "article_categories" USING btree ("status","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_slug_uq" ON "articles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "articles_category_idx" ON "articles" USING btree ("category_id","status","sort_order");--> statement-breakpoint
CREATE INDEX "articles_status_idx" ON "articles" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "articles_product_idx" ON "articles" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "coupon_template_categories_category_idx" ON "coupon_template_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "coupon_template_products_product_idx" ON "coupon_template_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "coupon_templates_status_idx" ON "coupon_templates" USING btree ("status","sort_order");--> statement-breakpoint
CREATE INDEX "coupon_templates_claim_mode_idx" ON "coupon_templates" USING btree ("claim_mode","status");--> statement-breakpoint
CREATE INDEX "product_gift_coupons_template_idx" ON "product_gift_coupons" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_coupons_slot_uq" ON "user_coupons" USING btree ("template_id","user_id","claim_slot");--> statement-breakpoint
CREATE UNIQUE INDEX "user_coupons_order_gift_uq" ON "user_coupons" USING btree ("source_order_id","template_id") WHERE source_kind = 'gift_order';--> statement-breakpoint
CREATE INDEX "user_coupons_user_idx" ON "user_coupons" USING btree ("user_id","status","valid_to");--> statement-breakpoint
CREATE INDEX "user_coupons_expiry_idx" ON "user_coupons" USING btree ("valid_to") WHERE status = 'unused';--> statement-breakpoint
CREATE INDEX "user_coupons_template_idx" ON "user_coupons" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "diy_pages_kind_idx" ON "diy_pages" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "diy_pages_home_uq" ON "diy_pages" USING btree ("is_home") WHERE is_home and deleted_at is null;--> statement-breakpoint
CREATE INDEX "page_link_categories_parent_idx" ON "page_link_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_links_url_uq" ON "page_links" USING btree ("url");--> statement-breakpoint
CREATE INDEX "page_links_category_idx" ON "page_links" USING btree ("category_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "themes_active_uq" ON "themes" USING btree ("is_active") WHERE is_active and deleted_at is null;--> statement-breakpoint
CREATE INDEX "groupbuy_activities_product_idx" ON "groupbuy_activities" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "groupbuy_activities_status_idx" ON "groupbuy_activities" USING btree ("status","start_at","end_at");--> statement-breakpoint
CREATE UNIQUE INDEX "groupbuy_activity_skus_uq" ON "groupbuy_activity_skus" USING btree ("activity_id","sku_id");--> statement-breakpoint
CREATE INDEX "groupbuy_activity_skus_sku_idx" ON "groupbuy_activity_skus" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "groupbuy_groups_activity_idx" ON "groupbuy_groups" USING btree ("activity_id","status");--> statement-breakpoint
CREATE INDEX "groupbuy_groups_leader_idx" ON "groupbuy_groups" USING btree ("leader_user_id");--> statement-breakpoint
CREATE INDEX "groupbuy_groups_expiry_idx" ON "groupbuy_groups" USING btree ("expires_at") WHERE status = 'forming';--> statement-breakpoint
CREATE UNIQUE INDEX "groupbuy_members_group_user_uq" ON "groupbuy_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groupbuy_members_order_uq" ON "groupbuy_members" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groupbuy_members_leader_uq" ON "groupbuy_members" USING btree ("group_id") WHERE role = 'leader' and status = 'joined';--> statement-breakpoint
CREATE INDEX "groupbuy_members_user_idx" ON "groupbuy_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_messages_user_idx" ON "notification_messages" USING btree ("user_id","created_at") WHERE audience = 'user';--> statement-breakpoint
CREATE INDEX "notification_messages_admin_idx" ON "notification_messages" USING btree ("admin_id","created_at") WHERE audience = 'admin';--> statement-breakpoint
CREATE INDEX "notification_messages_unread_idx" ON "notification_messages" USING btree ("user_id") WHERE read_at is null and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_code_uq" ON "notification_templates" USING btree ("code");--> statement-breakpoint
CREATE INDEX "notification_templates_audience_idx" ON "notification_templates" USING btree ("audience");--> statement-breakpoint
CREATE INDEX "sms_logs_phone_idx" ON "sms_logs" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "sms_logs_created_at_idx" ON "sms_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sms_logs_status_idx" ON "sms_logs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_invoices_open_uq" ON "order_invoices" USING btree ("order_id") WHERE status in ('requested','issued');--> statement-breakpoint
CREATE INDEX "order_invoices_status_idx" ON "order_invoices" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "order_invoices_user_idx" ON "order_invoices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_key_uq" ON "order_items" USING btree ("order_id","item_key");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "order_items_sku_idx" ON "order_items" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "order_status_logs_order_idx" ON "order_status_logs" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_status_logs_type_idx" ON "order_status_logs" USING btree ("change_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_no_uq" ON "orders" USING btree ("order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_uq" ON "orders" USING btree ("user_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_refund_status_idx" ON "orders" USING btree ("refund_status") WHERE refund_status <> 'none';--> statement-breakpoint
CREATE INDEX "orders_fulfillment_idx" ON "orders" USING btree ("fulfillment_status") WHERE status = 'paid';--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_paid_at_idx" ON "orders" USING btree ("paid_at");--> statement-breakpoint
CREATE INDEX "orders_transaction_no_idx" ON "orders" USING btree ("transaction_no");--> statement-breakpoint
CREATE INDEX "orders_user_coupon_idx" ON "orders" USING btree ("user_coupon_id");--> statement-breakpoint
CREATE INDEX "orders_pay_expires_idx" ON "orders" USING btree ("pay_expires_at") WHERE status = 'pending_payment';--> statement-breakpoint
CREATE INDEX "orders_auto_receive_idx" ON "orders" USING btree ("auto_receive_at") WHERE status = 'shipped';--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_items_uq" ON "shipment_items" USING btree ("shipment_id","order_item_id");--> statement-breakpoint
CREATE INDEX "shipment_items_order_item_idx" ON "shipment_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_no_uq" ON "shipments" USING btree ("shipment_no");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_tracking_idx" ON "shipments" USING btree ("tracking_no");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_flows_reference_uq" ON "capital_flows" USING btree ("kind","reference");--> statement-breakpoint
CREATE INDEX "capital_flows_order_idx" ON "capital_flows" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "capital_flows_occurred_at_idx" ON "capital_flows" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_out_trade_no_uq" ON "payment_attempts" USING btree ("out_trade_no");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_idx" ON "payment_attempts" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_status_idx" ON "payment_attempts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_transaction_uq" ON "payment_attempts" USING btree ("mch_id","transaction_id") WHERE transaction_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_open_uq" ON "payment_attempts" USING btree ("order_id") WHERE status in ('creating','submitted','closing','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_callbacks_notify_uq" ON "payment_callbacks" USING btree ("mch_id","provider_notify_id");--> statement-breakpoint
CREATE INDEX "payment_callbacks_out_trade_no_idx" ON "payment_callbacks" USING btree ("out_trade_no");--> statement-breakpoint
CREATE INDEX "payment_callbacks_created_at_idx" ON "payment_callbacks" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_exceptions_transaction_uq" ON "payment_exceptions" USING btree ("mch_id","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_exceptions_refund_no_uq" ON "payment_exceptions" USING btree ("refund_no");--> statement-breakpoint
CREATE INDEX "payment_exceptions_order_idx" ON "payment_exceptions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_exceptions_status_idx" ON "payment_exceptions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "presale_activities_product_idx" ON "presale_activities" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "presale_activities_status_idx" ON "presale_activities" USING btree ("status","start_at","end_at");--> statement-breakpoint
CREATE INDEX "presale_activities_expiry_idx" ON "presale_activities" USING btree ("end_at") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "presale_activity_skus_uq" ON "presale_activity_skus" USING btree ("activity_id","sku_id");--> statement-breakpoint
CREATE INDEX "presale_activity_skus_sku_idx" ON "presale_activity_skus" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "presale_orders_activity_idx" ON "presale_orders" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "presale_orders_final_due_idx" ON "presale_orders" USING btree ("final_due_at") WHERE stage = 'final_pending';--> statement-breakpoint
CREATE UNIQUE INDEX "presale_stock_ledger_order_reason_uq" ON "presale_stock_ledger" USING btree ("order_id","reason");--> statement-breakpoint
CREATE INDEX "presale_stock_ledger_activity_idx" ON "presale_stock_ledger" USING btree ("activity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agreements_code_uq" ON "agreements" USING btree ("code");--> statement-breakpoint
CREATE INDEX "cities_parent_idx" ON "cities" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "cities_level_idx" ON "cities" USING btree ("level");--> statement-breakpoint
CREATE INDEX "cities_name_idx" ON "cities" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "cities_code_uq" ON "cities" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "express_companies_code_uq" ON "express_companies" USING btree ("code");--> statement-breakpoint
CREATE INDEX "express_companies_enabled_idx" ON "express_companies" USING btree ("is_enabled","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_items_uq" ON "refund_items" USING btree ("refund_id","order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_items_open_uq" ON "refund_items" USING btree ("order_item_id") WHERE is_open;--> statement-breakpoint
CREATE INDEX "refund_items_order_item_idx" ON "refund_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "refund_logs_refund_idx" ON "refund_logs" USING btree ("refund_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_no_uq" ON "refunds" USING btree ("refund_no");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_out_refund_no_uq" ON "refunds" USING btree ("out_refund_no");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_user_idx" ON "refunds" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "refunds_open_idx" ON "refunds" USING btree ("order_id") WHERE status in ('applied','approved','processing','unknown');--> statement-breakpoint
CREATE INDEX "shipping_template_free_rule_cities_city_idx" ON "shipping_template_free_rule_cities" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "shipping_template_free_rules_template_idx" ON "shipping_template_free_rules" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "shipping_template_no_delivery_cities_city_idx" ON "shipping_template_no_delivery_cities" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "shipping_template_region_cities_city_idx" ON "shipping_template_region_cities" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "shipping_template_regions_template_idx" ON "shipping_template_regions" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_template_regions_fallback_uq" ON "shipping_template_regions" USING btree ("template_id") WHERE is_fallback;--> statement-breakpoint
CREATE INDEX "shipping_templates_sort_idx" ON "shipping_templates" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "product_events_product_idx" ON "product_events" USING btree ("product_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "product_events_created_at_idx" ON "product_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "product_events_user_idx" ON "product_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "product_events_order_idx" ON "product_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "search_logs_keyword_idx" ON "search_logs" USING btree ("keyword","created_at");--> statement-breakpoint
CREATE INDEX "search_logs_created_at_idx" ON "search_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "search_logs_user_idx" ON "search_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_visits_created_at_idx" ON "user_visits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_visits_user_idx" ON "user_visits" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_visits_platform_idx" ON "user_visits" USING btree ("platform","created_at");--> statement-breakpoint
CREATE INDEX "attachment_categories_parent_idx" ON "attachment_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "attachment_categories_path_idx" ON "attachment_categories" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key_uq" ON "attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "attachments_category_idx" ON "attachments" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "attachments_sha256_idx" ON "attachments" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "attachments_created_at_idx" ON "attachments" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "effects_scope_event_key" ON "effects" USING btree ("scope","scope_id","event_type");--> statement-breakpoint
CREATE INDEX "effects_due_idx" ON "effects" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "effects_scope_idx" ON "effects" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "failed_jobs_queue_idx" ON "failed_jobs" USING btree ("queue","created_at");--> statement-breakpoint
CREATE INDEX "user_addresses_user_idx" ON "user_addresses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_addresses_default_uq" ON "user_addresses" USING btree ("user_id") WHERE is_default and deleted_at is null;--> statement-breakpoint
CREATE INDEX "user_cancellation_requests_status_idx" ON "user_cancellation_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_cancellation_requests_open_uq" ON "user_cancellation_requests" USING btree ("user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "user_groups_name_uq" ON "user_groups" USING btree ("name");--> statement-breakpoint
CREATE INDEX "user_groups_map_group_idx" ON "user_groups_map" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "user_invoice_profiles_user_idx" ON "user_invoice_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_invoice_profiles_default_uq" ON "user_invoice_profiles" USING btree ("user_id") WHERE is_default and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_label_categories_name_uq" ON "user_label_categories" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "user_labels_name_uq" ON "user_labels" USING btree ("name");--> statement-breakpoint
CREATE INDEX "user_labels_category_idx" ON "user_labels" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "user_labels_map_label_idx" ON "user_labels_map" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_lower_uq" ON "users" USING btree (lower("account"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_lower_uq" ON "users" USING btree (lower("phone"));--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_auto_replies_singleton_uq" ON "wechat_auto_replies" USING btree ("trigger_kind") WHERE trigger_kind in ('subscribe','default') and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_auto_replies_keyword_uq" ON "wechat_auto_replies" USING btree ("keyword") WHERE trigger_kind = 'keyword' and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_identities_openid_uq" ON "wechat_identities" USING btree ("platform","openid");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_identities_user_platform_uq" ON "wechat_identities" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "wechat_identities_unionid_idx" ON "wechat_identities" USING btree ("unionid");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_media_uq" ON "wechat_media" USING btree ("kind","media_id");--> statement-breakpoint
CREATE INDEX "wechat_media_attachment_idx" ON "wechat_media" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_oa_menus_active_uq" ON "wechat_oa_menus" USING btree ("is_active") WHERE is_active and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_qrcode_categories_name_uq" ON "wechat_qrcode_categories" USING btree ("name");--> statement-breakpoint
CREATE INDEX "wechat_qrcode_scans_qrcode_idx" ON "wechat_qrcode_scans" USING btree ("qrcode_id","created_at");--> statement-breakpoint
CREATE INDEX "wechat_qrcode_scans_user_idx" ON "wechat_qrcode_scans" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_qrcodes_scene_uq" ON "wechat_qrcodes" USING btree ("scene");--> statement-breakpoint
CREATE INDEX "wechat_qrcodes_category_idx" ON "wechat_qrcodes" USING btree ("category_id");