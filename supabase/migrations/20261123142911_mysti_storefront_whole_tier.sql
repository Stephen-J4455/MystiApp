begin;

alter table public.mysti_stores
  add column selected_tier_id uuid,
  add column selected_super_tier_id bigint,
  add foreign key (owner_id, selected_tier_id) references public.mysti_store_tiers(owner_id, id),
  add check (selected_tier_id is null or selected_super_tier_id is null);

grant update (selected_tier_id, selected_super_tier_id) on public.mysti_stores to authenticated;

-- Use the same owner-safe tier list in the app, website and selection validation.
create view public.mysti_store_tier_choices with (security_barrier = true) as
select t.owner_id, t.id::text as tier_key, t.name
from public.mysti_store_tiers t
join public.user_profiles p on p.id = t.owner_id
where t.active and lower(trim(p.role::text)) in ('agent', 'subagent', 'sub_agent')
  and (current_user = 'service_role' or t.owner_id = (select auth.uid()))
union all
select t.super_agent_id, 'super:' || t.id::text, t.name
from public.super_agent_tiers t
join public.user_profiles p on p.id = t.super_agent_id
where t.is_active and lower(trim(p.role::text)) in ('super_agent', 'superagent')
  and (current_user = 'service_role' or t.super_agent_id = (select auth.uid()));

revoke all on public.mysti_store_tier_choices from public, anon, authenticated;
grant select on public.mysti_store_tier_choices to authenticated, service_role;

create function public.mysti_store_validate_selected_tier()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  selected_key text := coalesce(new.selected_tier_id::text, 'super:' || new.selected_super_tier_id::text);
begin
  if selected_key is not null and not exists (
    select 1 from public.mysti_store_tier_choices
    where owner_id = new.owner_id and tier_key = selected_key
  ) then
    raise exception 'Select an active tier that belongs to this storefront' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.mysti_store_validate_selected_tier() from public, anon, authenticated;
create trigger mysti_store_validate_selected_tier
before insert or update of selected_tier_id, selected_super_tier_id on public.mysti_stores
for each row execute function public.mysti_store_validate_selected_tier();

-- Whole-tier bundles are calculated at read time. Their UUIDs identify the
-- source bundle in this store even when its current price changes.
create view public.mysti_store_published_bundles with (security_invoker = true) as
select o.id, o.owner_id, o.network, o.bundle, o.price_pesewas
from public.mysti_store_catalog_offers o
join public.mysti_stores s on s.owner_id = o.owner_id
where s.selected_tier_id is null and s.selected_super_tier_id is null and o.available
union all
select md5('mysti-store-tier:' || s.owner_id::text || ':' || i.id::text)::uuid,
  s.owner_id, i.network, i.bundle, i.price_pesewas
from public.mysti_stores s
join public.mysti_store_tiers t on t.owner_id = s.owner_id and t.id = s.selected_tier_id
join public.mysti_store_tier_items i on i.owner_id = t.owner_id and i.tier_id = t.id
where t.active and i.active
union all
select md5('mysti-store-super-tier:' || s.owner_id::text || ':' || b.tier_id::text || ':' || b.offer_id::text)::uuid,
  s.owner_id, b.network, b.bundle, b.price_pesewas
from public.mysti_stores s
join public.mysti_store_super_tier_bundles b on b.owner_id = s.owner_id and b.tier_id = s.selected_super_tier_id;

revoke all on public.mysti_store_published_bundles from public, anon, authenticated;
grant select on public.mysti_store_published_bundles to service_role;

-- Order details are already snapshotted. Their bundle reference may now come
-- from a live tier and can outlive the selected tier or bundle.
alter table public.mysti_store_orders drop constraint mysti_store_orders_offer_id_fkey;

create or replace function public.mysti_store_checkout(
  p_slug text, p_offer_id uuid, p_price_pesewas integer, p_phone text, p_request_id uuid,
  p_network text, p_bundle text
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  store_owner uuid;
  selected_item public.mysti_store_published_bundles%rowtype;
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

  select * into selected_item from public.mysti_store_published_bundles
    where id = p_offer_id and owner_id = store_owner;
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

commit;
