BEGIN;
CREATE TABLE IF NOT EXISTS public.mealcart_route_transfer_previews (
 id UUID PRIMARY KEY,actor_id TEXT NOT NULL,plan_date DATE NOT NULL,
 snapshot_hash TEXT NOT NULL,request JSONB NOT NULL,result JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 applied_at TIMESTAMPTZ,receipt JSONB
);
CREATE INDEX IF NOT EXISTS mealcart_route_transfer_expiry_idx ON public.mealcart_route_transfer_previews(expires_at) WHERE applied_at IS NULL;
CREATE TABLE IF NOT EXISTS public.mealcart_route_transfer_events (
 id UUID PRIMARY KEY,actor_id TEXT NOT NULL,plan_date DATE NOT NULL,
 before_routes JSONB NOT NULL,after_routes JSONB NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
COMMIT;
