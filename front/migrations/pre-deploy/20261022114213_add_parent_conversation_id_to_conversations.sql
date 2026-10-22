/*
Statement 0
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."conversations" ADD COLUMN "parentConversationId" bigint;

/*
Statement 1
  - INDEX_BUILD: This might affect database performance. Concurrent index builds require a non-trivial amount of CPU, potentially affecting database performance. They also can take a while but do not lock out writes.
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
CREATE INDEX CONCURRENTLY conversations_parent_conversation_id ON public.conversations USING btree ("parentConversationId") WHERE ("parentConversationId" IS NOT NULL);

/*
Statement 2
*/
SET SESSION statement_timeout = 3000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."conversations" ADD CONSTRAINT "conversations_parentConversationId_fkey" FOREIGN KEY ("parentConversationId") REFERENCES conversations(id) ON UPDATE CASCADE ON DELETE SET NULL NOT VALID;

/*
Statement 3
  - Scans the whole table, without blocking reads nor writes (SHARE UPDATE EXCLUSIVE lock).
*/
SET SESSION statement_timeout = 1200000;
SET SESSION lock_timeout = 3000;
ALTER TABLE "public"."conversations" VALIDATE CONSTRAINT "conversations_parentConversationId_fkey";
