BEGIN;

-- ===========================================================================
-- Super Agent analytics: include wallet-funded sub-agent orders
-- ===========================================================================
-- APPLY AFTER: 20261004_004 (super_agent_profit_from_admin_base_price)
--               20261005_001 (owner_on_wallet_orders)
--
-- WHY
-- ---
-- A sub-agent's order reaches `verify-payment` and takes one of two branches,
-- chosen by how it was PAID FOR rather than by who the buyer is:
--
--   paid by Paystack -> agent_orders + payment_transactions(order_type='agent')
--   paid from wallet -> orders        + payment_transactions(order_type='regular')
--
-- `agent_transactions` - the CTE every super-agent figure is summed from - was
-- INNER JOINed to `agent_orders` and filtered on `order_type = 'agent'`. So a
-- sub-agent who paid from their MIRRORED WALLET was never in it at all: no row,
-- not a zero row, no error. Their sales were absent from the headline profit,
-- the period tiles, the 14-day trend, the per-agent list and the
-- "where the money goes" panel simultaneously.
--
-- WHY THE LEDGER KEPT SHOWING THEM
-- -------------------------------
-- `super_agent_wallet_ledger` is keyed on the WALLET HOLDER, not on the order
-- table. The real-money side of a wallet order debits the super agent's own
-- wallet, so that row lands under their id regardless of which table the
-- purchase was recorded in. The ledger therefore proved the money moved while
-- the order stayed unreadable - which is exactly the reported split: wallet
-- movements visible, orders missing.
--
-- THE FIX
-- -------
-- Union the wallet branch into the same CTE, so one query sees both, and so the
-- existing profit derivation applies unchanged to the new rows.
--
-- Amounts are taken from the PAYMENT row, never from `orders.amount`, because
-- only the payment row carries the settlement the arithmetic needs:
--
--   gross_amount   the sale price the sub-agent paid
--   base_amount    the admin-set base price the super agent's wallet was
--                  actually drawn down by (`superAgentDebitAmount`)
--   transaction_fee always 0 - a wallet order has no Paystack charge, the fee
--                  was taken at top-up time
--
-- `orders.amount` is the sale price too, but `base_amount` and the settlement
-- split exist only on `payment_transactions`, so the join is required rather
-- than optional.
--
-- The existing `gross - base - fee` derivation therefore yields
-- `sale - base - 0` == the markup the sub-agent charged, which is the same
-- figure it yields on a Paystack order. Both branches now report one profit.
--
-- WHY NOT `orders.super_agent_id`
-- ------------------------------
-- The column exists (20261005_001) and is back-filled, and it is used as a
-- SECOND filter rather than as the only one. Two reasons:
--
--   - The payment row is the authoritative settlement record. `orders` is the
--     order record. Filtering on the payment row's own `super_agent_id` means
--     a row can only ever be counted for the agent it actually settled
--     through, even if the order's back-fill was deliberately left incomplete
--     (20261005_001 refuses to guess an owner, so some rows stay NULL by
--     design).
--   - `buyer_type` is deliberately NOT used to identify a sub agent's purchase.
--     `verify-payment` only recently began writing the buyer's real role on the
--     wallet branch; every earlier wallet purchase - including a sub agent's -
--     carries the hardcoded literal 'super_agent'. 20261004_003 corrected the
--     value in `orders` but intentionally did not rewrite
--     `payment_transactions`, so that column is still stale on precisely the
--     historic rows this migration exists to surface. The discriminator used
--     instead is the MIRROR DEBIT: a sub agent's purchase writes a ledger row
--     with reason `sub_agent_package_purchase`, which a super agent's own
--     purchase never does (`verify-payment` skips that leg for them). That is
--     the same signal 20261004_003 moved the refund gate onto, and it is correct
--     for every row regardless of age because it comes from the debit that
--     actually moved the money.
--
-- NOT A DOUBLE COUNT
-- ------------------
-- The two branches are disjoint on `order_type`: 'agent' vs 'regular'. A given
-- purchase is written to exactly one of the two tables by exactly one branch of
-- `verify-payment`, and the `payment_transactions` row records which. So
-- `UNION ALL` cannot double-count a purchase, and cannot silently drop one
-- either - a purchase appears in whichever set its `order_type` names.
--
-- `provider_cost` on the new rows is left to the admin scope only, exactly as
-- it was: `orders.api_cost` is the platform's real provider cost and is not the
-- super agent's, so it must not enter their profit. It is COALESCEd from the
-- `orders` row so the admin's platform-gain figure keeps seeing the same value
-- it saw when the Paystack branch supplied it.
--
-- UNCHANGED DELIBERATELY
-- ----------------------
-- - The profit derivation itself. Not re-derived here; the new rows go through
--   the identical `gross - base - fee` expression as the old ones.
-- - `super_agent_purchases`. A super agent's own wallet purchases already
--   appear there, keyed on `payment_reference LIKE 'wallet_%'` plus a wallet
--   that exists for the payer. Re-deriving that set is a separate concern and
--   touching it risks double-reporting a super agent's own spend.
-- - `api_cost`. Never folded into the super agent's margin; see 20261004_004.
--
-- ===========================================================================
-- (function body carried over from 20261004_004 with the `agent_transactions`
-- CTE extended; every other clause is byte-identical)
-- ===========================================================================
-- Super Agent analytics: derive profit from the ADMIN BASE PRICE
-- (their tier price), not from the client-supplied `agent_markup`
-- ===========================================================================
-- APPLY AFTER: 20261003_004 (analytics_money_split)
--
-- WHY
-- ---
-- `calculate_business_analytics` reported profit as SUM(agent_markup), and
-- `agent_markup` is a SNAPSHOT of what the CLIENT claimed at checkout. In
-- `verify-payment`, `hasPaymentSplit` gates it behind four-term arithmetic on
-- client-supplied numbers:
--
--     base + tier_extra + fee == gross       (within 0.01)
--     fee == base * superAgentChargePercent   (within 0.01)
--
-- If ANY term fails, the function falls through to a default branch that sets
-- `agent_markup = 0` and `base_amount = gross`. The order still succeeds, the
-- sub-agent is still charged, the wallet is still debited - and analytics
-- silently record the whole gross as the super agent's own profit.
--
-- So `agent_markup` cannot be trusted as the input to a profit figure. The
-- trustworthy number is already on the row:
--
--     payment_transactions.base_amount
--
-- which is the admin base price for the super agent's tier - the same figure
-- debited from their wallet (`p_amount: settlement.baseAmount`) and the same
-- figure the admin's pricing screen edits.
--
-- Profit is therefore DERIVED on the read path:
--
--     profit = gross_amount - base_amount - transaction_fee
--
-- For a sub-agent order gross = base + markup + fee, so this collapses to
-- exactly `markup`. Same figure on a validated order, but derived from the
-- price the admin set, so it is correct when the client sent nothing usable.
-- Where `base_amount` fell back to `gross` server-side it yields
-- `gross - gross - fee = -fee`: an honest zero-or-negative, never a
-- fabricated markup.
--
-- `transaction_fee` is the platform's charge, so subtracting it removes money
-- that passes through to nobody rather than to the super agent.
--
-- The old column is still reported as `markup_recorded` for audit: where it
-- agrees with the derived figure the split was validated, where it disagrees
-- the client sent something unverifiable.
--
-- api_cost IS NOT TOUCHED. It is the platform's real provider cost, and the
-- admin app's gain (gross - agent_markup - api_cost) is correct BECAUSE it uses
-- it. Overwriting base price into api_cost would destroy the platform's cost
-- data and corrupt every downstream margin report. This migration changes the
-- SUPER AGENT's P&L only; `get_admin_channel_revenue_analytics` is not
-- redefined.

