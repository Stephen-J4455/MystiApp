begin;

create table public.mysti_stores (
  owner_id uuid primary key references public.user_profiles(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 48),
  name text not null check (length(trim(name)) between 2 and 80),
  published boolean not null default false
);

create table public.mysti_store_offers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.mysti_stores(owner_id) on delete cascade,
  network text not null check (network in ('MTN', 'Telecel', 'AT')),
  bundle text not null check (length(trim(bundle)) between 1 and 60),
  price_pesewas integer not null check (price_pesewas between 1 and 10000000),
  active boolean not null default true
);
create index mysti_store_offers_owner_idx on public.mysti_store_offers(owner_id);

create table public.mysti_store_orders (
  id uuid primary key,
  owner_id uuid not null references public.mysti_stores(owner_id) on delete cascade,
  offer_id uuid not null references public.mysti_store_offers(id) on delete cascade,
  network text not null,
  bundle text not null,
  price_pesewas integer not null,
  phone text not null check (phone ~ '^0[235][0-9]{8}$'),
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'declined')),
  created_at timestamptz not null default now()
);
create index mysti_store_orders_owner_created_idx on public.mysti_store_orders(owner_id, created_at desc);

alter table public.mysti_stores enable row level security;
alter table public.mysti_store_offers enable row level security;
alter table public.mysti_store_orders enable row level security;
revoke all on public.mysti_stores, public.mysti_store_offers, public.mysti_store_orders from public, anon, authenticated;
grant select, insert, update on public.mysti_stores, public.mysti_store_offers, public.mysti_store_orders to service_role;
grant select on public.user_profiles to service_role;

create function public.mysti_store_checkout(
  p_slug text, p_offer_id uuid, p_price_pesewas integer, p_phone text, p_request_id uuid,
  p_network text, p_bundle text
) returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  store_owner uuid;
  selected_offer public.mysti_store_offers%rowtype;
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

  select * into selected_offer from public.mysti_store_offers
    where id = p_offer_id and owner_id = store_owner and active
    for share;
  if not found then return 'unavailable'; end if;
  if selected_offer.price_pesewas is distinct from p_price_pesewas then
    return 'price_changed';
  end if;
  if selected_offer.network is distinct from p_network or selected_offer.bundle is distinct from p_bundle then
    return 'offer_changed';
  end if;

  if (select count(*) from public.mysti_store_orders
      where owner_id = store_owner and created_at > now() - interval '10 minutes') >= 100
    or (select count(*) from public.mysti_store_orders
        where owner_id = store_owner and phone = p_phone and created_at > now() - interval '10 minutes') >= 5 then
    return 'rate_limited';
  end if;

  insert into public.mysti_store_orders (id, owner_id, offer_id, network, bundle, price_pesewas, phone)
  values (p_request_id, store_owner, selected_offer.id, selected_offer.network,
    selected_offer.bundle, selected_offer.price_pesewas, p_phone)
  on conflict (id) do nothing;
  if not found then return 'unavailable'; end if;
  return 'accepted';
end;
$$;

revoke all on function public.mysti_store_checkout(text, uuid, integer, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.mysti_store_checkout(text, uuid, integer, text, uuid, text, text) to service_role;

commit;
