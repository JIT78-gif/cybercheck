CREATE TABLE "testing_repair" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"scope" jsonb NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "testing_repair" ADD CONSTRAINT "testing_repair_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_repair" ADD CONSTRAINT "testing_repair_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_repair" ADD CONSTRAINT "testing_repair_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_repair" ADD CONSTRAINT "testing_repair_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_repair" ADD CONSTRAINT "testing_repair_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "testing_repair_run_idx" ON "testing_repair" USING btree ("run_id","finding_id");