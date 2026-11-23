begin;

alter table public.mysti_stores
  add column deleted_at timestamptz,
  add constraint mysti_deleted_store_unpublished check (deleted_at is null or not published);

-- The existing owner and seller-role policies also protect this column.
grant update (deleted_at) on public.mysti_stores to authenticated;

commit;
