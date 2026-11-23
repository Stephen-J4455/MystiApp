begin;

alter table public.mysti_stores
  add column template text not null default 'grid'
    check (template in ('grid', 'list', 'showcase')),
  add column theme text not null default 'light'
    check (theme in ('light', 'dark')),
  add column accent_color text not null default '#4933BC'
    check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  add column store_icon text not null default 'store'
    check (store_icon in ('store', 'signal', 'bolt', 'globe', 'star', 'gem')),
  add column welcome_text text not null default ''
    check (char_length(welcome_text) <= 180);

grant update (template, theme, accent_color, store_icon, welcome_text)
  on public.mysti_stores to authenticated;

commit;
