create table media_files (
 id uuid primary key, created_at timestamp with time zone not null, revision bigint not null,
 organization_id uuid not null references organizations(id), uploaded_by uuid references accounts(id),
 content_type varchar(255), byte_size bigint not null
);
create index idx_media_org on media_files(organization_id);
