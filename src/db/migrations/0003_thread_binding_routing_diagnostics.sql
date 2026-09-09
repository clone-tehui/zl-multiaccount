alter table thread_bindings
  add column if not exists last_routing_action text,
  add column if not exists last_routing_reason text,
  add column if not exists last_routing_context_json jsonb not null default '{}'::jsonb;
