CREATE TABLE "ai_evaluation_case" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"category" text NOT NULL,
	"verdict" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_evaluation_case_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai_evaluation_dataset" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"digest" text NOT NULL,
	"artifact_key" text NOT NULL,
	"schema_version" integer NOT NULL,
	"case_count" integer NOT NULL,
	"by_category" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_evaluation_case" ADD CONSTRAINT "ai_evaluation_case_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_evaluation_dataset" ADD CONSTRAINT "ai_evaluation_dataset_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_evaluation_dataset" ADD CONSTRAINT "ai_evaluation_dataset_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_evaluation_dataset" ADD CONSTRAINT "ai_evaluation_dataset_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_evaluation_case_run_seq_idx" ON "ai_evaluation_case" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_evaluation_dataset_version_idx" ON "ai_evaluation_dataset" USING btree ("project_id","name","version");--> statement-breakpoint
CREATE INDEX "ai_evaluation_dataset_project_idx" ON "ai_evaluation_dataset" USING btree ("project_id","created_at");