ALTER TABLE "testing_run" ADD COLUMN "check" text DEFAULT 'testing' NOT NULL;--> statement-breakpoint
CREATE INDEX "testing_run_check_idx" ON "testing_run" USING btree ("check","status","created_at");