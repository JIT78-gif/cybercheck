DROP INDEX IF EXISTS "test_finding_run_idx";--> statement-breakpoint
ALTER TABLE "test_finding" DROP CONSTRAINT IF EXISTS "test_finding_pkey";--> statement-breakpoint
ALTER TABLE "test_finding" ADD CONSTRAINT "test_finding_run_id_id_pk" PRIMARY KEY("run_id","id");
