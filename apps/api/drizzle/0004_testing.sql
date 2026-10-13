CREATE TYPE "public"."testing_run_status" AS ENUM('queued', 'running', 'completed', 'partial', 'blocked', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "sandbox_image_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"image_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_execution" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_finding" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_obligation" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "test_obligation_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "test_run_event" (
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_run_event_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "testing_run" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"project_id" text NOT NULL,
	"understanding_run_id" text,
	"requested_by" text NOT NULL,
	"status" "testing_run_status" DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'admission' NOT NULL,
	"policy" jsonb NOT NULL,
	"plan" jsonb,
	"report" jsonb,
	"usage" jsonb,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "test_execution" ADD CONSTRAINT "test_execution_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_obligation" ADD CONSTRAINT "test_obligation_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_event" ADD CONSTRAINT "test_run_event_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_run" ADD CONSTRAINT "testing_run_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_run" ADD CONSTRAINT "testing_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_run" ADD CONSTRAINT "testing_run_understanding_run_id_understanding_run_id_fk" FOREIGN KEY ("understanding_run_id") REFERENCES "public"."understanding_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_run" ADD CONSTRAINT "testing_run_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_execution_run_idx" ON "test_execution" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "test_finding_run_idx" ON "test_finding" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "testing_run_snapshot_idx" ON "testing_run" USING btree ("snapshot_id","created_at");--> statement-breakpoint
CREATE INDEX "testing_run_status_idx" ON "testing_run" USING btree ("status","created_at");