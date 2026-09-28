ALTER TABLE "auth_user" ADD COLUMN "responsibility" text;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "responsibility_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_responsibility" CHECK ("auth_user"."responsibility" is null or "auth_user"."responsibility" in ('mandatory','career'));