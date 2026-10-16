CREATE TABLE "contact_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"digested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "contact_requests_pending" ON "contact_requests" USING btree ("digested_at","created_at");