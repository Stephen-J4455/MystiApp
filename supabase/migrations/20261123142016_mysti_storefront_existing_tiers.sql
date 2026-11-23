begin;

-- Expose only the calling super agent's prices. The storefront server can read
-- any owner's rows and filters by the storefront's owner before serving them.
create view public.mysti_store_super_tier_bundles with (security_barrier = true) as
select t.super_agent_id as owner_id, t.id as tier_id, t.name as tier_name,
  o.id as offer_id, n.network, trim(o.data_value) as bundle,
  round(case when o.uses_admin_base_price then base.base_price else o.price end * 100)::integer as price_pesewas
from public.super_agent_tiers t
join public.super_agent_offers o
  on o.super_agent_id = t.super_agent_id and coalesce(nullif(trim(o.tier_name), ''), nullif(trim(o.default_tier_name), '')) = t.name
join public.user_profiles p on p.id = t.super_agent_id
cross join lateral (
  select case regexp_replace(upper(o.network), '[^A-Z]', '', 'g')
    when 'MTN' then 'MTN'
    when 'TELECEL' then 'Telecel'
    when 'VOD' then 'Telecel'
    when 'VODAFONE' then 'Telecel'
    when 'AT' then 'AT'
    when 'AIRTELTIGO' then 'AT'
  end as network
) n
left join lateral (
  select pp.base_price
  from public.package_pricing pp
  cross join lateral (select
    upper(trim(pp.type)) as kind,
    trim_scale(pp.size)::text || 'GB' as size_label
  ) d
  where o.uses_admin_base_price and pp.is_active and pp.provider = o.provider
    and case regexp_replace(upper(pp.network), '[^A-Z]', '', 'g')
      when 'VOD' then 'TELECEL' when 'VODAFONE' then 'TELECEL'
      when 'AIRTELTIGO' then 'AT' else regexp_replace(upper(pp.network), '[^A-Z]', '', 'g') end = upper(n.network)
    and (upper(trim(o.data_value)) in (
      upper(trim(pp.package_id)), d.kind, d.kind || ' - ' || d.size_label, d.kind || ' (' || d.size_label || ')'
    ))
  order by case when upper(trim(o.data_value)) = upper(trim(pp.package_id)) then 0
    when pp.size is not null and upper(trim(o.data_value)) <> d.kind then 1 else 2 end,
    pp.id
  limit 1
) base on true
where t.is_active and o.is_active and n.network is not null
  and length(trim(o.data_value)) between 1 and 60
  and round(case when o.uses_admin_base_price then base.base_price else o.price end * 100) between 1 and 10000000
  and lower(trim(p.role::text)) in ('super_agent', 'superagent')
  and (current_user = 'service_role' or t.super_agent_id = (select auth.uid()));

revoke all on public.mysti_store_super_tier_bundles from public, anon, authenticated;
grant select on public.mysti_store_super_tier_bundles to authenticated, service_role;

alter table public.mysti_store_offers
  alter column tier_item_id drop not null,
  add column super_tier_id bigint,
  add column super_offer_id bigint,
  add check (
    (tier_item_id is not null and super_tier_id is null and super_offer_id is null)
    or (tier_item_id is null and super_tier_id is not null and super_offer_id is not null)
  ),
  add unique (owner_id, super_tier_id, super_offer_id);

grant update (super_tier_id, super_offer_id) on public.mysti_store_offers to authenticated;

-- Keep withdrawn source references so sellers can see and relink old offers.
-- Require a matching, current source when an authenticated caller links one.
create policy mysti_store_offer_source_insert on public.mysti_store_offers
  as restrictive for insert to authenticated
  with check (super_offer_id is null or exists (
    select 1 from public.mysti_store_super_tier_bundles b
    where b.owner_id = mysti_store_offers.owner_id
      and b.tier_id = mysti_store_offers.super_tier_id and b.offer_id = mysti_store_offers.super_offer_id
  ));
create policy mysti_store_offer_source_update on public.mysti_store_offers
  as restrictive for update to authenticated
  with check (not active or super_offer_id is null or exists (
    select 1 from public.mysti_store_super_tier_bundles b
    where b.owner_id = mysti_store_offers.owner_id
      and b.tier_id = mysti_store_offers.super_tier_id and b.offer_id = mysti_store_offers.super_offer_id
  ));

create or replace view public.mysti_store_catalog_offers with (security_invoker = true) as
select o.id, o.owner_id, o.tier_item_id, o.active, coalesce(t.name, b.tier_name) as tier_name,
  coalesce(i.network, b.network) as network, coalesce(i.bundle, b.bundle) as bundle,
  coalesce(i.price_pesewas, b.price_pesewas) as price_pesewas,
  coalesce(i.active and t.active, b.offer_id is not null) as tier_available,
  o.active and coalesce(i.active and t.active, b.offer_id is not null) as available,
  o.super_tier_id, o.super_offer_id
from public.mysti_store_offers o
left join public.mysti_store_tier_items i on i.id = o.tier_item_id and i.owner_id = o.owner_id
left join public.mysti_store_tiers t on t.id = i.tier_id and t.owner_id = i.owner_id
left join public.mysti_store_super_tier_bundles b
  on b.owner_id = o.owner_id and b.tier_id = o.super_tier_id and b.offer_id = o.super_offer_id;

create or replace function public.mysti_store_checkout(
  p_slug text, p_offer_id uuid, p_price_pesewas integer, p_phone text, p_request_id uuid,
  p_network text, p_bundle text
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  store_owner uuid;
  selected_item public.mysti_store_catalog_offers%rowtype;
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

  perform 1 from public.mysti_store_offers
    where id = p_offer_id and owner_id = store_owner and active for share;
  if not found then return 'unavailable'; end if;
  select * into selected_item from public.mysti_store_catalog_offers
    where id = p_offer_id and owner_id = store_owner and available;
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
