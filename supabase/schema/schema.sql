-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.offers (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  network text,
  title text,
  description text,
  price numeric,
  CONSTRAINT offers_pkey PRIMARY KEY (id)
);
CREATE TABLE public.orders (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  user_id uuid DEFAULT gen_random_uuid(),
  user_name text,
  user_email text,
  phone text,
  offer_title text,
  amount numeric,
  network text,
  status text,
  payment_reference text,
  is_self boolean,
  data_amount text,
  offer_id bigint,
  bank text,
  channel text,
  country_code text,
  paystack_transaction_id text,
  paystack_transaction_status text,
  paid_at timestamp with time zone,
  device_token text,
  CONSTRAINT orders_pkey PRIMARY KEY (id),
  CONSTRAINT orders_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.offers(id)
);
CREATE TABLE public.agent_offers (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  network text,
  title text,
  description text,
  price numeric,
  CONSTRAINT agent_offers_pkey PRIMARY KEY (id)
);
CREATE TABLE public.agent_orders (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  agent_id uuid DEFAULT gen_random_uuid(),
  offer_id bigint,
  offer_title text,
  network text,
  amount numeric,
  recipient_phone text,
  recipient_name text,
  status text,
  transaction_status text,
  channel text,
  device_token text,
  super_agent_id uuid,
  admin_share numeric DEFAULT 0,
  super_agent_share numeric DEFAULT 0,
  agent_net numeric DEFAULT 0,
  settlement_status text NOT NULL DEFAULT 'pending'::text CHECK (settlement_status = ANY (ARRAY['pending'::text, 'settled'::text, 'released'::text, 'failed'::text])),
  CONSTRAINT agent_orders_pkey PRIMARY KEY (id),
  CONSTRAINT agent_orders_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.agent_offers(id),
  CONSTRAINT agent_orders_super_agent_id_fkey FOREIGN KEY (super_agent_id) REFERENCES auth.users(id)
);
CREATE TABLE public.agent_wallet (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  agent_id uuid DEFAULT 'cf772940-e18d-4fd9-bdbf-8ffdcfe05b98'::uuid,
  account_uuid uuid DEFAULT gen_random_uuid(),
  balance numeric,
  CONSTRAINT agent_wallet_pkey PRIMARY KEY (id),
  CONSTRAINT agent_wallet_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES auth.users(id)
);
CREATE TABLE public.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id uuid DEFAULT 'cf772940-e18d-4fd9-bdbf-8ffdcfe05b98'::uuid,
  message text,
  created_at timestamp with time zone DEFAULT now(),
  status text,
  read boolean DEFAULT false,
  title text,
  type text DEFAULT 'notification'::text,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.ads (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  title text NOT NULL,
  description text,
  image_url text,
  action_text text DEFAULT 'Learn More'::text,
  action_url text,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  start_date timestamp with time zone DEFAULT now(),
  end_date timestamp with time zone,
  target_audience text,
  priority integer DEFAULT 1,
  click_count integer DEFAULT 0,
  impression_count integer DEFAULT 0,
  website_url text,
  CONSTRAINT ads_pkey PRIMARY KEY (id)
);
CREATE TABLE public.app_versions (
  id integer NOT NULL DEFAULT nextval('app_versions_id_seq'::regclass),
  platform character varying NOT NULL CHECK (platform::text = ANY (ARRAY['ios'::character varying, 'android'::character varying, 'web'::character varying]::text[])),
  current_version character varying NOT NULL,
  minimum_version character varying,
  is_update_required boolean DEFAULT false,
  update_url text,
  download_url text,
  release_notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT app_versions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.wallet_topups (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  agent_id uuid NOT NULL,
  amount numeric NOT NULL,
  reference text NOT NULL UNIQUE,
  paystack_transaction_id text,
  paystack_transaction_status text,
  paid_at timestamp with time zone,
  channel text,
  bank text,
  status text DEFAULT 'pending'::text,
  CONSTRAINT wallet_topups_pkey PRIMARY KEY (id)
);
CREATE TABLE public.user_push_tokens (
  id integer NOT NULL DEFAULT nextval('user_push_tokens_id_seq'::regclass),
  user_id uuid DEFAULT 'cf772940-e18d-4fd9-bdbf-8ffdcfe05b98'::uuid,
  push_token text NOT NULL,
  platform text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  token_type text DEFAULT 'expo'::text,
  CONSTRAINT user_push_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT user_push_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.admin_push_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT 'cf772940-e18d-4fd9-bdbf-8ffdcfe05b98'::uuid,
  push_token text NOT NULL,
  platform text NOT NULL CHECK (platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  token_type text DEFAULT 'expo'::text,
  CONSTRAINT admin_push_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT admin_push_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.ussd_agents (
  id bigint NOT NULL DEFAULT nextval('ussd_agents_id_seq'::regclass),
  agent_id uuid NOT NULL UNIQUE,
  msisdn text NOT NULL UNIQUE CHECK (msisdn ~ '^\+233[2356789][0-9]{8}$'::text),
  pin_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ussd_agents_pkey PRIMARY KEY (id),
  CONSTRAINT ussd_agents_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES auth.users(id)
);
CREATE TABLE public.super_agent_offers (
  id bigint NOT NULL DEFAULT nextval('super_agent_offers_id_seq'::regclass),
  super_agent_id uuid NOT NULL,
  title text NOT NULL,
  network text NOT NULL,
  data_value text NOT NULL,
  price numeric NOT NULL CHECK (price > 0::numeric),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT super_agent_offers_pkey PRIMARY KEY (id),
  CONSTRAINT super_agent_offers_super_agent_id_fkey FOREIGN KEY (super_agent_id) REFERENCES auth.users(id)
);
CREATE TABLE public.super_agent_assignments (
  id bigint NOT NULL DEFAULT nextval('super_agent_assignments_id_seq'::regclass),
  super_agent_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  offer_id bigint NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  assigned_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT super_agent_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT super_agent_assignments_super_agent_id_fkey FOREIGN KEY (super_agent_id) REFERENCES auth.users(id),
  CONSTRAINT super_agent_assignments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES auth.users(id),
  CONSTRAINT super_agent_assignments_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.super_agent_offers(id)
);
CREATE TABLE public.super_agent_tiers (
  id bigint NOT NULL DEFAULT nextval('super_agent_tiers_id_seq'::regclass),
  super_agent_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT super_agent_tiers_pkey PRIMARY KEY (id),
  CONSTRAINT super_agent_tiers_super_agent_id_fkey FOREIGN KEY (super_agent_id) REFERENCES auth.users(id),
  CONSTRAINT super_agent_tiers_name_unique UNIQUE (super_agent_id, name)
);
CREATE TABLE public.agent_payment_settlements (
  id bigint NOT NULL DEFAULT nextval('agent_payment_settlements_id_seq'::regclass),
  agent_order_id bigint,
  agent_id uuid NOT NULL,
  super_agent_id uuid NOT NULL,
  admin_id uuid,
  gross_amount numeric NOT NULL,
  super_agent_share numeric NOT NULL DEFAULT 0,
  admin_share numeric NOT NULL DEFAULT 0,
  agent_net numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'settled'::text, 'released'::text, 'failed'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agent_payment_settlements_pkey PRIMARY KEY (id),
  CONSTRAINT agent_payment_settlements_agent_order_id_fkey FOREIGN KEY (agent_order_id) REFERENCES public.agent_orders(id),
  CONSTRAINT agent_payment_settlements_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES auth.users(id),
  CONSTRAINT agent_payment_settlements_super_agent_id_fkey FOREIGN KEY (super_agent_id) REFERENCES auth.users(id),
  CONSTRAINT agent_payment_settlements_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id)
);