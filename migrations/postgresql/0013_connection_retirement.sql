create table connection_retirements (
  service text not null,
  connection_name text not null,
  generation text not null,
  primary key (service, connection_name)
);

-- Existing pending authorizations have no disconnect fence. Require fresh consent.
delete from oauth_states;
alter table oauth_states add column service text;
alter table oauth_states add column connection_name text;
create index oauth_states_connection on oauth_states (service, connection_name);
