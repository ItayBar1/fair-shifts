CREATE TABLE "auth_budget" (
	"day" text NOT NULL,
	"category" text NOT NULL,
	"scope" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "auth_budget_day_category_scope_pk" PRIMARY KEY("day","category","scope"),
	CONSTRAINT "auth_budget_nonnegative" CHECK ("auth_budget"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"used" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_rate_limit_positive" CHECK ("auth_rate_limit"."used" > 0)
);
--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "next_code_allowed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "auth_rate_limit_expiry" ON "auth_rate_limit" USING btree ("expires_at");