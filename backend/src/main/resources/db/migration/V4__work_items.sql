create table work_items (
  id uuid primary key,
  created_at timestamp with time zone not null,
  revision bigint not null,
  organization_id uuid not null references organizations(id),
  workflow_id uuid not null,
  module_id varchar(255) not null,
  name text not null,
  notes text not null,
  updated_at timestamp with time zone not null,
  unique(workflow_id, module_id),
  foreign key(workflow_id, organization_id) references sops(id, organization_id)
);
create index idx_work_items_org on work_items(organization_id);
create index idx_work_items_workflow on work_items(workflow_id);
