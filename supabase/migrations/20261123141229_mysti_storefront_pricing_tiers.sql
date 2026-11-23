begin;

create table public.mysti_store_tiers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.mysti_stores(owner_id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 60),
  active boolean not null default true,
  unique (owner_id, id)
);
create unique index mysti_store_tier_name_idx on public.mysti_store_tiers (owner_id, lower(trim(name)));

create table public.mysti_store_tier_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  tier_id uuid not null,
  catalog_key text check (length(catalog_key) between 1 and 200),
  network text not null check (network in ('MTN', 'Telecel', 'AT')),
  bundle text not null check (length(trim(bundle)) between 1 and 60),
  price_pesewas integer not null check (price_pesewas between 1 and 10000000),
  active boolean not null default true,
  foreign key (owner_id, tier_id) references public.mysti_store_tiers(owner_id, id) on delete cascade,
  unique (owner_id, id),
  unique (owner_id, tier_id, catalog_key)
);

alter table public.mysti_store_offers add column tier_item_id uuid;
insert into public.mysti_store_tiers (owner_id, name)
select distinct owner_id, 'Existing prices' from public.mysti_store_offers;
insert into public.mysti_store_tier_items (id, owner_id, tier_id, network, bundle, price_pesewas)
select o.id, o.owner_id, t.id, o.network, o.bundle, o.price_pesewas
from public.mysti_store_offers o
join public.mysti_store_tiers t on t.owner_id = o.owner_id;
update public.mysti_store_offers set tier_item_id = id;

alter table public.mysti_store_offers
  alter column tier_item_id set not null,
  add foreign key (owner_id, tier_item_id) references public.mysti_store_tier_items(owner_id, id),
  add unique (owner_id, tier_item_id),
  drop column network,
  drop column bundle,
  drop column price_pesewas;

alter table public.mysti_store_tiers enable row level security;
alter table public.mysti_store_tier_items enable row level security;
revoke all on public.mysti_store_tiers, public.mysti_store_tier_items from public, anon, authenticated;
grant select, insert on public.mysti_store_tiers, public.mysti_store_tier_items to authenticated;
grant update (name, active) on public.mysti_store_tiers to authenticated;
grant update (price_pesewas, active) on public.mysti_store_tier_items to authenticated;
grant select on public.mysti_store_tiers, public.mysti_store_tier_items to service_role;
grant update (tier_item_id, active) on public.mysti_store_offers to authenticated;

create policy mysti_store_tier_owner on public.mysti_store_tiers
  for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()))
  with check (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()));

create policy mysti_store_tier_item_owner on public.mysti_store_tier_items
  for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()))
  with check (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()));

create view public.mysti_store_catalog_offers with (security_invoker = true) as
select o.id, o.owner_id, o.tier_item_id, o.active, t.name as tier_name,
  i.network, i.bundle, i.price_pesewas, i.active and t.active as tier_available,
  o.active and i.active and t.active as available
from public.mysti_store_offers o
join public.mysti_store_tier_items i on i.id = o.tier_item_id and i.owner_id = o.owner_id
join public.mysti_store_tiers t on t.id = i.tier_id and t.owner_id = i.owner_id;

revoke all on public.mysti_store_catalog_offers from public, anon, authenticated;
grant select on public.mysti_store_catalog_offers to authenticated, service_role;

create or replace function public.mysti_store_checkout(
  p_slug text, p_offer_id uuid, p_price_pesewas integer, p_phone text, p_request_id uuid,
  p_network text, p_bundle text
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  store_owner uuid;
  selected_item public.mysti_store_tier_items%rowtype;
  previous_order public.mysti_store_orders%rowtype;
begin
  if p_phone is null or p_phone !~ '^0[235][0-9]{8}$' then
    return 'invalid_phone';
  end if;

  select s.owner_id into store_owner
    from public.mysti_stores s
    join public.user_profiles p on p.id = s.owner_id
    where s.slug = p_slug and s.published
      and lower(trim(p.role::text)) in ('agent', 'subagent', 'sub_agent', 'superagent', 'super_agent')
    for no key update of s;
  if not found then return 'unavailable'; end if;

  select * into previous_order from public.mysti_store_orders where id = p_request_id;
  if found then
    if previous_order.owner_id = store_owner and previous_order.offer_id = p_offer_id
      and previous_order.phone = p_phone and previous_order.price_pesewas = p_price_pesewas
      and previous_order.network = p_network and previous_order.bundle = p_bundle then
      return 'accepted';
    end if;
    return 'unavailable';
  end if;

  select i.* into selected_item from public.mysti_store_offers o
    join public.mysti_store_tier_items i on i.id = o.tier_item_id and i.owner_id = o.owner_id
    join public.mysti_store_tiers t on t.id = i.tier_id and t.owner_id = i.owner_id
    where o.id = p_offer_id and o.owner_id = store_owner and o.active and i.active and t.active
    for share of o, i, t;
  if not found then return 'unavailable'; end if;
  if selected_item.price_pesewas is distinct from p_price_pesewas then
    return 'price_changed';
  end if;
  if selected_item.network is distinct from p_network or selected_item.bundle is distinct from p_bundle then
    return 'offer_changed';
  end if;

  if (select count(*) from public.mysti_store_orders
      where owner_id = store_owner and created_at > now() - interval '10 minutes') >= 100
    or (select count(*) from public.mysti_store_orders
        where owner_id = store_owner and phone = p_phone and created_at > now() - interval '10 minutes') >= 5 then
    return 'rate_limited';
  end if;

  insert into public.mysti_store_orders (id, owner_id, offer_id, network, bundle, price_pesewas, phone)
  values (p_request_id, store_owner, p_offer_id, selected_item.network,
    selected_item.bundle, selected_item.price_pesewas, p_phone)
  on conflict (id) do nothing;
  if not found then return 'unavailable'; end if;
  return 'accepted';
end;
$$;

-- PostgreSQL requires an UPDATE privilege to lock a source row with FOR SHARE.
grant update (active) on public.mysti_store_tiers, public.mysti_store_tier_items to service_role;

commit;
