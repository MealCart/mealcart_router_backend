BEGIN;
CREATE TABLE IF NOT EXISTS mealcart_collection_completions (
 id uuid PRIMARY KEY, plan_id text NOT NULL, plan_created_at timestamptz NOT NULL,
 stop_seq integer NOT NULL CHECK(stop_seq>0), collection_id integer NOT NULL,
 do_number text NOT NULL, driver_id text NOT NULL,
 photos jsonb NOT NULL CHECK(jsonb_typeof(photos)='array' AND jsonb_array_length(photos) BETWEEN 1 AND 6),
 signature_url text NOT NULL CHECK(length(signature_url)>0), completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(plan_id,plan_created_at,stop_seq)
);
CREATE INDEX IF NOT EXISTS collection_proof_source_idx ON mealcart_collection_completions(collection_id,do_number);
CREATE TABLE IF NOT EXISTS mealcart_collection_media (
 id uuid PRIMARY KEY, completion_id uuid NOT NULL REFERENCES mealcart_collection_completions(id),
 kind text NOT NULL CHECK(kind IN ('photo','signature')), filename text NOT NULL, mime_type text NOT NULL
);
COMMIT;
