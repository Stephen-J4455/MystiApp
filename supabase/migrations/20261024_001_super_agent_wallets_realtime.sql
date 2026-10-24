BEGIN;

-- Keep the Home wallet balance synchronized from wallet row changes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'super_agent_wallets'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.super_agent_wallets;
  END IF;
END
$$;

ALTER TABLE public.super_agent_wallets
  REPLICA IDENTITY DEFAULT;

COMMIT;
