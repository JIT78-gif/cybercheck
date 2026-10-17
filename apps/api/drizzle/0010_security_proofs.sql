CREATE TABLE "security_proof" (
	"id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_proof_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
ALTER TABLE "security_proof" ADD CONSTRAINT "security_proof_run_id_testing_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."testing_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_proof_run_seq_idx" ON "security_proof" USING btree ("run_id","seq");