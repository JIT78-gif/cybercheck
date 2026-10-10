CREATE TYPE "public"."understanding_status" AS ENUM('queued', 'analyzing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "understanding_run" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"status" "understanding_status" DEFAULT 'queued' NOT NULL,
	"analyzer_version" text NOT NULL,
	"dossier" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "understanding_run" ADD CONSTRAINT "understanding_run_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "understanding_run_snapshot_idx" ON "understanding_run" USING btree ("snapshot_id","created_at");