CREATE OR REPLACE FUNCTION public.calculate_business_analytics(
  p_super_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  effective_super_agent_id uuid := p_super_agent_id;
  result jsonb;
BEGIN
  WITH
  agent_transactions AS (
      -- (a) PAYSTACK branch: buyer paid the provider, order in `agent_orders`.
      --     Unchanged by this migration.
      SELECT
        pt.id,
        pt.super_agent_id,
        pt.user_id AS agent_id,
        pt.created_at,
        pt.gross_amount,
        pt.base_amount,
        pt.agent_markup,
        pt.transaction_fee,
        pt.super_agent_amount,
        -- THE ADMIN BASE PRICE for this super agent's tier. Authoritative: it is
        -- what their wallet was debited and what the admin's pricing screen edits.
        -- Profit below is derived from this, never from `agent_markup`.
        COALESCE(pt.base_amount, 0) AS admin_base_price,
        -- What delivery cost the PLATFORM. Reported for the admin scope only and
        -- never used in the super agent's profit.
        COALESCE(ao.api_cost, pt.base_amount) AS provider_cost,
        ao.status AS order_status,
        CASE
          WHEN ao.status NOT IN ('cancelled', 'failed') THEN 1
          ELSE 0
        END AS is_active
      FROM public.payment_transactions AS pt
      INNER JOIN public.agent_orders AS ao
        ON ao.id = pt.order_id
      WHERE pt.order_type = 'agent'
        AND (
          effective_super_agent_id IS NULL
          OR pt.super_agent_id = effective_super_agent_id
        )

      UNION ALL

      -- (b) WALLET branch: buyer paid from a MIRRORED wallet, order in `orders`.
      --
      -- Added by 20261005_002. These rows existed and were correct in the payment
      -- ledger the whole time; they were simply never read, because the CTE above
      -- INNER JOINed `agent_orders` and this branch writes to `orders`.
      --
      -- Amounts come from the PAYMENT row, not `orders.amount`:
      --   gross_amount    = the sale price the sub-agent paid
      --   base_amount     = the admin base price the super agent's real wallet was
      --                     actually drawn down by (`superAgentDebitAmount`)
      --   transaction_fee = always 0 - a wallet order carries no Paystack charge,
      --                     the fee was netted once at top-up time
      -- so `gross - base - fee` collapses to the sub-agent's markup, identical to
      -- what branch (a) reports for a Paystack purchase.
      --
      -- `agent_markup` is read for the audit column only and is deliberately NOT
      -- used for profit - see 20261004_004 for why it cannot be trusted.
      -- `super_agent_amount` is NOT NULL DEFAULT 0 and this branch never sets it,
      -- so it reports 0 here. It is already excluded from the super agent's own
      -- profit (which uses the derived expression), and nothing on the super-agent
      -- screen sums it as a total, so it is left honest rather than invented.
      SELECT
        pt.id,
        pt.super_agent_id,
        pt.user_id AS agent_id,
        pt.created_at,
        pt.gross_amount,
        pt.base_amount,
        pt.agent_markup,
        pt.transaction_fee,
        pt.super_agent_amount,
        COALESCE(pt.base_amount, 0) AS admin_base_price,
        -- The platform's real provider cost, for the admin scope only. Never a
        -- term in the super agent's profit.
        COALESCE(o.api_cost, pt.base_amount) AS provider_cost,
        o.status AS order_status,
        CASE
          WHEN o.status NOT IN ('cancelled', 'failed') THEN 1
          ELSE 0
        END AS is_active
      FROM public.payment_transactions AS pt
      INNER JOIN public.orders AS o
        ON o.id = pt.order_id
      WHERE pt.order_type = 'regular'
        -- THE BUYER MUST HAVE BEEN A SUB-AGENT, and this is deliberately NOT
        -- read from `buyer_type`.
        --
        -- A super agent's own wallet purchase writes to this same table with
        -- `super_agent_id = NULL` on the order, and reporting it inside
        -- `sub_agent_sales` would credit their own spending to their sub-agent
        -- roster - inflating the count and the markup by money they spent on
        -- themselves. Those rows are already counted once, in
        -- `super_agent_purchases`.
        --
        -- `payment_transactions.buyer_type` CANNOT answer this. `verify-payment`
        -- only began writing the buyer's real role on the wallet branch
        -- recently; before that every wallet purchase - including a sub agent's -
        -- carried the hardcoded literal 'super_agent'. Migration 20261004_003
        -- backfilled the correction into `orders` but deliberately did NOT touch
        -- `payment_transactions`, so its value is still stale on exactly the
        -- historic rows this migration exists to reveal. Filtering on it would
        -- leave the reported bug in place for every purchase made before that
        -- release while looking correct on new ones.
        --
        -- THE MIRROR DEBIT IS THE AUTHORITATIVE SIGNAL, and it is the same
        -- discriminator 20261004_003 moved the refund gate onto. A sub agent's
        -- wallet purchase debits BOTH sides of the mirror:
        --
        --   :sub:<agent_id>  reason 'sub_agent_package_purchase'   <- their side
        --   (unsuffixed)     reason 'super_agent_package_purchase'  <- real money
        --
        -- A super agent's own purchase debits ONE ledger row and never writes the
        -- 'sub_agent_package_purchase' reason at all - `verify-payment` skips that
        -- leg entirely for them. So the presence of that one row separates the two
        -- buyer types on data that is correct for every row, historic or new,
        -- because it is written by the debit that actually moved their money
        -- rather than by a label the caller supplied.
        --
        -- Correlated on `order_id`, so a sub agent's mirror debit from an
        -- unrelated order cannot vouch for this one.
        AND EXISTS (
          SELECT 1
          FROM public.super_agent_wallet_ledger AS mirror
          WHERE mirror.order_id = pt.order_id
            AND mirror.entry_type = 'debit'
            AND mirror.reason = 'sub_agent_package_purchase'
        )
        -- The super agent whose money paid for it. Taken from the PAYMENT row,
        -- which `verify-payment` stamps from the resolved owner, rather than from
        -- `orders.super_agent_id` - that column is a BACK-FILL (20261005_001) that
        -- refuses to guess an owner, so some historic rows are NULL by design and
        -- filtering on it would re-hide those purchases.
        AND (
          effective_super_agent_id IS NULL
          OR pt.super_agent_id = effective_super_agent_id
        )
    ),
  super_agent_purchases AS (
    SELECT
      pt.id,
      pt.user_id AS super_agent_id,
      pt.created_at,
      pt.gross_amount,
      pt.base_amount,
      pt.transaction_fee,
      o.status AS order_status,
      CASE
        WHEN o.status NOT IN ('cancelled', 'failed') THEN 1
        ELSE 0
      END AS is_active
    FROM public.payment_transactions AS pt
    INNER JOIN public.orders AS o
      ON o.id = pt.order_id
    WHERE pt.order_type = 'regular'
      AND pt.payment_reference LIKE 'wallet_%'
      AND EXISTS (
        SELECT 1
        FROM public.super_agent_wallets AS buyer_wallet
        WHERE buyer_wallet.super_agent_id = pt.user_id
      )
      AND (
        effective_super_agent_id IS NULL
        OR pt.user_id = effective_super_agent_id
      )
  ),
  afa_entries AS (
    SELECT
      ledger.id,
      ledger.created_at,
      ledger.entry_type,
      ledger.payment_method,
      registration.assigned_super_agent_id AS super_agent_id,
      CASE
        WHEN ledger.entry_type = 'refund' THEN -ledger.amount
        ELSE ledger.amount
      END AS signed_amount
    FROM public.afa_payment_ledger AS ledger
    INNER JOIN public.afa_registrations AS registration
      ON registration.id = ledger.registration_id
    WHERE (
      effective_super_agent_id IS NULL
      OR registration.assigned_super_agent_id = effective_super_agent_id
    )
  ),
  wallet_balances AS (
    SELECT
      COALESCE(SUM(balance), 0) AS total_balance,
      COUNT(*) FILTER (WHERE balance > 0) AS funded_wallet_count
    FROM public.super_agent_wallets
    WHERE effective_super_agent_id IS NULL
       OR super_agent_id = effective_super_agent_id
  ),
  wallet_movements AS (
    SELECT ledger.entry_type, ledger.amount, ledger.created_at
    FROM public.super_agent_wallet_ledger AS ledger
    WHERE effective_super_agent_id IS NULL
       OR ledger.super_agent_id = effective_super_agent_id
  ),
  wallet_funding AS (
    SELECT topup.amount, topup.created_at
    FROM public.wallet_topups AS topup
    WHERE topup.status = 'success'
      AND EXISTS (
        SELECT 1
        FROM public.super_agent_wallets AS funder_wallet
        WHERE funder_wallet.super_agent_id = topup.agent_id
      )
      AND (
        effective_super_agent_id IS NULL
        OR topup.agent_id = effective_super_agent_id
      )
  ),
  sub_agent_totals AS (
    SELECT
      atx.agent_id,
      atx.super_agent_id,
      COALESCE(agent_profile.business_name, '') AS business_name,
      COALESCE(agent_profile.full_name, '') AS full_name,
      COALESCE(agent.email, '') AS email,
      COUNT(*) FILTER (WHERE atx.is_active = 1) AS transaction_count,
      COALESCE(SUM(atx.gross_amount) FILTER (WHERE atx.is_active = 1), 0) AS gross_sales,
      COALESCE(SUM(atx.admin_base_price) FILTER (WHERE atx.is_active = 1), 0) AS base_cost,
      -- DERIVED from the admin base price: gross - base - fee == markup.
      COALESCE(SUM(atx.gross_amount - atx.admin_base_price - atx.transaction_fee)
               FILTER (WHERE atx.is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(atx.agent_markup) FILTER (WHERE atx.is_active = 1), 0) AS markup_recorded,
      COALESCE(SUM(atx.provider_cost) FILTER (WHERE atx.is_active = 1), 0) AS provider_cost,
      COALESCE(SUM(atx.transaction_fee) FILTER (WHERE atx.is_active = 1), 0) AS platform_fees,
      COALESCE(SUM(atx.super_agent_amount) FILTER (WHERE atx.is_active = 1), 0) AS super_agent_revenue
    FROM agent_transactions AS atx
    LEFT JOIN public.user_profiles AS agent_profile
      ON agent_profile.id = atx.agent_id
    LEFT JOIN auth.users AS agent
      ON agent.id = atx.agent_id
    WHERE atx.agent_id IS NOT NULL
    GROUP BY
      atx.agent_id,
      atx.super_agent_id,
      COALESCE(agent_profile.business_name, ''),
      COALESCE(agent_profile.full_name, ''),
      COALESCE(agent.email, '')
  ),
  super_agent_totals AS (
    SELECT
      atx.super_agent_id,
      COALESCE(sa_profile.business_name, '') AS business_name,
      COALESCE(sa_profile.full_name, '') AS full_name,
      COALESCE(sa.email, '') AS email,
      COUNT(*) FILTER (WHERE atx.is_active = 1) AS transaction_count,
      COALESCE(SUM(atx.gross_amount) FILTER (WHERE atx.is_active = 1), 0) AS gross_sales,
      COALESCE(SUM(atx.admin_base_price) FILTER (WHERE atx.is_active = 1), 0) AS base_cost,
      COALESCE(SUM(atx.gross_amount - atx.admin_base_price - atx.transaction_fee)
               FILTER (WHERE atx.is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(atx.agent_markup) FILTER (WHERE atx.is_active = 1), 0) AS markup_recorded,
      COALESCE(SUM(atx.transaction_fee) FILTER (WHERE atx.is_active = 1), 0) AS platform_fees,
      COALESCE(SUM(atx.super_agent_amount) FILTER (WHERE atx.is_active = 1), 0) AS super_agent_revenue
    FROM agent_transactions AS atx
    LEFT JOIN public.user_profiles AS sa_profile
      ON sa_profile.id = atx.super_agent_id
    LEFT JOIN auth.users AS sa
      ON sa.id = atx.super_agent_id
    WHERE atx.super_agent_id IS NOT NULL
    GROUP BY
      atx.super_agent_id,
      COALESCE(sa_profile.business_name, ''),
      COALESCE(sa_profile.full_name, ''),
      COALESCE(sa.email, '')
  ),
  daily_trend AS (
    SELECT
      date_trunc('day', created_at)::date AS day,
      COUNT(*) FILTER (WHERE is_active = 1) AS transaction_count,
      COALESCE(SUM(super_agent_amount) FILTER (WHERE is_active = 1), 0) AS earnings,
      -- Same derivation as `markup_earnings`, so the trend cannot disagree
      -- with the headline it sits under.
      COALESCE(SUM(gross_amount - admin_base_price - transaction_fee)
               FILTER (WHERE is_active = 1), 0) AS profit,
      COALESCE(SUM(gross_amount - admin_base_price - transaction_fee)
               FILTER (WHERE is_active = 1), 0) AS markup_earnings,
      COALESCE(SUM(gross_amount) FILTER (WHERE is_active = 1), 0) AS gross_sales
    FROM agent_transactions
    WHERE created_at >= current_date - interval '13 days'
    GROUP BY date_trunc('day', created_at)::date
  )
  SELECT jsonb_build_object(
    'scope', jsonb_build_object(
      'role', CASE
        WHEN effective_super_agent_id IS NULL THEN 'admin'
        ELSE 'super_agent'
      END,
      'super_agent_id', effective_super_agent_id
    ),
    'earnings', jsonb_build_object(
      'today', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= current_date),
      'week', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('week', now())),
      'month', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('month', now())),
      'year', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('year', now())),
      'all_time', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1),
      -- PROFIT, DERIVED FROM THE ADMIN BASE PRICE. `earnings.*` above is
      -- base + markup, so it overstates profit by the whole pass-through cost.
      'profit_today', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= current_date),
      'profit_week', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('week', now())),
      'profit_month', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('month', now())),
      'profit_year', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1 AND created_at >= date_trunc('year', now())),
      'profit_all_time', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1)
    ),
    'sub_agent_sales', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM agent_transactions WHERE is_active = 1),
      'gross_sales', (SELECT COALESCE(SUM(gross_amount), 0) FROM agent_transactions WHERE is_active = 1),
      -- The admin base price: what the super agent paid the platform for the
      -- data they resold. Revenue for the platform, a cost to them.
      'base_cost', (SELECT COALESCE(SUM(admin_base_price), 0) FROM agent_transactions WHERE is_active = 1),
      'markup_profit', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      'markup_earnings', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      -- What the client claimed, kept for audit only.
      'markup_recorded', (SELECT COALESCE(SUM(agent_markup), 0) FROM agent_transactions WHERE is_active = 1),
      'provider_cost', (SELECT COALESCE(SUM(provider_cost), 0) FROM agent_transactions WHERE is_active = 1),
      'platform_fees', (SELECT COALESCE(SUM(transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
      'super_agent_revenue', (SELECT COALESCE(SUM(super_agent_amount), 0) FROM agent_transactions WHERE is_active = 1),
      'active_sub_agents', (SELECT COUNT(DISTINCT agent_id) FROM agent_transactions WHERE is_active = 1),
      'held_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status = 'held'),
      'cancelled_count', (SELECT COUNT(*) FROM agent_transactions WHERE order_status IN ('cancelled', 'failed'))
    ),
    -- The platform's own money, admin scope only. Still measured against the
    -- REAL provider cost - the base price is the super agent's cost, not the
    -- platform's, so using it here would overstate platform profit by the
    -- entire provider margin.
    'platform', CASE
      WHEN effective_super_agent_id IS NULL THEN jsonb_build_object(
        'gross_collected', (SELECT COALESCE(SUM(gross_amount), 0) FROM agent_transactions WHERE is_active = 1),
        'provider_cost', (SELECT COALESCE(SUM(provider_cost), 0) FROM agent_transactions WHERE is_active = 1),
        'tier_revenue', (SELECT COALESCE(SUM(admin_base_price), 0) FROM agent_transactions WHERE is_active = 1),
        'fees_collected', (SELECT COALESCE(SUM(transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
        'markup_paid_to_super_agents', (SELECT COALESCE(SUM(gross_amount - admin_base_price - transaction_fee), 0) FROM agent_transactions WHERE is_active = 1),
        -- base + fee - provider_cost. The markup is excluded on purpose: it is
        -- money the platform collected and immediately passed on.
        'gain', (SELECT COALESCE(SUM(admin_base_price + transaction_fee - provider_cost), 0) FROM agent_transactions WHERE is_active = 1)
      )
      ELSE NULL
    END,
    'super_agent_purchases', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM super_agent_purchases WHERE is_active = 1),
      'wallet_spend', (SELECT COALESCE(SUM(gross_amount), 0) FROM super_agent_purchases WHERE is_active = 1),
      'base_cost', (SELECT COALESCE(SUM(base_amount), 0) FROM super_agent_purchases WHERE is_active = 1),
      'cancelled_count', (SELECT COUNT(*) FROM super_agent_purchases WHERE order_status IN ('cancelled', 'failed'))
    ),
    'wallets', jsonb_build_object(
      'current_balance', (SELECT total_balance FROM wallet_balances),
      'funded_wallet_count', (SELECT funded_wallet_count FROM wallet_balances),
      'current_month_credits', (SELECT COALESCE(SUM(amount), 0) FROM wallet_movements WHERE entry_type = 'credit' AND amount > 0 AND created_at >= date_trunc('month', now())),
      'current_month_debits', (SELECT COALESCE(ABS(SUM(amount)), 0) FROM wallet_movements WHERE entry_type = 'debit' AND amount < 0 AND created_at >= date_trunc('month', now())),
      'net_wallet_funding', (SELECT COALESCE(SUM(amount), 0) FROM wallet_funding)
    ),
    'afa', jsonb_build_object(
      'transaction_count', (SELECT COUNT(*) FROM afa_entries),
      'net_collected', (SELECT COALESCE(SUM(signed_amount), 0) FROM afa_entries),
      'paystack_collected', (SELECT COALESCE(SUM(signed_amount), 0) FROM afa_entries WHERE payment_method = 'paystack'),
      'wallet_spend', (SELECT COALESCE(ABS(SUM(signed_amount)), 0) FROM afa_entries WHERE payment_method = 'wallet' AND entry_type <> 'refund')
    ),
    'sub_agents', COALESCE((
      SELECT jsonb_agg(to_jsonb(agent_row) ORDER BY agent_row.markup_earnings DESC)
      FROM (
        SELECT
          agent_id,
          super_agent_id,
          COALESCE(NULLIF(business_name, ''), NULLIF(full_name, ''), split_part(COALESCE(email, ''), '@', 1), 'Sub-agent') AS name,
          transaction_count,
          gross_sales,
          base_cost,
          markup_earnings,
          markup_recorded,
          provider_cost,
          platform_fees,
          super_agent_revenue
        FROM sub_agent_totals
      ) AS agent_row
    ), '[]'::jsonb),
    'super_agents', COALESCE((
      SELECT jsonb_agg(to_jsonb(super_agent_row) ORDER BY super_agent_row.markup_earnings DESC)
      FROM (
        SELECT
          super_agent_id,
          COALESCE(NULLIF(business_name, ''), NULLIF(full_name, ''), split_part(COALESCE(email, ''), '@', 1), 'Super Agent') AS name,
          transaction_count,
          gross_sales,
          base_cost,
          markup_earnings,
          markup_recorded,
          platform_fees,
          super_agent_revenue
        FROM super_agent_totals
      ) AS super_agent_row
    ), '[]'::jsonb),
    'daily_trend', COALESCE((
      SELECT jsonb_agg(to_jsonb(trend_row) ORDER BY trend_row.day)
      FROM (
        SELECT
          day,
          transaction_count,
          earnings,
          profit,
          markup_earnings,
          gross_sales
        FROM daily_trend
      ) AS trend_row
    ), '[]'::jsonb)
  )
  INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_business_analytics(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calculate_business_analytics(uuid) TO service_role;

COMMIT;
