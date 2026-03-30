ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_status_last_heartbeat_idx" ON "heartbeat_runs" USING btree ("status", "last_heartbeat_at") WHERE status = 'running';
