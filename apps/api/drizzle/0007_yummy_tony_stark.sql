CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"workspace_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_review" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"finding_id" text NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"reviewer_role" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"supersedes_review_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review" ADD CONSTRAINT "finding_review_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review" ADD CONSTRAINT "finding_review_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review" ADD CONSTRAINT "finding_review_snapshot_id_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_review" ADD CONSTRAINT "finding_review_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "finding_review_run_idx" ON "finding_review" USING btree ("run_id","finding_id","created_at");--> statement-breakpoint
CREATE INDEX "finding_review_project_idx" ON "finding_review" USING btree ("project_id");