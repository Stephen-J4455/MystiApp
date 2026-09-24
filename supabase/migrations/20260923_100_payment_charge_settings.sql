BEGIN;

CREATE TABLE IF NOT EXISTS public.payment_charge_settings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  normal_user_percent numeric NOT NULL DEFAULT 1.95,
  super_agent_percent numeric NOT NULL DEFAULT 1.95,
  wallet_topup_percent numeric NOT NULL DEFAULT 1.95,
  updated_by uuid,
  notes text
);

INSERT INTO public.payment_charge_settings (
  normal_user_percent,
  super_agent_percent,
  wallet_topup_percent,
  updated_by,
  notes
)
SELECT 1.95, 1.95, 1.95, NULL, 'Default transaction fee settings'
WHERE NOT EXISTS (
  SELECT 1 FROM public.payment_charge_settings
);

ALTER TABLE public.payment_charge_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_charge_settings_admin_all
  ON public.payment_charge_settings
  FOR ALL
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'Admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'Admin'
  )
  WITH CHECK (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'Admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'Admin'
  );

CREATE POLICY payment_charge_settings_read_all
  ON public.payment_charge_settings
  FOR SELECT
  TO authenticated
  USING (true);

COMMIT;
