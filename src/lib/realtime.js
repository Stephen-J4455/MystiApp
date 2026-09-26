import { supabase } from "./supabase";

/**
 * Helpers for Supabase Realtime channel lifecycle.
 *
 * ## The bug these exist to prevent
 *
 * `supabase.channel(topic)` does NOT always create a new channel. If a channel
 * with the same topic is still registered on the client, it returns the
 * EXISTING one (see `RealtimeClient.channel`). And `removeChannel` is async -
 * it only removes the channel from the client's list after awaiting
 * `unsubscribe()` resolves.
 *
 * So if an effect re-runs (focus change, role change, remount) before the
 * previous `removeChannel` has finished, `channel()` hands back the old
 * still-joined channel, and the subsequent `.on(...)` throws:
 *
 *   cannot add `postgres_changes` callbacks for realtime:<topic> after `subscribe()`
 *
 * Note that channel names are NOT namespaced per screen, so two different
 * screens using the same literal topic collide. And with a Stack.Navigator
 * screens stay mounted when you navigate, so a stale channel from the previous
 * screen is very much still around.
 *
 * ## The fix
 *
 * Give every channel instance a unique topic, so `channel()` can never return
 * someone else's channel. Combined with the `useRef`-style holder below, this
 * closes both the collision and the leak.
 */

let topicCounter = 0;

/**
 * Returns a topic unique to this call, so no two live channels ever share a
 * name. The stable prefix is kept for readability in logs and the Realtime
 * dashboard.
 */
export function uniqueTopic(base) {
  topicCounter += 1;
  return `${base}_${topicCounter}`;
}

/**
 * A mutable holder for a channel that is created asynchronously.
 *
 * The pattern: keep the holder in a `useRef`, assign the channel to it as soon
 * as it exists, and have cleanup read the holder rather than a closure variable
 * that is still `null` if the effect is cleaned up during an `await`.
 */
export function createChannelHolder() {
  return { current: null };
}

/**
 * Removes a channel, swallowing the "already gone" races.
 *
 * Safe to call with a channel that was never created, and safe to call twice.
 */
export async function removeChannelSafe(channel) {
  if (!channel) return;
  try {
    await supabase.removeChannel(channel);
  } catch (error) {
    // A channel that is already torn down is not an error worth surfacing -
    // cleanup runs during navigation and can race the unsubscribe.
    console.warn("Realtime channel cleanup failed:", error);
  }
}

export default { uniqueTopic, createChannelHolder, removeChannelSafe };
