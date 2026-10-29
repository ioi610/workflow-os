create table personal_installation (
    id integer primary key check (id = 1),
    owner_user_id uuid references accounts(id),
    default_organization_id uuid references organizations(id),
    revision bigint not null,
    check ((owner_user_id is null and default_organization_id is null)
        or (owner_user_id is not null and default_organization_id is not null))
);

-- A pre-existing row lets every first bootstrap lock the same database record.
insert into personal_installation (id, revision) values (1, 0);
