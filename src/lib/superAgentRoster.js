// ===========================================================================
// Super Agent roster data access
// ===========================================================================
// Everything a Super Agent needs to look after their sub-agents, in one
// place, so the screens cannot drift apart again.
//
// WHY THIS FILE EXISTS
// --------------------
// The bug these calls were written to fix was a SCATTERING problem, not a
// missing-query problem. Each screen had grown its own inline query, and they
// disagreed about what "my sub-agent's orders" even means:
//
//   - SuperAgentTransactionsScreen loaded ONLY `status = 'held'` orders.
//   - SuperAgentHeldOrdersScreen loaded ONLY `status = 'held'` orders.
//   - HistoryScreen loaded ALL orders, correctly, on one branch.
//   - HomeScreen loaded ALL orders plus held ones, separately.
//
// So a sub-agent with three orders showed the super agent one of them, on two
// of three screens, and the other two orders simply did not exist as far as the
// wallet was concerned.
//
// A "held" filter is a REPAIR WORKFLOW, not a view of the business. Held means
// "our wallet debit failed and the order needs retrying", which is a genuine
// lifecycle state - but showing ONLY that state makes a super agent's ledger
// look empty while their sub-agent is buying all day. Both concepts are needed
// and they are not substitutes, so they are now named separately:
//
//   fetchSubAgentOrders()   - every order, every status. The business view.
//   (held orders remain reachable through it, and through the dedicated
//    held-orders screen, which is the right place for a repair queue.)
//
// WHY BALANCES AND THE LEDGER ARE A SEPARATE CALL
// ----------------------------------------------
// `super_agent_wallets` and `super_agent_wallet_ledger` are keyed on the
// HOLDER's id, not the super agent's. A sub-agent's mirrored balance lives
// under the sub-agent's own id, so there is no single-row answer to "my
// sub-agents' balances" - it is a list keyed by a set of ids that has to be
// resolved first. Migration 20260928_008 documented the opposite decision
// ("a super agent sees what their sub-agents paid in, not their running
// balance"), but that reasoning does not hold: the mirrored balance is the
// ceiling on what a sub-agent may spend out of the super agent's REAL money,
// so the super agent is the party with the strongest legitimate need to see it.
// Every purchase a sub-agent makes moves their super agent's actual balance.
//
// READS ONLY
// ----------
// Nothing in this file writes a wallet. Balances move exclusively through the
// SECURITY DEFINER RPCs and the admin top-up/debit functions, which run under
// the service role. A client-writable balance would be a mint path.

import { supabase } from "./supabase";
import { getEdgeFunctionName } from "./env";
import { getEdgeFunctionErrorMessage } from "./edgeFunctions";

/**
 * PostgREST caps an un-paginated select at `max-rows` (1000 by default) and
 * silently clamps it, so a roster larger than the cap renders truncated with
 * no indication anything is missing. Page well under it, and walk the full set.
 *
 * One page MUST come back shorter than this for the loop to terminate, so a
 * value at or above `max-rows` would reintroduce exactly that bug.
 */
const PAGE_SIZE = 200;

/**
 * Walks a paginated query to completion, tolerating a server that clamps a
 * page short.
 *
 * Advances by what the server ACTUALLY returned rather than by the requested
 * size: `max-rows` is applied after `range()`, so a page can come back
 * shorter. Advancing by the requested size would skip straight over the rows
 * the clamp swallowed and return an incomplete list.
 */
const walkAll = async (buildQuery, orderColumn = "created_at") => {
  const collected = [];
  let from = 0;
  let exactTotal = null;

  for (;;) {
    const { data, error, count } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;

    const rows = data || [];
    collected.push(...rows);
    if (exactTotal === null && Number.isInteger(count)) exactTotal = count;
    from += rows.length;

    // An empty page is a hard stop regardless of what `count` claimed: a row
    // can leave the filter between two requests, and trusting a stale count
    // here would spin forever on a phantom tail.
    if (rows.length === 0) break;
    if (exactTotal !== null) {
      if (from >= exactTotal) break;
    } else if (rows.length < PAGE_SIZE) {
      // Fallback for a server that does not report a count. A clamped page is
      // short too, so this stops early rather than looping.
      break;
    }
  }

  return collected.sort(
    (a, b) =>
      new Date(b?.[orderColumn] || 0).getTime() -
      new Date(a?.[orderColumn] || 0).getTime(),
  );
};

/**
 * The signed-in user's id, or null.
 *
 * Callers must handle null: a signed-out session previously made
 * `.eq("super_agent_id", undefined)` match nothing and render as an empty list
 * rather than as "you are not signed in" - the screen looked identical to
 * genuinely having no sub-agent activity.
 */
const getCurrentUserId = async () => {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) throw error;
  return user?.id || null;
};

/**
 * Every order placed by the signed-in super agent's sub-agents, any status.
 *
 * `super_agent_id` is stamped onto the row by `verify-payment` from
 * `user_profiles.super_agent_id`, which only admins write - it is not something
 * a sub-agent can repoint at another agent.
 *
 * Requires `agent_orders_read_by_super_agent` from migration 20261003_002.
 * Without it this returns `[]` (HTTP 200, no error), which is the silent-zero
 * trap - not an exception.
 */
