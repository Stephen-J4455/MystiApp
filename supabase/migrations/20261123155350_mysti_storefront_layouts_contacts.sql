begin;

alter table public.mysti_stores
  drop constraint mysti_stores_template_check,
  add constraint mysti_stores_template_check check (
    template in ('grid', 'list', 'showcase', 'split', 'cover', 'networks', 'sidebar', 'tiles', 'editorial', 'compact')
  ),
  add column image_url text not null default '' check (image_url = '' or (length(image_url) <= 500 and image_url ~ '^https://[^[:space:]]+$')),
  add column whatsapp text not null default '' check (whatsapp = '' or whatsapp ~ '^[1-9][0-9]{7,14}$'),
  add column facebook_url text not null default '' check (facebook_url = '' or (length(facebook_url) <= 500 and facebook_url ~ '^https://[^[:space:]]+$')),
  add column instagram_url text not null default '' check (instagram_url = '' or (length(instagram_url) <= 500 and instagram_url ~ '^https://[^[:space:]]+$')),
  add column tiktok_url text not null default '' check (tiktok_url = '' or (length(tiktok_url) <= 500 and tiktok_url ~ '^https://[^[:space:]]+$')),
  add column telegram_url text not null default '' check (telegram_url = '' or (length(telegram_url) <= 500 and telegram_url ~ '^https://[^[:space:]]+$')),
  add column website_url text not null default '' check (website_url = '' or (length(website_url) <= 500 and website_url ~ '^https://[^[:space:]]+$')),
  add column contact_email text not null default '' check (contact_email = '' or (length(contact_email) <= 254 and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'));

grant update (image_url, whatsapp, facebook_url, instagram_url, tiktok_url, telegram_url, website_url, contact_email)
  on public.mysti_stores to authenticated;

commit;
