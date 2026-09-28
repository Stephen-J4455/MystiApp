import { useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { uniqueTopic } from "../lib/realtime";

/**
 * Watches the signed-in user's OWN `public.user_profiles` row and reports the
 * authoritative role whenever it changes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Edge functions authorize from `public.user_profiles` (see
 * `resolveIdentity`), but the clients read the role out of the JWT. Those are
 * different stores, and supabase-js has NO cross-device push for auth metadata,
 * so a service-role `updateUserById` never reaches a running client. The
 * previous mitigation was a `refreshSession()` nudge on AppState "active",
 * which meant a promotion or demotion stayed invisible for as long as the user
 * kept the app in the foreground.
 *
 * `user_profiles` is the store that actually decides permissions, so
 * subscribing to it turns a rank/demote into a live update. The migration
 * `20260928_004_user_profiles_realtime_rls.sql` puts the table on the
 * `supabase_realtime` publication and adds an RLS policy restricting SELECT to
 * the caller's own row (or to admins), so this subscription can only ever
 * observe the signed-in user's own profile.
 *
 * IMPORTANT: the profile row carries `role`, which is what we want, but the
 * app's own `userRole` state is derived from auth metadata. A change here
 * therefore means "your permissions may have changed" - the caller is expected
 * to re-resolve the session (a token refresh) rather than to trust the payload
 * for authorization. The payload is a change SIGNAL, not an authority.
 *
 * @param {object|null} user          the signed-in auth user
 * @param {(profile: {role: string, superAgentId: string|null}) => void} onChange
 *        called with the new authoritative row whenever it changes
 */
export function useProfileRoleSubscription(user, onChange) {
  const handlerRef = useRef(onChange);

  // Keep the latest callback without re-subscribing on every render. A
  // dependency on `onChange` would tear down and rebuild the channel whenever
  // an inline arrow function is re-created, which is every render.
  useEffect(() => {
    handlerRef.current = onChange;
  }, [onChange]);

  const userId = user?.id || null;

  useEffect(() => {
    if (!userId) return undefined;

    const channel = supabase
      .channel(uniqueTopic("my_profile_role_realtime"))
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_profiles",
          // Server-side filter: RLS already limits this subscription to the
          // caller's own row, and this narrows the stream further so a
          // promoted admin does not receive other profiles' updates.
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          const next = payload?.new || payload?.old || null;
          if (!next || String(next.id || "") !== userId) return;

          handlerRef.current?.({
            role: String(next.role || ""),
            superAgentId: String(next.super_agent_id || "") || null,
          });
        },
      )
      .subscribe();

    return () => {
      // Fire-and-forget: the topic is unique per subscription, so even if this
      // races there is no other channel to disturb.
      supabase.removeChannel(channel).catch(() => {});
    };
  }, [userId]);
}
