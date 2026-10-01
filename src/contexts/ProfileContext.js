import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { supabase } from "../lib/supabase";
import { uniqueTopic } from "../lib/realtime";
import { profileRole } from "../lib/profileRole";

/**
 * The signed-in user's OWN `public.user_profiles` row, held live.
 *
 * WHY THIS IS THE AUTHORITATIVE SOURCE
 * ------------------------------------
 * `public.user_profiles` is the store every edge function authorizes from (see
 * `identity-authorization-source.md`). `user_metadata` is NOT and never was:
 * the account owner can rewrite it at will with
 * `supabase.auth.updateUser({ data: { role: 'admin' } })`, so any role read
 * from it is self-assignable. Roles and ownership are read from here and from
 * nowhere else.
 *
 * WHY A CONTEXT AND NOT A FRESH `getUser()`
 * ------------------------------------------
 * The previous code re-derived the role from the auth record in eight
 * separate screens. That is what let a stale `app_metadata` role (up to an
 * hour, because the role lives in the access token) disagree between screens -
 * the dock could offer a Super Agent screen that then bounced the user to
 * Home, or a wallet card could render for a just-demoted account.
 *
 * The row is read ONCE per session and kept live by a realtime subscription
 * (migration `20260928_004_user_profiles_realtime_rls.sql` puts the table on
 * the `supabase_realtime` publication and restricts SELECT by RLS to the
 * caller's own row, so this can only ever observe the signed-in user's own
 * profile). A rank change is therefore visible immediately, with no token
 * refresh and no per-screen re-read.
 *
 * FAIL-CLOSED BY CONSTRUCTION
 * ---------------------------
 * While the row is loading, and if the read fails, `role` is `null` and
 * `profileRole(null)` yields `"NormalUser"`. That is the least-privileged
 * reading, so a failed read can never reveal a wallet or a super-agent screen
 * - the user sees the customer experience until the row arrives rather than
 * the other way round.
 */
const ProfileContext = createContext({
  profile: null,
  /** Canonical role: "Admin" | "SuperAgent" | "Agent" | "NormalUser". */
  role: "NormalUser",
  /** `user_profiles.super_agent_id`, or null. A sub-agent's owner. */
  superAgentId: null,
  isSuperAgent: false,
  isSubAgent: false,
  isAdmin: false,
  isNormalUser: true,
  /** False until the first read settles. Gates anything that must not flash. */
  loading: true,
  /** Re-reads the row on demand (pull-to-refresh, after a server action). */
  refresh: () => {},
});

export function ProfileProvider({ user, children }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const userId = user?.id || null;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const { data, error } = await supabase
          .from("user_profiles")
          .select(
            "id, role, super_agent_id, full_name, business_name, email, phone",
          )
          .eq("id", userId)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          // Deliberately NOT optimistic. Defaulting to a super agent here
          // would put a wallet balance and management screens in front of an
          // account whose authority we failed to read - the fail-open direction
          // that produced the "wallet leaked to normal users" bug.
          console.error("[ProfileProvider] Could not read profile:", error);
          setProfile(null);
          return;
        }
        setProfile(
          data
            ? {
                id: String(data.id),
                role: String(data.role || ""),
                superAgentId: String(data.super_agent_id || "") || null,
                fullName: String(data.full_name || ""),
                businessName: String(data.business_name || ""),
                email: String(data.email || ""),
                phone: String(data.phone || ""),
              }
            : null,
        );
      } catch (error) {
        if (cancelled) return;
        console.error("[ProfileProvider] Profile read threw:", error);
        setProfile(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [userId, nonce]);

  // Live role/ownership changes. A service-role `updateUserById` has no
  // cross-device push for auth metadata, so an admin promoting or demoting
  // someone would otherwise stay invisible until the access token expired -
  // the role lives in the JWT, which supabase-js caches for up to an hour.
  useEffect(() => {
    if (!userId) return undefined;

    const channel = supabase
      .channel(uniqueTopic("profile_role_live"))
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "user_profiles",
          // RLS already limits this stream to the caller's own row; the filter
          // narrows it further so the channel is not a way to observe anyone
          // else's profile.
          filter: `id=eq.${userId}`,
        },
        (payload) => {
          const next = payload?.new || payload?.old || null;
          if (!next || String(next.id || "") !== userId) return;
          if (payload.eventType === "DELETE") {
            setProfile(null);
            return;
          }
          setProfile({
            id: String(next.id || userId),
            role: String(next.role || ""),
            superAgentId: String(next.super_agent_id || "") || null,
            fullName: String(next.full_name || ""),
            businessName: String(next.business_name || ""),
            email: String(next.email || ""),
            phone: String(next.phone || ""),
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel).catch(() => {});
    };
  }, [userId]);

  const value = useMemo(() => {
    const role = profileRole(profile);
    return {
      profile,
      role,
      superAgentId: profile?.superAgentId || null,
      isSuperAgent: role === "SuperAgent",
      isSubAgent: role === "Agent",
      isAdmin: role === "Admin",
      isNormalUser: role === "NormalUser",
      loading,
      refresh,
    };
  }, [profile, loading, refresh]);

  return (
    <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
  );
}

/**
 * The signed-in user's authoritative role.
 *
 * MUST be used inside a `ProfileProvider`. Reads the profile row, never the
 * auth record: `user_metadata` is self-writable and `app_metadata` lives in
 * the access token, so both are a worse answer than the table every edge
 * function reads. See `ProfileProvider` for the failure behaviour.
 */
export function useProfile() {
  return useContext(ProfileContext);
}

/** Convenience accessor for the canonical role string. */
export function useProfileRole() {
  return useContext(ProfileContext).role;
}
