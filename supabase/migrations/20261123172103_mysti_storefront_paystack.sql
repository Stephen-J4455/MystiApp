begin;

alter table public.mysti_store_orders
  drop constraint mysti_store_orders_status_check,
  add constraint mysti_store_orders_status_check check (
    status in ('pending', 'fulfilled', 'declined', 'awaiting_payment', 'dispatching',
      'sent_to_provider', 'provider_review', 'test_paid')
  ),
  add column provider_order_id text,
  add column payment_updated_at timestamptz;

-- Keep the payment record independent of storefront deletion. Paystack may
-- report success after a seller has taken the storefront offline or deleted it.
create table public.mysti_store_payments (
  order_id uuid primary key,
  reference text not null unique,
  slug text not null,
  email text not null,
  phone text not null,
  amount integer not null check (amount > 0),
  is_test boolean not null,
  package jsonb not null,
  authorization_url text,
  transaction_id text,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'dispatching', 'sent_to_provider', 'provider_review', 'test_paid')),
  provider_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index mysti_store_payment_transaction_idx
  on public.mysti_store_payments (is_test, transaction_id) where transaction_id is not null;

alter table public.mysti_store_payments enable row level security;
revoke all on public.mysti_store_payments from public, anon, authenticated;
grant select, insert, update on public.mysti_store_payments to service_role;

-- Resolve the provider link for the exact bundle shown on the public page.
create view public.mysti_store_payment_catalog with (security_invoker = true) as
with source as (
  select o.id, o.owner_id, o.tier_item_id, o.super_offer_id
    from public.mysti_store_offers o
    join public.mysti_stores s on s.owner_id = o.owner_id
    where s.selected_tier_id is null and s.selected_super_tier_id is null
  union all
  select md5('mysti-store-tier:' || s.owner_id::text || ':' || i.id::text)::uuid,
    s.owner_id, i.id, null::bigint
    from public.mysti_stores s join public.mysti_store_tier_items i
      on i.owner_id = s.owner_id and i.tier_id = s.selected_tier_id
  union all
  select md5('mysti-store-super-tier:' || s.owner_id::text || ':' || b.tier_id::text || ':' || b.offer_id::text)::uuid,
    s.owner_id, null::uuid, b.offer_id
    from public.mysti_stores s join public.mysti_store_super_tier_bundles b
      on b.owner_id = s.owner_id and b.tier_id = s.selected_super_tier_id
)
select s.slug, b.id, b.network, b.bundle, b.price_pesewas, i.catalog_key, o.provider, o.data_value
from public.mysti_store_published_bundles b
join source on source.id = b.id and source.owner_id = b.owner_id
join public.mysti_stores s on s.owner_id = b.owner_id and s.published
left join public.mysti_store_tier_items i on i.id = source.tier_item_id and i.owner_id = b.owner_id
left join public.super_agent_offers o on o.id = source.super_offer_id and o.super_agent_id = b.owner_id;

revoke all on public.mysti_store_payment_catalog from public, anon, authenticated;
grant select on public.mysti_store_payment_catalog, public.super_agent_offers to service_role;

