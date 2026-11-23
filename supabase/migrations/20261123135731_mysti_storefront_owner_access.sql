begin;

create function public.mysti_store_is_seller()
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles
    where id = (select auth.uid())
      and lower(trim(role::text)) in ('agent', 'subagent', 'sub_agent', 'superagent', 'super_agent')
  );
$$;

revoke all on function public.mysti_store_is_seller() from public, anon, authenticated;
grant execute on function public.mysti_store_is_seller() to authenticated;

grant select, insert on public.mysti_stores, public.mysti_store_offers to authenticated;
grant update (name, slug, published) on public.mysti_stores to authenticated;
grant update (network, bundle, price_pesewas, active) on public.mysti_store_offers to authenticated;
grant select on public.mysti_store_orders to authenticated;
grant update (status) on public.mysti_store_orders to authenticated;

create policy mysti_store_owner on public.mysti_stores
  for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()))
  with check (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()));

create policy mysti_store_offer_owner on public.mysti_store_offers
  for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()))
  with check (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()));

create policy mysti_store_order_read on public.mysti_store_orders
  for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()));

create policy mysti_store_order_resolve on public.mysti_store_orders
  for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()) and status = 'pending')
  with check (owner_id = (select auth.uid()) and (select public.mysti_store_is_seller()) and status in ('fulfilled', 'declined'));

commit;
