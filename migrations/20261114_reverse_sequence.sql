BEGIN;
-- Reuse the existing route-change audit table. Existing records are untouched.
CREATE TABLE IF NOT EXISTS mealcart_route_transfer_events (
 id uuid PRIMARY KEY,
 actor_id text NOT NULL,
 plan_date date NOT NULL,
 before_routes jsonb NOT NULL,
 after_routes jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMIT;
