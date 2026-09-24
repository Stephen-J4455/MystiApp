BEGIN;

-- Ensure the canonical device-token table has a stable per-user/platform key.
CREATE UNIQUE INDEX IF NOT EXISTS user_push_tokens_user_platform_unique
  ON public.user_push_tokens (user_id, platform);

ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_push_tokens_user_insert ON public.user_push_tokens;
CREATE POLICY user_push_tokens_user_insert
  ON public.user_push_tokens FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_push_tokens_user_update ON public.user_push_tokens;
CREATE POLICY user_push_tokens_user_update
  ON public.user_push_tokens FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_push_tokens_user_read ON public.user_push_tokens;
CREATE POLICY user_push_tokens_user_read
  ON public.user_push_tokens FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_push_tokens_user_delete ON public.user_push_tokens;
CREATE POLICY user_push_tokens_user_delete
  ON public.user_push_tokens FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

COMMIT;
