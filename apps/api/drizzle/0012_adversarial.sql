CREATE TABLE "adversarial_attack_pack" (
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
CREATE TABLE "adversarial_campaign" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"lane" text NOT NULL,
	"technique_id" text NOT NULL,
	"status" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adversarial_campaign_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "adversarial_chain" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"verdict" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adversarial_chain_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "adversarial_step" (
	"run_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"seq" integer NOT NULL,
	"operation" text NOT NULL,
	"execution_id" text,
	"result" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adversarial_step_run_id_campaign_id_seq_pk" PRIMARY KEY("run_id","campaign_id","seq")
);
--> statement-breakpoint
ALTER TABLE "adversarial_attack_pack" ADD CONSTRAINT "adversarial_attack_pack_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adversarial_attack_pack" ADD CONSTRAINT "adversarial_attack_pack_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adversarial_attack_pack" ADD CONSTRAINT "adversarial_attack_pack_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adversarial_campaign" ADD CONSTRAINT "adversarial_campaign_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adversarial_chain" ADD CONSTRAINT "adversarial_chain_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adversarial_step" ADD CONSTRAINT "adversarial_step_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adversarial_step" ADD CONSTRAINT "adversarial_step_campaign_fk" FOREIGN KEY ("run_id","campaign_id") REFERENCES "public"."adversarial_campaign"("run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adversarial_attack_pack_version_idx" ON "adversarial_attack_pack" USING btree ("project_id","name","version");--> statement-breakpoint
CREATE INDEX "adversarial_attack_pack_project_idx" ON "adversarial_attack_pack" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "adversarial_campaign_run_seq_idx" ON "adversarial_campaign" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "adversarial_campaign_run_lane_idx" ON "adversarial_campaign" USING btree ("run_id","lane");--> statement-breakpoint
CREATE UNIQUE INDEX "adversarial_chain_run_seq_idx" ON "adversarial_chain" USING btree ("run_id","seq");