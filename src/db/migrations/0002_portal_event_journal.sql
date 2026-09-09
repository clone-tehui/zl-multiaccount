create table if not exists portal_event_journal (
  id text primary key,
  actor_user_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  department_id text,
  payload_json jsonb not null default '{}'::jsonb,
  source text not null default 'portal',
  created_at timestamptz not null default now(),
  recorded_at timestamptz not null default now()
);

create index if not exists idx_portal_event_journal_created_at on portal_event_journal(created_at desc);
create index if not exists idx_portal_event_journal_action on portal_event_journal(action, created_at desc);
create index if not exists idx_portal_event_journal_department on portal_event_journal(department_id, created_at desc);