export const fetchSubAgentOrders = async ({ superAgentId, limit } = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  const orders = await walkAll((from, to) =>
    supabase
      .from("agent_orders")
      .select("*", { count: "exact" })
      .eq("super_agent_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  return Number.isFinite(limit) && limit > 0 ? orders.slice(0, limit) : orders;
};

/**
 * The payment ledger rows for those same orders.
 *
 * `payment_transactions.super_agent_id` is already stamped by `verify-payment`
 * on every sub-agent order and `payment_transactions_super_agent_read` from
 * migration 20260921_002 already permits it, so this leg works WITHOUT the
 * 20261003_002 migration. It is here so the transactions screen issues one
 * consistent set of calls rather than mixing a working source with a broken
 * one - which is precisely what made the original symptom read as "my orders
 * are missing" when in fact the ledger had been arriving all along.
 */
export const fetchSubAgentPayments = async ({ superAgentId, limit } = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  const rows = await walkAll((from, to) =>
    supabase
      .from("payment_transactions")
      .select("*", { count: "exact" })
      .eq("super_agent_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
};

/**
 * The sub-agents' WALLET-funded orders.
 *
 * WHY THIS EXISTS ALONGSIDE `fetchSubAgentOrders`
 * ----------------------------------------------
 * A sub-agent has two ways to buy, and `verify-payment` writes them to two
 * DIFFERENT tables:
 *
 *   paid by Paystack -> `agent_orders`   (fetchSubAgentOrders)
 *   paid from wallet -> `orders`         (this function)
 *
 * `fetchSubAgentOrders` alone therefore showed a super agent only the
 * Paystack half of their sub-agents' business. Someone whose agents fund
 * purchases from mirrored wallet balances - which is the primary agent flow -
 * saw an essentially empty orders list while the LEDGER page, keyed on the
 * wallet holder rather than the order, showed every movement. The two screens
 * disagreed because they were reading different tables, not because one was
 * filtering.
 *
 * `orders.super_agent_id` was added by migration 20261005_001 and is stamped by
 * `verify-payment` on the wallet path. Before it, a wallet order was
 * unattributable: `orders` had no ownership column, so there was nothing to
 * filter on and no way to prove whose purchase a row was. The read returned
 * HTTP 200 with zero rows - a denied read and a genuine no-orders answer are
 * indistinguishable on the client, which is what made this so hard to see.
 *
 * Requires RLS permitting a super agent to read their sub-agents' rows in
 * `orders`. Check the `orders` policies before assuming this returns data: a
 * missing policy fails the same silent, errorless way.
 */
export const fetchSubAgentWalletOrders = async ({
  superAgentId,
  limit,
} = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  const rows = await walkAll((from, to) =>
    supabase
      .from("orders")
      .select("*", { count: "exact" })
      .eq("super_agent_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
};

/**
 * The sub-agents' mirrored wallet balances, keyed by sub-agent id.
 *
 * Resolved in two steps because the data is not addressable directly:
 * `super_agent_wallets` is keyed on the HOLDER, so "my sub-agents' balances"
 * is not one row - it is one row per sub-agent, and the set of sub-agent ids
 * has to come from `user_profiles` first.
 *
 * `super_agent_wallets.super_agent_id` for a sub-agent is the SUB-AGENT's id,
 * which is the key the balance is stored under. Reading it as `super_agent_id
 * = <super agent id>` returns the super agent's own real balance instead -
 * easy to mistake for "the sub-agent balances loaded and they are all zero".
 *
 * Requires `super_agent_wallets_read_by_super_agent` from 20261003_002.
 */
const SUB_AGENT_ROLES = new Set(["sub_agent", "subagent"]);

/**
 * The super agent's roster of sub-agents, from the AUTHORITATIVE store.
 *
 * `user_profiles.super_agent_id` is admin-written;
 * `user_metadata.super_agent_id` is writable by the listed account itself via
 * `auth.updateUser()`, which is how a sub-agent could otherwise appear in a
 * different agent's roster.
 *
 * Shared by `fetchSubAgentBalances` and `fetchSubAgentRosterMembers` so the
  * roster a super agent SEES and the roster we COUNT can never drift apart -
  * they used to be two separate queries, and an analytics tile that disagreed
  * with the agents screen looked like a bug in one of them.
 */
const fetchSubAgentRoster = async (superAgentId) => {
  const { data: members, error: memberError } = await supabase
    .from("user_profiles")
    .select("id, full_name, business_name, role")
    .eq("super_agent_id", superAgentId);
  if (memberError) throw memberError;

  return (members || []).filter((member) => {
    const role = String(member.role || "")
      .trim()
      .toLowerCase();
    // A member with no role is not a sub-agent. Migration 20260928_003
    // repaired rows that a bad signup trigger had stamped 'sub_agent' onto
    // ordinary customers, so the role cannot be assumed from membership.
    return SUB_AGENT_ROLES.has(role);
  });
};

/**
 * The super agent's sub-agents, for screens that LIST them or COUNT them.
 *
 * This is the roster every super-agent surface must agree on. The analytics
 * screen's "Active sub-agents" tile and its sub-agents list used to read
 * `active_sub_agents` and `sub_agents` from `get_business_analytics`, which
 * only cover sub-agents that have TRANSACTED - so a super agent who had
 * onboarded twenty sub-agents and made one sale saw "1" and a single row while
 * their own agents screen listed twenty people. `get_business_analytics` is
 * still the source of the per-agent MONEY, so callers merge the two.
 *
 * Returns `[]` when nobody is signed in so a caller renders an empty list
 * rather than crashing, matching `fetchSubAgentBalances`.
 */
export const fetchSubAgentRosterMembers = async ({ superAgentId } = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  return fetchSubAgentRoster(userId);
};

export const fetchSubAgentBalances = async ({ superAgentId } = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  const subAgents = await fetchSubAgentRoster(userId);

  if (subAgents.length === 0) return [];

  // The balances themselves. One query for the whole roster rather than N - a
  // super agent with twenty sub-agents would otherwise make twenty round trips
  // to render one screen.
  const { data: wallets, error: walletError } = await supabase
    .from("super_agent_wallets")
    .select("super_agent_id, balance, updated_at")
    .in(
      "super_agent_id",
      subAgents.map((member) => member.id),
    );
  if (walletError) throw walletError;

  const balancesById = new Map(
    (wallets || []).map((wallet) => [
      wallet.super_agent_id,
      {
        balance: Number(wallet.balance || 0),
        updatedAt: wallet.updated_at || null,
      },
    ]),
  );

  // Every sub-agent is returned, INCLUDING one with no wallet row at all - they
  // are funded at zero (migration 20260928_008 section 3), so a missing row
  // means "never funded", which is meaningfully different from "funded and
  // spent it all" and must not silently drop the person from the roster.
  return subAgents.map((member) => ({
    id: member.id,
    name: member.business_name || member.full_name || "Sub-agent",
    balance: balancesById.has(member.id)
      ? balancesById.get(member.id).balance
      : 0,
    updatedAt: balancesById.get(member.id)?.updatedAt || null,
    hasWallet: balancesById.has(member.id),
  }));
};

/**
 * Wallet ledger movements for the given wallet holders.
 *
 * Defaults to the signed-in super agent's OWN ledger - the real money. Pass
 * `holderIds` to read a sub-agent's mirrored ledger instead; the holders must
 * come from `fetchSubAgentBalances`, which already resolved the roster through
 * `user_profiles`.
 *
 * Requires `super_agent_wallet_ledger_read_by_super_agent` from 20261003_002
 * for the sub-agent case. Reading your own needs no migration - the original
 * `super_agent_id = auth.uid()` policy covers it.
 */
export const fetchWalletLedger = async ({
  superAgentId,
  holderIds,
  limit,
} = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  const ids =
    Array.isArray(holderIds) && holderIds.length > 0 ? holderIds : [userId];

  const rows = await walkAll((from, to) =>
    supabase
      .from("super_agent_wallet_ledger")
      .select("*", { count: "exact" })
      .in("super_agent_id", ids)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
};

/**
 * Wallet TOP-UPS paid for by the roster, newest first.
 *
 * A separate call from `fetchWalletLedger` because the two tables answer
 * different questions and have different keys:
 *
 *   `wallet_topups`            - money IN. One row per Paystack charge, keyed
 *                                on the PAYER (`agent_id`).
 *   `super_agent_wallet_ledger` - every wallet movement, including the mirror
 *                                side of a sub-agent's top-up, keyed on the
 *                                wallet HOLDER.
 *
 * A sub-agent's top-up writes BOTH: `wallet_topups` names the sub-agent as the
 * funder, and the ledger credits the super agent's real wallet. Reading only
 * one of them therefore misses half the movement - and reading only the ledger
 * cannot tell a super agent "Kofi funded my wallet Ghc 500" from "my wallet
 * spent Ghc 500 on an order", because both are debits and credits against the
 * same balance.
 *
 * `wallet_topups.wallet_owner_id` (migration 20260928_007) is the AUTHORITATIVE
 * link: it is the wallet that was actually credited, written by the edge
 * function from the resolved owner rather than guessed from the payer. Filtering
 * on `wallet_owner_id = <super agent>` is therefore the one predicate that is
 * correct for both row shapes:
 *
 *   - a super agent's own top-up: owner == payer == the super agent
 *   - a sub-agent's top-up:       owner == the super agent, payer == sub-agent
 *
 * Requires `wallet_topups_read_by_super_agent` from 20260928_008 for the
 * sub-agent rows. Without it those rows are filtered out silently (HTTP 200,
 * no error), so a legitimate `[]` and a denied read are indistinguishable.
 */
export const fetchSubAgentTopups = async ({ superAgentId, limit } = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  // OR-joined in one round trip. Two `.or()` calls would need Supabase to
  // merge them, which it does not; a single filter string with both branches is
  // the reliable form.
  const rows = await walkAll((from, to) =>
    supabase
      .from("wallet_topups")
      .select("*", { count: "exact" })
      .or(`wallet_owner_id.eq.${userId},agent_id.eq.${userId}`)
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
};

/**
 * Wallet top-ups with each payer already named, newest first.
 *
 * The naming is the difference between this and `fetchSubAgentTopups`, and it
 * is not cosmetic: a top-up row is keyed on a raw payer uuid, so an unnamed
 * version renders as a UUID in the middle of a financial list. That is the
 * symptom that prompted this - "Wallet top-up by Sub-agent" on a screen where
 * the super agent can see their agent's real name one tap away.
 *
 * Rows are attributed by `funder_user_id` (who pressed Pay), falling back to
 * `agent_id`. The fallback is not defensive noise: both columns arrived in
 * migration 20260928_007, so a row written before it has both NULL, and
 * `agent_id` is the only remaining record of who paid.
 *
 * A payer outside the roster resolves to "You" when it is the caller and to
 * "Sub-agent" otherwise. Neither is a guess about identity - both are honest
 * statements of what the row can prove, and a UUID is never shown.
 */
export const fetchNamedTopups = async ({
  superAgentId,
  limit,
  onWarning,
} = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  let roster = [];
  try {
    roster = (await fetchSubAgentBalances({ superAgentId: userId })) || [];
  } catch (error) {
    console.error("Failed to load sub-agent roster for top-up names:", error);
    if (typeof onWarning === "function") {
      onWarning(
        "Could not load your sub-agent roster, so top-ups may not show a name.",
      );
    }
  }

  const nameForAgent = new Map(roster.map((member) => [member.id, member.name]));

  let rows;
  try {
    rows = await fetchSubAgentTopups({ superAgentId: userId, limit });
  } catch (error) {
    console.error("Failed to load wallet top-ups:", error);
    if (typeof onWarning === "function") {
      onWarning(
        "Could not load your wallet top-ups. Apply migration 20260928_008 " +
          "if this persists.",
      );
    }
    return [];
  }

  const named = (rows || []).map((topup) => {
    const payerId = topup.funder_user_id || topup.agent_id;
    return {
      ...topup,
      orderType: "topup",
      source: "wallet_topup",
      isSubAgentTransaction: String(payerId) !== String(userId),
      subAgentId: payerId,
      subAgentName: resolvePayerName(payerId, nameForAgent, userId),
    };
  });

  return named;
};

/**
 * A map of ledger reference -> the user id who funded it, for top-ups only.
 *
 * WHY THIS EXISTS ALONGSIDE `metadata.funded_by`
 * ----------------------------------------------
 * `verify-wallet-topup` records the funder in the ledger row's metadata, but
 * only in the build that introduced it. Every row written before that has an
 * empty metadata object, so the funder of a historical sub-agent top-up is
 * unrecoverable from the ledger alone - even though `wallet_topups` still holds
 * it, in `funder_user_id`, backfilled for every row by migration 20260928_007.
 *
 * The two are joined on `reference`. Both sides derive it the same way
 * (`wallet-topup-<topupId><suffix>`), which is what makes the join exact: the
 * sub-agent's mirrored row carries a `:sub:<id>` suffix that no bare top-up
 * reference has, so it simply finds no match and falls back to its metadata.
 *
 * Returns `{}` rather than throwing when nothing is found, so a caller with no
 * top-ups at all does not have to special-case an empty result.
 */
export const fetchTopupFunders = async ({ superAgentId } = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return {};

  const rows = await fetchSubAgentTopups({ superAgentId: userId });
  const funders = {};

  (rows || []).forEach((topup) => {
    if (!topup?.reference) return;
    // `funder_user_id` is the authoritative payer; `agent_id` is the fallback
    // for a row written before 20260928_007 populated the new columns.
    const funder = topup.funder_user_id || topup.agent_id;
    if (funder) funders[String(topup.reference)] = String(funder);
  });

  return funders;
};

/**
 * The full wallet ledger for a super agent: their own movements plus every
 * movement on their sub-agents' mirrored wallets, as one chronological list.
 *
 * WHY THE HOLDER SET IS RESOLVED FIRST
 * ------------------------------------
 * `super_agent_wallet_ledger.super_agent_id` is the wallet HOLDER, not the
 * super agent. A sub-agent's mirrored movements are keyed on the SUB-AGENT's
 * id, so `super_agent_id = <caller>` returns the real-money wallet only and
 * silently omits the mirror side. The holder set has to be resolved from the
 * roster before the query can be built - see `fetchSubAgentBalances` for why
 * that is a two-step read rather than a join.
 *
 * WHICH WALLETS ARE INCLUDED, AND WHY THE OWNER IS NOT ENOUGH
 * -----------------------------------------------------------
 * The caller is ALWAYS added to the holder set. `super_agent_wallet_ledger`
 * lets a sub-agent read their OWN mirrored ledger (the original
 * `super_agent_id = auth.uid()` policy), so a sub-agent's movements are
 * readable twice over - once through the super agent reading the holder column,
 * and once through the sub-agent reading it as themselves. The owner's own
 * ledger is the one leg only they can read. Omitting it would produce a
 * statement that silently dropped the super agent's real money.
 *
 * EMPTY ROSTER IS NOT AN ERROR
 * ---------------------------
 * With no sub-agents the holder set is just the caller, and the result is a
 * valid single-wallet statement. That is the common case for a new super agent
 * and must not read as "no ledger found".
  *
  * WHY IT RETURNS AN OBJECT, NOT A BARE ARRAY
  * ------------------------------------------
  * Because the entries alone cannot be rendered as a statement. Each row is keyed
  * on a wallet HOLDER uuid, so a bare array forces every caller to either show a
  * uuid or invent a label. The roster is the uuid-to-name map for exactly those
  * holders, and it is produced by the same call that resolves them, so the two
  * cannot disagree.
  *
  * @returns {Promise<{ entries: Array<object>, roster: Array<object> }>}
  */
export const fetchFullWalletLedger = async ({
  superAgentId,
  limit,
  onWarning,
} = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return { entries: [], roster: [], funders: {} };

  let roster = [];
  try {
    roster = (await fetchSubAgentBalances({ superAgentId: userId })) || [];
  } catch (error) {
    console.error("Failed to load sub-agent roster for the ledger:", error);
    if (typeof onWarning === "function") {
      onWarning(
        "Could not load your sub-agent roster; this statement covers your own " +
          "wallet only.",
      );
    }
  }

  // The caller first, so the statement is ordered from the wallet they can
  // definitely see to the mirrored ones.
  const holderIds = [
    userId,
    ...roster.map((member) => member.id).filter((id) => id !== userId),
  ];

  // Top-ups, fetched alongside the ledger rather than after it, because they
  // carry the only funder record that survives on rows written before
  // `metadata.funded_by` existed. See `ledgerFunderId` for why that is not
  // enough on its own.
  //
  // A failure here is swallowed rather than thrown: it degrades the naming on
  // older rows and nothing else. Throwing would blank the whole statement over a
  // column that is missing on at most some of the rows.
  const funders = await fetchTopupFunders({ superAgentId: userId }).catch(
    (error) => {
      console.error("Failed to load top-up funders for the ledger:", error);
      return {};
    },
  );

  try {
    const rows = await fetchWalletLedger({
      superAgentId: userId,
      holderIds,
      limit,
    });
    // The roster rides along rather than being fetched again by the caller.
    //
    // Returning it here means the names and the entries are guaranteed to come
    // from ONE resolution of the roster. A caller that fetched them separately
    // could hold a roster read from before an admin reassigned someone, and
    // would then attribute a movement to whoever used to own that wallet - a
    // wrong name on a financial statement, which is worse than no name.
    return { entries: rows || [], roster, funders };
  } catch (error) {
    console.error("Failed to load the wallet ledger:", error);
    if (typeof onWarning === "function") {
      onWarning(
        "Could not load your wallet ledger. Apply migration 20261003_002 if " +
          "this persists.",
      );
    }
    // The roster is still returned. Losing it here would mean a caller that
    // merely failed to read entries also loses the ability to name the holders,
    // for two independent failures in one call.
    return { entries: [], roster, funders };
  }
};

/**
 * Opens a balance up and down, and the running balance it ends at.
 *
 * Computed from the rows already fetched rather than by summing them, because
 * the ledger carries `balance_before` / `balance_after` per entry and those are
 * written by the SECURITY DEFINER RPCs under the service role. Re-deriving a
 * total from them agrees with the database by construction, whereas summing
 * `amount` columns independently would disagree silently the moment a row was
 * written by an older build that recorded only one side.
 *
 * @param {Array<object>} rows newest-first ledger entries
 * @returns {{ credits: number, debits: number, net: number,
 *             opening: number|null, closing: number|null }}
 */
export const summariseLedger = (rows) => {
  const entries = Array.isArray(rows) ? rows : [];

  let credits = 0;
  let debits = 0;
  entries.forEach((entry) => {
    const value = Number(entry?.amount || 0);
    const direction = String(entry?.entry_type || "")
      .trim()
      .toLowerCase();
    if (direction === "credit") credits += value;
    else if (direction === "debit") debits += value;
  });

  // `entries` is newest-first, so the LAST row is the oldest and therefore
  // holds the opening balance. Reading the first row here would report the
  // closing balance as the opening one and make every total look wrong.
  const oldest = entries[entries.length - 1] || null;
  const newest = entries[0] || null;

  const opening =
    oldest?.balance_before != null ? Number(oldest.balance_before) : null;
  const closing =
    newest?.balance_after != null ? Number(newest.balance_after) : null;

  return {
    credits: Number(credits.toFixed(2)),
    debits: Number(debits.toFixed(2)),
    net: Number((credits - debits).toFixed(2)),
    opening,
    closing,
  };
};

/**
 * The signed-in super agent's sub-agent activity, as one chronological list
 * shaped for the Home activity card.
 *
 * WHY A BUILDER AND NOT A QUERY
 * -----------------------------
 * "My sub-agents' orders and wallet top-ups" is four tables wide - `agent_orders`
 * (what was bought), `payment_transactions` (the money record for it),
 * `wallet_topups` (money in) and `super_agent_wallet_ledger` (every wallet
 * movement). Merging them in SQL would need a join across four tables plus a
 * name lookup that RLS forbids the client from doing directly, so they are
 * merged here, once, and every surface renders the same result.
 *
 * Two rows are deliberately NOT emitted for one purchase. `agent_orders` and
 * `payment_transactions` describe the same event between them, so they are
 * joined on `order_id` and the order's own status wins - rendering both would
 * double-count a single purchase in a list of five.
 *
 * `wallet_topups` and the ledger are separate rows because a top-up is not an
 * order: a mirror rollback and an admin top-up have no `agent_orders` row at
 * all, and an order has no top-up row. Merging those two would lose real
 * movements on both sides.
 *
 * EVERY SOURCE FAILS INDEPENDENTLY
 * --------------------------------
 * Each read is caught on its own and reported rather than thrown. These RLS
 * policies fail CLOSED and SILENTLY - a denied `SELECT` returns HTTP 200 with
 * zero rows, never an error - so one missing policy would otherwise render as
 * "this super agent has no sub-agent activity", which is indistinguishable from
 * the truth. Surfacing the missing leg keeps a broken policy diagnosable
 * instead of merely invisible.
 *
 * `onWarning` is called once per failed source. It is optional so a caller that
 * only wants the rows can ignore it.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.superAgentId] defaults to the signed-in user
 * @param {number}   [opts.limit]        cap on MERGED rows, applied after sort
 * @param {Function} [opts.onWarning]    called with a human-readable string
 * @returns {Promise<Array<object>>} newest first
 */
export const fetchSubAgentActivity = async ({
  superAgentId,
  limit,
  onWarning,
} = {}) => {
  const userId = superAgentId || (await getCurrentUserId());
  if (!userId) return [];

  const warn = (message) => {
    if (typeof onWarning === "function") onWarning(message);
  };

  // The roster first, and it is also the name source. Without it every row
  // would be attributed to an anonymous "Sub-agent", which is the state
  // 20261003_003 exists to fix.
  let roster = [];
  try {
    roster = (await fetchSubAgentBalances({ superAgentId: userId })) || [];
  } catch (error) {
    warn(
      "Could not load your sub-agent roster; their names will be unavailable. " +
        "Apply migration 20261003_003 if this persists.",
    );
    console.error("Failed to load sub-agent roster:", error);
  }

  const nameForAgent = new Map(roster.map((member) => [member.id, member.name]));

  const sources = await Promise.all([
    // Orders and their payment records.
    fetchSubAgentOrders({ superAgentId: userId })
      .catch((error) => {
        warn(
          "Could not load your sub-agents' orders. Apply migration " +
            "20261003_002 if this persists.",
        );
        console.error("Failed to load sub-agent orders:", error);
        return [];
      }),
    fetchSubAgentPayments({ superAgentId: userId })
      .catch((error) => {
        warn(
          "Could not load your sub-agents' payment records. " +
            "Apply migration 20260921_002 if this persists.",
        );
        console.error("Failed to load sub-agent payments:", error);
        return [];
      }),
    // Money in.
    fetchSubAgentTopups({ superAgentId: userId })
      .catch((error) => {
        warn(
          "Could not load your sub-agents' wallet top-ups. " +
            "Apply migration 20260928_008 if this persists.",
        );
        console.error("Failed to load sub-agent top-ups:", error);
        return [];
      }),
    // Every wallet movement, including the mirror side of the top-ups above.
    //
    // GUARDED on a non-empty roster, and this guard is load-bearing rather than
    // an optimisation. `fetchWalletLedger` treats an empty `holderIds` as "no
    // filter given" and falls back to reading the caller's OWN ledger - so an
    // unguarded call here would hand back the super agent's real-money movements
    // and label every one of them "Sub-agent", for a super agent who has no
    // sub-agents at all. The fallback is a useful default for a direct caller
    // and actively wrong here.
    roster.length
      ? fetchWalletLedger({
          superAgentId: userId,
          holderIds: roster.map((member) => member.id),
        }).catch((error) => {
          warn(
            "Could not load your sub-agents' wallet movements. " +
            "Apply migration 20261003_002 if this persists.",
          );
          console.error("Failed to load sub-agent ledger:", error);
          return [];
        })
      : [],
  ]);

  const [orders, payments, topups, ledger] = sources;

  // Joined on `order_id`, not emitted twice. The ORDER's status wins: the
  // payment's `settlement_status` is the money side, and showing that instead
  // is how a delivered order ends up labelled "Pending" forever.
  const paymentByOrderId = new Map(
    payments
      .filter((payment) => payment?.order_id != null)
      .map((payment) => [payment.order_id, payment]),
  );

  const rows = [];

  orders.forEach((order) => {
    const payment = paymentByOrderId.get(order.id);
    rows.push({
      ...order,
      ...(payment
        ? {
            transaction_fee: payment.transaction_fee,
            super_agent_amount: payment.super_agent_amount,
            agent_net: payment.agent_net,
            main_account_amount: payment.main_account_amount,
            settlement_status: payment.settlement_status,
            gross_amount: payment.gross_amount,
            payment_reference: payment.payment_reference,
            status: order.status || payment.status,
          }
        : {}),
      orderType: "agent",
      source: "sub_agent_order",
      isSubAgentTransaction: true,
      subAgentId: order.agent_id,
      subAgentName: nameForAgent.get(order.agent_id) || "Sub-agent",
      displayName: order.recipient_name,
      displayPhone: order.recipient_phone,
    });
  });

  topups.forEach((topup) => {
    const payerId = topup.funder_user_id || topup.agent_id;
    // A super agent's OWN top-up is included deliberately - `agent_id` is one of
    // the two branches in `fetchSubAgentTopups` - because Home previously showed
    // a super agent no wallet activity whatsoever, not even their own funding.
    // Naming is the only thing that differs, since there is no second person to
    // attribute it to.
    const isOwn = payerId === userId;
    rows.push({
      ...topup,
      orderType: "topup",
      source: "sub_agent_topup",
      isSubAgentTransaction: !isOwn,
      subAgentId: payerId,
      // `funder_user_id`/`wallet_owner_id` arrived in 20260928_007 and may be
      // NULL on rows written before it, so `agent_id` is the fallback. A payer
      // outside the roster is a real event - a super agent funding their own
      // wallet - and must not be dropped or mislabelled as somebody else's.
      // `resolvePayerName` is the shared resolver, so a top-up is named the same
      // way on Home, in History and on the ledger regardless of which screen
      // loaded it.
      subAgentName: resolvePayerName(payerId, nameForAgent, userId),
    });
  });

  ledger.forEach((entry) => {
    rows.push({
      ...entry,
      orderType: "ledger",
      source: "sub_agent_ledger",
      isSubAgentTransaction: true,
      subAgentId: entry.super_agent_id,
      subAgentName: nameForAgent.get(entry.super_agent_id) || "Sub-agent",
    });
  });

  const merged = rows.sort(
    (a, b) =>
      new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime(),
  );

  return Number.isFinite(limit) && limit > 0 ? merged.slice(0, limit) : merged;
};

/**
 * The statuses a Super Agent may apply to a sub-agent's order.
 *
 * A SUBSET of the admin vocabulary, and the omission is the whole point.
 * `cancelled` and `refunded` are not labels here - they route through
 * `cancel_admin_order`, which CREDITS the wallet that was debited. A super
 * agent is a commercial party to these orders: they took the money and sold
 * the data. Allowed to fire that on a delivered order, they would refund
 * themselves for data the recipient already received.
 *
 * `failed` is excluded for the same family of reasons: the held-order expiry
 * sweep treats it as a refundable terminal state.
 *
 * Must stay in sync with WRITABLE_STATUSES in
 * supabase/functions/super-agent-order-status/index.ts
 */
export const SUPER_AGENT_WRITABLE_STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "delivered", label: "Delivered" },
];

/**
 * Moves one of the caller's sub-agents' orders to a new status.
 *
 * Server-side authorization is the only thing that matters here: the edge
 * function re-reads the row and refuses anything whose `super_agent_id` is not
 * the caller, so a tampered client is a 403 rather than a cross-roster write.
 *
 * Returns `{ ok, message }` rather than throwing, so a caller can surface the
 * server's own wording ("This order is already cancelled and cannot be
 * reopened here") without re-deriving the rule.
 */
export const updateSubAgentOrderStatus = async (orderId, status) => {
  const functionName = getEdgeFunctionName("super-agent-order-status");

  const { data, error } = await supabase.functions.invoke(functionName, {
    body: { order_id: orderId, status },
  });

  if (error || data?.error) {
    const message = await getEdgeFunctionErrorMessage(
      error,
      data?.error || "Could not update the order.",
    );
    return { ok: false, message };
  }

  return { ok: true, message: null, data };
};

// ===========================================================================
// Display vocabulary
// ===========================================================================
// Why this is here and not in a screen
// ------------------------------
// `reason` and `entry_type` are storage values. They are written by four
// different edge functions (verify-wallet-topup, verify-payment,
// dispatch-order, cancel-admin-order) and a fifth meaning arrives with any new
// caller. The label a super agent reads must not depend on which screen they
// happen to be looking at, so the vocabulary lives beside the data access and
// both the ledger page and the transactions page import it from here.

// Mirrors the admin Wallet screen's presentation, so the same movement reads
// the same way to both parties. Keys are lower-cased on lookup.
const LEDGER_REASON_LABELS = {
  wallet_topup: "Wallet top-up",
  // The two halves of ONE sub-agent top-up. The super agent's side is real
  // money entering the wallet they hold; the sub-agent's side is the mirrored
  // spending power the same payment unlocked. They are distinct movements on
  // distinct wallets and both must read as a top-up rather than as the
  // de-underscored fallback, which would show the raw storage value.
  sub_agent_wallet_topup_super_agent_side: "Sub-agent top-up",
  sub_agent_wallet_topup_sub_agent_side: "Sub-agent top-up (mirrored)",
  admin_wallet_topup: "Admin top-up",
  admin_wallet_debit: "Admin debit",
  sub_agent_order: "Sub-agent order",
  sub_agent_package_purchase: "Sub-agent purchase",
  super_agent_package_purchase: "Wallet purchase",
  sub_agent_mirror_rollback: "Mirror rollback",
  order_refund: "Order refund",
  order_release: "Order release",
  held_order_release: "Held order release",
  order_cancel: "Order cancelled",
  admin_wallet_credit: "Admin credit",
};

/**
 * A human label for a wallet ledger `reason`.
 *
 * An UNKNOWN reason falls back to a de-underscored, capitalised form of itself
 * rather than to a blank or a generic word. A super agent reconciling a
 * statement needs to see that something unfamiliar happened; rendering it as
 * "Wallet movement" hides exactly the row they are looking for.
 */
export const ledgerReasonLabel = (reason) => {
  const key = String(reason || "")
    .trim()
    .toLowerCase();
  if (LEDGER_REASON_LABELS[key]) return LEDGER_REASON_LABELS[key];
  return key
    ? key.replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase())
    : "Wallet movement";
};

/**
 * A ledger entry's direction as a word.
 *
 * `entry_type` is CHECK-constrained to 'credit' | 'debit' by the table
 * definition, so the default branch is unreachable in practice. It is still
 * handled rather than assumed away, because this is an authorization-adjacent
 * figure: an unrecognised direction must not silently render as an outgoing
 * amount, which would tell a super agent they have less money than they do.
 */
export const ledgerEntryLabel = (entryType) => {
  const key = String(entryType || "").trim().toLowerCase();
  if (key === "credit") return "Credit";
  if (key === "debit") return "Debit";
  return "Movement";
};

/**
 * The signed amount for a ledger entry, e.g. "+Ghc 500.00".
 *
 * The sign is computed from `entry_type` and NEVER inferred from the sign of
 * `amount`. `amount` is declared `CHECK (amount <> 0)` with no direction
 * encoded in it, so a debit and a credit of the same size are the same number -
 * a screen that trusted the sign would render every debit as incoming money.
 */
export const formatLedgerAmount = (entry) => {
  const value = Number(entry?.amount || 0);
  const direction = String(entry?.entry_type || "")
    .trim()
    .toLowerCase();
  const sign = direction === "credit" ? "+" : direction === "debit" ? "-" : "";
  return `${sign}Ghc ${Math.abs(value).toFixed(2)}`;
};

/**
 * A display name for a payer id, resolving through the roster when possible.
 *
 * Returns "You" for the caller themselves rather than their own name: on a
 * super agent's own wallet statement "You" reads correctly, whereas printing
 * their legal name on their own screen is noise.
 *
 * An id outside the roster resolves to "Sub-agent" rather than to a raw UUID. A
 * UUID in a name field is unreadable and looks like a bug even though it is
 * merely unattributed.
 */
export const resolvePayerName = (payerId, nameForAgent, currentUserId) => {
  if (payerId && currentUserId && String(payerId) === String(currentUserId)) {
    return "You";
  }
  if (payerId && nameForAgent?.has(payerId)) return nameForAgent.get(payerId);
  return "Sub-agent";
};

  /**
   * The user id that PAID for a ledger entry, or null when it is unknown.
   *
   * WHY THIS IS NOT `super_agent_id`
   * -------------------------------
   * `super_agent_wallet_ledger.super_agent_id` is the wallet HOLDER, which is
   * not the same question as who funded it. A sub-agent top-up writes TWO rows:
   *
   *   1. the SUPER AGENT's wallet, credited with the real money received
   *   2. the SUB-AGENT's mirrored wallet, credited with the spending power the
   *      same payment unlocked
   *
   * Both rows carry `metadata.funded_by` = the sub-agent who actually paid, but
   * their `super_agent_id` values differ. Reading only the holder therefore makes
   * a funded top-up indistinguishable from the super agent paying themselves, and
   * the statement silently attributes someone else's money to its own owner.
   *
   * Only `verify-wallet-topup` writes `funded_by`. Order debits, refunds and
   * admin adjustments pass no metadata at all, so a null here is the common case
   * and not an error.
   *
   * Tolerant of a JSON string because the column is jsonb and a driver that
   * returns it unparsed would otherwise make every top-up look self-funded -
   * the same silent-misattribution failure, one layer further in.
   *
   * @param {object} entry a `super_agent_wallet_ledger` row
   * @param {object} funders reference -> funder id, from `fetchTopupFunders`
   */
export const ledgerFunderId = (entry, funders = {}) => {
    let metadata = entry?.metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch (error) {
        console.warn("Unparseable ledger metadata:", error);
        metadata = null;
      }
    }

    let funder = null;
    if (metadata && typeof metadata === "object") {
      const fundedBy = metadata.funded_by;
      if (fundedBy != null) funder = String(fundedBy).trim();
    }

    // The metadata is the primary record, but only rows written by the current
    // build carry it. `funders` covers the rest, keyed on the reference both sides
    // derive identically.
    if (!funder) {
      const reference = entry?.reference;
      funder =
        reference && funders?.[String(reference)]
          ? String(funders[String(reference)]).trim()
          : null;
    }

    return funder || null;
  };

  /**
   * The wallet a ledger entry belongs to, and who funded it, as one string.
   *
   * Deliberately returns the whole phrase rather than a tuple: the three cases
   * that matter to a reader are "this is mine", "this is a sub-agent's" and "this
   * is mine, but a sub-agent paid for it", and the first two are easy to tell
   * apart at a glance while the third is the one that is easy to miss. Rendering
   * it in one composed string means no screen can accidentally show the holder
   * without also showing the payer.
   *
 * The payer is omitted when it equals the holder. On a mirrored row they are
 * always the same person, and "Kofi, funded by Kofi" is noise that pushes the
 * balance figure off the row.
 *
 * `isSuperAgent` disambiguates an unresolvable HOLDER, and it matters because
 * this screen is reachable by sub-agents too - they are not `normal_user`, so
 * the guard lets them through, and the holder they are looking at is their own
 * super agent rather than a peer. Without this they would read their super
 * agent's wallet as "Sub-agent", which names the wrong party entirely.
 *
 * @param {object} entry a `super_agent_wallet_ledger` row
 * @param {{ names?: object, currentUserId?: string, funders?: object,
 *           isSuperAgent?: boolean }} context
 * @returns {string}
 */
export const ledgerActorLabel = (
  entry,
  { names, currentUserId, funders, isSuperAgent } = {},
) => {
    const holderId = String(entry?.super_agent_id || "");
    const selfId = String(currentUserId || "");
    const isOwn = Boolean(holderId) && holderId === selfId;

    // "Your wallet" rather than the caller's own name: on a statement about your
    // own balance, printing your legal name is noise, and this row IS yours.
    //
    // A holder the roster does not know - a sub-agent removed from the team after
    // the movement, or one whose profile row failed RLS - still gets a readable
    // label. "Sub-agent" is honest about that; a uuid is not.
    const holderName = isOwn
      ? "Your wallet"
      : names?.[holderId] ||
        (isSuperAgent === false ? "Your super agent" : "Sub-agent");

    const funderId = ledgerFunderId(entry, funders);
    if (!funderId || funderId === holderId) return holderName;

    const funderName =
      funderId === selfId
        ? "You"
        : names?.[funderId] ||
          (isSuperAgent === false ? "Your super agent" : "A sub-agent");

    return `${holderName}, funded by ${funderName}`;
  };
