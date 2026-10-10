CREATE TYPE "public"."snapshot_status" AS ENUM('RECEIVED', 'VALIDATING', 'REJECTED', 'BASELINED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('archive', 'github');--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"user_id" text NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_user_id_route_key_pk" PRIMARY KEY("user_id","route","key")
);
--> statement-breakpoint
CREATE TABLE "intake_event" (
	"snapshot_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_event_snapshot_id_seq_pk" PRIMARY KEY("snapshot_id","seq")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_type" "source_type" NOT NULL,
	"github_repo" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" "snapshot_status" DEFAULT 'RECEIVED' NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_ref" text,
	"resolved_revision" text,
	"content_digest" text,
	"archive_object_key" text,
	"manifest_object_key" text,
	"file_count" integer,
	"total_bytes" bigint,
	"detection" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"intake_policy_version" text NOT NULL,
	"ownership_attested_at" timestamp with time zone NOT NULL,
	"attested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"baselined_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_event" ADD CONSTRAINT "intake_event_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_attested_by_user_id_fk" FOREIGN KEY ("attested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspace_name_idx" ON "project" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "snapshot_project_idx" ON "snapshot" USING btree ("project_id","created_at");