-- Keep price validation, rate limiting and payment reservation in one
-- transaction. The storefront row lock also serializes concurrent checkout.
create function public.mysti_store_reserve_payment(
  p_slug text, p_offer_id uuid, p_price integer, p_phone text, p_request_id uuid,
  p_network text, p_bundle text, p_email text, p_reference text, p_is_test boolean, p_package jsonb
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  store_owner uuid;
  selected_item public.mysti_store_published_bundles%rowtype;
  payment public.mysti_store_payments%rowtype;
begin
  if p_phone is null or p_phone !~ '^0[235][0-9]{8}$' then return 'invalid_phone'; end if;

  select s.owner_id into store_owner from public.mysti_stores s
    join public.user_profiles p on p.id = s.owner_id
    where s.slug = p_slug and s.published
      and lower(trim(p.role::text)) in ('agent', 'subagent', 'sub_agent', 'superagent', 'super_agent')
    for no key update of s;
  if not found then return 'unavailable'; end if;

  select * into payment from public.mysti_store_payments where order_id = p_request_id;
  if found then
    if payment.reference = p_reference and payment.email = p_email
      and exists (select 1 from public.mysti_store_orders
        where id = p_request_id and owner_id = store_owner and offer_id = p_offer_id
          and network = p_network and bundle = p_bundle and price_pesewas = p_price and phone = p_phone)
    then return 'accepted'; end if;
    return 'unavailable';
  end if;

  select * into selected_item from public.mysti_store_published_bundles
    where id = p_offer_id and owner_id = store_owner;
  if not found then return 'unavailable'; end if;
  if selected_item.price_pesewas is distinct from p_price then return 'price_changed'; end if;
  if selected_item.network is distinct from p_network or selected_item.bundle is distinct from p_bundle
    then return 'offer_changed'; end if;

  if (select count(*) from public.mysti_store_orders
      where owner_id = store_owner and created_at > now() - interval '10 minutes') >= 100
    or (select count(*) from public.mysti_store_orders
      where owner_id = store_owner and phone = p_phone and created_at > now() - interval '10 minutes') >= 5
    then return 'rate_limited'; end if;

  insert into public.mysti_store_orders (id, owner_id, offer_id, network, bundle, price_pesewas, phone, status, payment_updated_at)
    values (p_request_id, store_owner, p_offer_id, p_network, p_bundle, p_price, p_phone, 'awaiting_payment', now())
    on conflict (id) do nothing;
  if not found then return 'unavailable'; end if;

  insert into public.mysti_store_payments (order_id, reference, slug, email, phone, amount, is_test, package)
  values (p_request_id, p_reference, p_slug, p_email, p_phone, p_price, p_is_test, p_package);
  return 'accepted';
end;
$$;

-- Claim a verified transaction before contacting the provider. Neither a
-- webhook replay nor a simultaneous browser callback can claim it again.
create function public.mysti_store_claim_payment(p_reference text, p_transaction_id text)
returns setof public.mysti_store_payments
language plpgsql security invoker set search_path = ''
as $$
declare
  claimed public.mysti_store_payments%rowtype;
begin
  update public.mysti_store_payments
    set status = case when is_test then 'test_paid' else 'dispatching' end,
        transaction_id = p_transaction_id, updated_at = now()
    where reference = p_reference and status = 'awaiting_payment'
    returning * into claimed;
  if not found then return; end if;
  update public.mysti_store_orders set status = claimed.status, payment_updated_at = now() where id = claimed.order_id;
  return next claimed;
end;
$$;

create function public.mysti_store_finish_payment(p_reference text, p_provider_order_id text)
returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  order_uuid uuid;
  final_status text := case when p_provider_order_id is null then 'provider_review' else 'sent_to_provider' end;
begin
  update public.mysti_store_payments
    set status = final_status, provider_order_id = p_provider_order_id, updated_at = now()
    where reference = p_reference and status = 'dispatching'
    returning order_id into order_uuid;
  if not found then return 'provider_review'; end if;
  update public.mysti_store_orders set status = final_status, provider_order_id = p_provider_order_id, payment_updated_at = now()
    where id = order_uuid;
  return final_status;
end;
$$;

revoke all on function public.mysti_store_reserve_payment(text, uuid, integer, text, uuid, text, text, text, text, boolean, jsonb),
  public.mysti_store_claim_payment(text, text), public.mysti_store_finish_payment(text, text)
  from public, anon, authenticated;
grant execute on function public.mysti_store_reserve_payment(text, uuid, integer, text, uuid, text, text, text, text, boolean, jsonb),
  public.mysti_store_claim_payment(text, text), public.mysti_store_finish_payment(text, text)
  to service_role;
revoke execute on function public.mysti_store_checkout(text, uuid, integer, text, uuid, text, text) from service_role;

commit;
