CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source_item_id" uuid,
	"published_at" timestamp with time zone,
	"unpublished_at" timestamp with time zone,
	"digested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_source_item_id_listen_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."listen_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answers_slug_idx" ON "answers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "answers_published_idx" ON "answers" USING btree ("published_at");