ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "activation_retrigger_count" integer DEFAULT 0 NOT NULL;
