-- Portal + Omnichannel CRM foundation
-- Safe scope: only schema design / no infra mutation

create table if not exists roles (
  id bigserial primary key,
  code text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id bigserial primary key,
  username text not null unique,
  password_hash text not null,
  display_name text not null,
  email text,
  phone text,
  status text not null default 'offline' check (status in ('online','offline','busy')),
  last_active_at timestamptz,
  last_assigned_at timestamptz,
  force_offline_until timestamptz,
  session_version integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_roles (
  user_id bigint not null references users(id) on delete cascade,
  role_id bigint not null references roles(id) on delete cascade,
  primary key (user_id, role_id)
);

create table if not exists departments (
  id bigserial primary key,
  code text not null unique,
  name text not null,
  description text,
  manager_user_id bigint references users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_departments (
  user_id bigint not null references users(id) on delete cascade,
  department_id bigint not null references departments(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, department_id)
);

create table if not exists channels (
  id bigserial primary key,
  code text not null unique,
  name text not null,
  channel_type text not null check (channel_type in ('zalo_personal','zalo_oa','facebook_page')),
  department_id bigint references departments(id) on delete set null,
  bot_status text not null default 'disabled' check (bot_status in ('enabled','disabled')),
  routing_mode text not null default 'least_connections' check (routing_mode in ('least_connections','round_robin','manual')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists channel_credentials (
  id bigserial primary key,
  channel_id bigint not null references channels(id) on delete cascade,
  secret_ref text not null,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists channel_members (
  channel_id bigint not null references channels(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  can_handle boolean not null default true,
  priority_weight integer not null default 100,
  max_open_conversations integer not null default 20,
  primary key (channel_id, user_id)
);

create table if not exists contacts (
  id bigserial primary key,
  channel_id bigint not null references channels(id) on delete cascade,
  external_contact_id text not null,
  display_name text,
  avatar_url text,
  phone text,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_contact_id)
);

create table if not exists conversations (
  id bigserial primary key,
  channel_id bigint not null references channels(id) on delete cascade,
  contact_id bigint references contacts(id) on delete set null,
  external_thread_id text not null,
  status text not null default 'pending' check (status in ('bot_handling','open','pending','closed')),
  priority text not null default 'normal' check (priority in ('vip','complaint','hot_lead','normal')),
  assigned_user_id bigint references users(id) on delete set null,
  department_id bigint references departments(id) on delete set null,
  first_response_at timestamptz,
  last_message_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_thread_id)
);

create table if not exists messages (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  sender_type text not null,
  sender_user_id bigint references users(id) on delete set null,
  external_message_id text,
  message_type text not null,
  text_content text,
  payload_json jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists message_attachments (
  id bigserial primary key,
  message_id bigint not null references messages(id) on delete cascade,
  kind text not null,
  url text,
  preview_url text,
  mime_type text,
  name text,
  size_bytes bigint,
  meta_json jsonb not null default '{}'::jsonb
);

create table if not exists tags (
  id bigserial primary key,
  department_id bigint references departments(id) on delete cascade,
  name text not null,
  color text,
  unique (department_id, name)
);

create table if not exists conversation_tags (
  conversation_id bigint not null references conversations(id) on delete cascade,
  tag_id bigint not null references tags(id) on delete cascade,
  primary key (conversation_id, tag_id)
);

create table if not exists conversation_notes (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  author_user_id bigint not null references users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists conversation_transfers (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  from_user_id bigint references users(id) on delete set null,
  to_user_id bigint references users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists routing_queue (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  department_id bigint not null references departments(id) on delete cascade,
  priority integer not null default 100,
  status text not null default 'pending' check (status in ('pending','assigned','expired')),
  queued_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  session_token_hash text not null,
  ip text,
  user_agent text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists portal_settings (
  key text primary key,
  value_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists thread_bindings (
  thread_id text primary key,
  department_id bigint references departments(id) on delete set null,
  channel_id bigint references channels(id) on delete set null,
  assigned_user_id bigint references users(id) on delete set null,
  queue_status text not null default 'pending' check (queue_status in ('pending','open','closed')),
  priority text not null default 'normal' check (priority in ('vip','complaint','hot_lead','normal')),
  sla_first_response_due_at timestamptz,
  sla_next_response_due_at timestamptz,
  last_routing_action text,
  last_routing_reason text,
  last_routing_context_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id bigserial primary key,
  actor_user_id bigint references users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists portal_event_journal (
  id text primary key,
  actor_user_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  department_id text,
  payload_json jsonb not null default '{}'::jsonb,
  source text not null default 'portal',
  created_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

insert into roles (code, name, description)
values
  ('admin', 'Admin', 'Toàn quyền hệ thống'),
  ('manager', 'Manager', 'Quản lý theo bộ phận'),
  ('staff', 'Staff', 'Nhân viên xử lý hội thoại')
on conflict (code) do nothing;

create index if not exists idx_users_status on users(status, last_active_at);
create index if not exists idx_channels_department on channels(department_id, channel_type);
create index if not exists idx_conversations_assignee on conversations(assigned_user_id, status, last_message_at desc);
create index if not exists idx_conversations_department_queue on conversations(department_id, status, priority, last_message_at desc);
create index if not exists idx_messages_conversation on messages(conversation_id, created_at desc);
create index if not exists idx_routing_queue_department on routing_queue(department_id, status, priority, queued_at);
create index if not exists idx_thread_bindings_assigned on thread_bindings(assigned_user_id, queue_status, updated_at desc);
create index if not exists idx_thread_bindings_department on thread_bindings(department_id, queue_status, updated_at desc);
create index if not exists idx_portal_event_journal_created_at on portal_event_journal(created_at desc);
create index if not exists idx_portal_event_journal_department on portal_event_journal(department_id, created_at desc);
