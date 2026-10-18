CREATE TYPE "public"."account_kind" AS ENUM('demo', 'live');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('connecting', 'connected', 'disconnected', 'degraded', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."agent_account_role" AS ENUM('master', 'slave', 'both');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('connected', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('login', 'logout', 'register', 'password_changed', 'account_created', 'account_deleted', 'account_enabled', 'account_disabled', 'copier_created', 'copier_updated', 'copier_deleted', 'follower_updated', 'symbol_mapping_updated', 'emergency_close', 'api_key_created', 'api_key_revoked', 'share_created', 'share_revoked', 'equity_protection_updated');--> statement-breakpoint
CREATE TYPE "public"."billing_interval" AS ENUM('month', 'quarter', 'semiannual', 'year');--> statement-breakpoint
CREATE TYPE "public"."command_kind" AS ENUM('open', 'close', 'close_partial', 'modify', 'place_pending', 'cancel_pending', 'close_all');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('queued', 'dispatched', 'acked', 'failed', 'dead', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."copier_status" AS ENUM('enabled', 'disabled_monitor_existing', 'disabled', 'paused');--> statement-breakpoint
CREATE TYPE "public"."equity_protection_rule" AS ENUM('max_drawdown_percent', 'max_drawdown_value', 'absolute_min_equity', 'max_profit_percent', 'max_profit_value', 'absolute_max_equity');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."link_status" AS ENUM('pending', 'open', 'partial', 'closed', 'failed', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."master_trade_state" AS ENUM('open', 'partial', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_channel_kind" AS ENUM('email', 'telegram', 'webhook', 'slack', 'discord');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('queued', 'sent', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('market', 'pending');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('mt4', 'mt5', 'ctrader', 'matchtrader', 'tradelocker', 'dxtrade', 'mock');--> statement-breakpoint
CREATE TYPE "public"."risk_type" AS ENUM('LOT_MULTIPLIER', 'FIXED_LOT', 'BALANCE_MULTIPLIER', 'FIXED_BALANCE_MULTIPLIER', 'FIXED_PERCENT_RISK');--> statement-breakpoint
CREATE TYPE "public"."share_role" AS ENUM('viewer', 'manager', 'copier');--> statement-breakpoint
CREATE TYPE "public"."share_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'trialing', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."trade_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_closed_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"ticket" text NOT NULL,
	"symbol" text NOT NULL,
	"side" "trade_side" NOT NULL,
	"volume" numeric(18, 4) NOT NULL,
	"open_price" numeric(24, 10) NOT NULL,
	"close_price" numeric(24, 10) NOT NULL,
	"stop_loss" numeric(24, 10),
	"take_profit" numeric(24, 10),
	"magic" integer DEFAULT 0 NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"profit" numeric(24, 8) NOT NULL,
	"swap" numeric(24, 8) DEFAULT '0' NOT NULL,
	"commission" numeric(24, 8) DEFAULT '0' NOT NULL,
	"follower_id" text,
	"request_id" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"password_encrypted" text,
	"investor_password_encrypted" text,
	"api_token_encrypted" text,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_daily_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"reset_day" date NOT NULL,
	"reference_balance" numeric(24, 8) NOT NULL,
	"reference_equity" numeric(24, 8) NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"grantee_user_id" text NOT NULL,
	"role" "share_role" DEFAULT 'viewer' NOT NULL,
	"status" "share_status" DEFAULT 'active' NOT NULL,
	"permissions" jsonb DEFAULT '{"balance":true,"equity":true,"history":true,"canCopy":false}'::jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"balance" numeric(24, 8) NOT NULL,
	"equity" numeric(24, 8) NOT NULL,
	"margin" numeric(24, 8),
	"free_margin" numeric(24, 8),
	"open_positions" integer DEFAULT 0 NOT NULL,
	"open_volume" numeric(18, 4) DEFAULT '0' NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_symbols" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"canonical" text NOT NULL,
	"asset_class" text DEFAULT 'unknown' NOT NULL,
	"digits" integer DEFAULT 5 NOT NULL,
	"point" numeric(24, 10) NOT NULL,
	"pip_size" numeric(24, 10) NOT NULL,
	"contract_size" numeric(24, 10) NOT NULL,
	"min_lot" numeric(18, 4) NOT NULL,
	"max_lot" numeric(18, 4) NOT NULL,
	"lot_step" numeric(18, 4) DEFAULT '0.01' NOT NULL,
	"max_lot_per_order" numeric(18, 4),
	"quote_currency" text DEFAULT 'USD' NOT NULL,
	"trade_mode" text DEFAULT 'full' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"swap_long" numeric(24, 8),
	"swap_short" numeric(24, 8),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" "audit_action" NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bridge_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"version" text,
	"host" text,
	"platform" text,
	"status" "agent_status" DEFAULT 'disconnected' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"last_ip" text,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "copier_followers" (
	"id" text PRIMARY KEY NOT NULL,
	"copier_id" text NOT NULL,
	"account_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"risk_type" "risk_type" DEFAULT 'LOT_MULTIPLIER' NOT NULL,
	"risk_value" numeric(12, 6) DEFAULT '100' NOT NULL,
	"settings" jsonb NOT NULL,
	"suffix_preference" text,
	"paused_until" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "copiers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"master_account_id" text NOT NULL,
	"status" "copier_status" DEFAULT 'disabled' NOT NULL,
	"paused_until" timestamp with time zone,
	"master_balance_at_creation" numeric(24, 8),
	"copy_existing_trades_requested" boolean DEFAULT false NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "copy_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"copier_id" text,
	"follower_id" text,
	"master_trade_id" text,
	"link_id" text,
	"account_id" text NOT NULL,
	"kind" "command_kind" NOT NULL,
	"params" jsonb NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"status" "command_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 24 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_deadline_at" timestamp with time zone,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"trace" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equity_protection_events" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"rule" "equity_protection_rule" NOT NULL,
	"threshold" numeric(24, 8) NOT NULL,
	"observed" numeric(24, 8) NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "equity_protections" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reset_time" text DEFAULT '00:00' NOT NULL,
	"reset_timezone" text DEFAULT 'UTC' NOT NULL,
	"max_drawdown_percent" numeric(12, 6),
	"max_drawdown_value" numeric(24, 8),
	"absolute_min_equity" numeric(24, 8),
	"max_profit_percent" numeric(12, 6),
	"max_profit_value" numeric(24, 8),
	"absolute_max_equity" numeric(24, 8),
	"disable_copier" boolean DEFAULT false NOT NULL,
	"close_copied_trades" boolean DEFAULT false NOT NULL,
	"close_all_trades" boolean DEFAULT false NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"last_triggered_rule" "equity_protection_rule",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"copier_id" text,
	"follower_id" text,
	"account_id" text,
	"master_trade_id" text,
	"request_id" text,
	"level" "log_level" DEFAULT 'info' NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "follower_symbol_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_id" text NOT NULL,
	"master_symbol" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "master_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"copier_id" text NOT NULL,
	"account_id" text NOT NULL,
	"ticket" text NOT NULL,
	"symbol" text NOT NULL,
	"side" "trade_side" NOT NULL,
	"kind" "order_kind" DEFAULT 'market' NOT NULL,
	"pending_type" text,
	"state" "master_trade_state" DEFAULT 'open' NOT NULL,
	"volume" numeric(18, 4) NOT NULL,
	"closed_volume" numeric(18, 4) DEFAULT '0' NOT NULL,
	"open_price" numeric(24, 10) NOT NULL,
	"current_price" numeric(24, 10),
	"stop_loss" numeric(24, 10),
	"take_profit" numeric(24, 10),
	"expiry" timestamp with time zone,
	"magic" integer DEFAULT 0 NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"profit" numeric(24, 8),
	"swap" numeric(24, 8),
	"commission" numeric(24, 8),
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_price" numeric(24, 10),
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "notification_channel_kind" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"subject" text,
	"template" text,
	"account_blocklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"interval" "billing_interval" DEFAULT 'month' NOT NULL,
	"max_accounts" integer,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan_code" text NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "symbol_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_id" text NOT NULL,
	"master_symbol" text NOT NULL,
	"slave_symbol" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"confidence" numeric(12, 6) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_links" (
	"id" text PRIMARY KEY NOT NULL,
	"master_trade_id" text NOT NULL,
	"follower_id" text NOT NULL,
	"copier_id" text NOT NULL,
	"slave_account_id" text NOT NULL,
	"master_symbol" text NOT NULL,
	"slave_symbol" text,
	"side" "trade_side" NOT NULL,
	"master_volume" numeric(18, 4) NOT NULL,
	"requested_volume" numeric(18, 4),
	"filled_volume" numeric(18, 4),
	"closed_volume" numeric(18, 4) DEFAULT '0' NOT NULL,
	"filled_price" numeric(24, 10),
	"slave_ticket" text,
	"magic" integer,
	"state" "link_status" DEFAULT 'pending' NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"realized_profit" numeric(24, 8),
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"platform" "platform" NOT NULL,
	"login" text NOT NULL,
	"server" text NOT NULL,
	"broker_name" text,
	"kind" "account_kind" DEFAULT 'live' NOT NULL,
	"role" "agent_account_role" DEFAULT 'both' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"leverage" integer,
	"status" "account_status" DEFAULT 'connecting' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"agent_id" text,
	"balance" numeric(24, 8),
	"equity" numeric(24, 8),
	"margin" numeric(24, 8),
	"free_margin" numeric(24, 8),
	"margin_level" numeric(12, 6),
	"equity_updated_at" timestamp with time zone,
	"reference_balance" numeric(24, 8),
	"reference_balance_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_closed_trades" ADD CONSTRAINT "account_closed_trades_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_closed_trades" ADD CONSTRAINT "account_closed_trades_follower_id_copier_followers_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."copier_followers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_daily_resets" ADD CONSTRAINT "account_daily_resets_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_snapshots" ADD CONSTRAINT "account_snapshots_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_symbols" ADD CONSTRAINT "account_symbols_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bridge_agents" ADD CONSTRAINT "bridge_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copier_followers" ADD CONSTRAINT "copier_followers_copier_id_copiers_id_fk" FOREIGN KEY ("copier_id") REFERENCES "public"."copiers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copier_followers" ADD CONSTRAINT "copier_followers_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copiers" ADD CONSTRAINT "copiers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copiers" ADD CONSTRAINT "copiers_master_account_id_trading_accounts_id_fk" FOREIGN KEY ("master_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_commands" ADD CONSTRAINT "copy_commands_copier_id_copiers_id_fk" FOREIGN KEY ("copier_id") REFERENCES "public"."copiers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_commands" ADD CONSTRAINT "copy_commands_follower_id_copier_followers_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."copier_followers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_commands" ADD CONSTRAINT "copy_commands_master_trade_id_master_trades_id_fk" FOREIGN KEY ("master_trade_id") REFERENCES "public"."master_trades"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_commands" ADD CONSTRAINT "copy_commands_link_id_trade_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."trade_links"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "copy_commands" ADD CONSTRAINT "copy_commands_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equity_protection_events" ADD CONSTRAINT "equity_protection_events_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equity_protection_events" ADD CONSTRAINT "equity_protection_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "equity_protections" ADD CONSTRAINT "equity_protections_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_copier_id_copiers_id_fk" FOREIGN KEY ("copier_id") REFERENCES "public"."copiers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_follower_id_copier_followers_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."copier_followers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_master_trade_id_master_trades_id_fk" FOREIGN KEY ("master_trade_id") REFERENCES "public"."master_trades"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "follower_symbol_overrides" ADD CONSTRAINT "follower_symbol_overrides_follower_id_copier_followers_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."copier_followers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_trades" ADD CONSTRAINT "master_trades_copier_id_copiers_id_fk" FOREIGN KEY ("copier_id") REFERENCES "public"."copiers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "master_trades" ADD CONSTRAINT "master_trades_account_id_trading_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "symbol_mappings" ADD CONSTRAINT "symbol_mappings_follower_id_copier_followers_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."copier_followers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_links" ADD CONSTRAINT "trade_links_master_trade_id_master_trades_id_fk" FOREIGN KEY ("master_trade_id") REFERENCES "public"."master_trades"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_links" ADD CONSTRAINT "trade_links_follower_id_copier_followers_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."copier_followers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_links" ADD CONSTRAINT "trade_links_copier_id_copiers_id_fk" FOREIGN KEY ("copier_id") REFERENCES "public"."copiers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_links" ADD CONSTRAINT "trade_links_slave_account_id_trading_accounts_id_fk" FOREIGN KEY ("slave_account_id") REFERENCES "public"."trading_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_agent_id_bridge_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."bridge_agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_closed_trades_ticket_key" ON "account_closed_trades" USING btree ("account_id","ticket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_closed_trades_account_idx" ON "account_closed_trades" USING btree ("account_id","closed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_closed_trades_follower_idx" ON "account_closed_trades" USING btree ("follower_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_credentials_account_key" ON "account_credentials" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_daily_resets_unique" ON "account_daily_resets" USING btree ("account_id","reset_day");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_shares_unique" ON "account_shares" USING btree ("account_id","grantee_user_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_shares_grantee_idx" ON "account_shares" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_snapshots_minute_key" ON "account_snapshots" USING btree ("account_id","taken_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_snapshots_account_idx" ON "account_snapshots" USING btree ("account_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_symbols_name_key" ON "account_symbols" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_symbols_canonical_idx" ON "account_symbols" USING btree ("account_id","canonical");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_user_idx" ON "audit_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_agents_token_key" ON "bridge_agents" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_agents_user_idx" ON "bridge_agents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copier_followers_unique" ON "copier_followers" USING btree ("copier_id","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copier_followers_account_idx" ON "copier_followers" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copiers_user_idx" ON "copiers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copiers_master_idx" ON "copiers" USING btree ("master_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copiers_status_idx" ON "copiers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copy_commands_request_key" ON "copy_commands" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_commands_queue_idx" ON "copy_commands" USING btree ("status","next_attempt_at","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_commands_account_idx" ON "copy_commands" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_commands_follower_idx" ON "copy_commands" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equity_protection_events_account_idx" ON "equity_protection_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "equity_protections_account_key" ON "equity_protections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_logs_created_idx" ON "execution_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_logs_copier_idx" ON "execution_logs" USING btree ("copier_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_logs_follower_idx" ON "execution_logs" USING btree ("follower_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_logs_code_idx" ON "execution_logs" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "follower_symbol_overrides_unique" ON "follower_symbol_overrides" USING btree ("follower_id","master_symbol");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_queue_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "master_trades_ticket_key" ON "master_trades" USING btree ("copier_id","ticket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "master_trades_state_idx" ON "master_trades" USING btree ("copier_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "master_trades_account_idx" ON "master_trades" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "master_trades_symbol_idx" ON "master_trades" USING btree ("symbol");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_kind_key" ON "notification_channels" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_queue_idx" ON "notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_outbox_dedupe_key" ON "notification_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_settings_unique" ON "notification_settings" USING btree ("user_id","channel_id","event");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plans_active_idx" ON "plans" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "symbol_mappings_unique" ON "symbol_mappings" USING btree ("follower_id","master_symbol");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "symbol_mappings_follower_idx" ON "symbol_mappings" USING btree ("follower_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_links_unique" ON "trade_links" USING btree ("master_trade_id","follower_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_links_follower_idx" ON "trade_links" USING btree ("follower_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_links_ticket_idx" ON "trade_links" USING btree ("slave_account_id","slave_ticket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_links_copier_idx" ON "trade_links" USING btree ("copier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_accounts_user_idx" ON "trading_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_accounts_agent_idx" ON "trading_accounts" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trading_accounts_identity_key" ON "trading_accounts" USING btree ("user_id","platform","login","server") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" USING btree (lower("email"));