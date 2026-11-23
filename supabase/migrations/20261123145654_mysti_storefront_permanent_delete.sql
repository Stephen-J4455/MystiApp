begin;

-- The existing mysti_store_owner policy restricts deletion to the seller
-- who owns the storefront. Store-owned catalog and order rows cascade.
grant delete on public.mysti_stores to authenticated;
revoke update (deleted_at) on public.mysti_stores from authenticated;

commit;
