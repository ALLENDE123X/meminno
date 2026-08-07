CREATE TABLE "health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note" text DEFAULT 'MEM-001 scaffold' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
