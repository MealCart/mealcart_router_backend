BEGIN;
CREATE TABLE IF NOT EXISTS public.mealcart_pallet_movements (
 id UUID PRIMARY KEY,
 sequence BIGSERIAL UNIQUE NOT NULL,
 customer_id INTEGER NOT NULL,
 client_name TEXT NOT NULL,
 driver_id VARCHAR(40) NOT NULL,
 driver_name TEXT NOT NULL,
 pallet_type TEXT NOT NULL CHECK (pallet_type IN ('CHEP','LOSCAM','PLAIN')),
 entry_kind TEXT NOT NULL CHECK (entry_kind IN ('collection','issue','reversal')),
 quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
 delta INTEGER NOT NULL,
 reverses_id UUID UNIQUE REFERENCES public.mealcart_pallet_movements(id) ON DELETE RESTRICT,
 occurred_at TIMESTAMPTZ NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 actor_type TEXT NOT NULL CHECK (actor_type IN ('driver','admin','staff')),
 actor_id TEXT NOT NULL,
 actor_name TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '' CHECK (length(notes)<=2000),
 input_hash TEXT NOT NULL,
 balance_after BIGINT NOT NULL,
 CHECK ((entry_kind='collection' AND delta=quantity AND reverses_id IS NULL) OR
        (entry_kind='issue' AND delta=-quantity AND reverses_id IS NULL) OR
        (entry_kind='reversal' AND reverses_id IS NOT NULL AND abs(delta)=quantity AND length(trim(notes))>=3))
);
CREATE INDEX IF NOT EXISTS mealcart_pallet_client_type_time_idx ON public.mealcart_pallet_movements(customer_id,pallet_type,occurred_at,sequence);
CREATE INDEX IF NOT EXISTS mealcart_pallet_driver_idx ON public.mealcart_pallet_movements(driver_id,sequence DESC);
CREATE OR REPLACE FUNCTION public.mealcart_pallet_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Pallet movements are append-only. Record an admin reversal with a note.'; END;
$$;
DROP TRIGGER IF EXISTS mealcart_pallet_immutable ON public.mealcart_pallet_movements;
CREATE TRIGGER mealcart_pallet_immutable BEFORE UPDATE OR DELETE ON public.mealcart_pallet_movements FOR EACH ROW EXECUTE FUNCTION public.mealcart_pallet_append_only();
CREATE TABLE IF NOT EXISTS public.mealcart_pallet_emails (
 id UUID PRIMARY KEY,
 movement_id UUID NOT NULL REFERENCES public.mealcart_pallet_movements(id) ON DELETE RESTRICT,
 recipient_role TEXT NOT NULL CHECK(recipient_role IN ('client','driver')),
 recipient TEXT NOT NULL,
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','sending','accepted','failed','blocked','unknown')),
 detail TEXT NOT NULL DEFAULT '',
 provider_id TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 attempted_at TIMESTAMPTZ,
 sent_at TIMESTAMPTZ,
 UNIQUE(movement_id,recipient_role)
);
CREATE INDEX IF NOT EXISTS mealcart_pallet_email_queue_idx ON public.mealcart_pallet_emails(status,created_at);
COMMIT;
