#!/bin/sh
# Create the role the platform connects as, on the database's first start.
#
# The official PostgreSQL image makes POSTGRES_USER a superuser, and a superuser
# is exempt from every row-level security policy — FORCE ROW LEVEL SECURITY does
# not change that (IMPLEMENTATION_PLAN.md §4c). A deployment that connected as it
# would have no tenant isolation at all while appearing to work perfectly, so the
# services refuse to start as one. This script creates the role they *should*
# use: NOSUPERUSER NOBYPASSRLS, owning the database, which is fine precisely
# because every tenant-scoped table forces its policies on the owner too.
#
# Values arrive as psql variables and are quoted by psql (:'name'), never
# interpolated into SQL by the shell, so a password containing a quote cannot
# change the statement.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname postgres \
  -v app_user="$DATABASE_USER" \
  -v app_password="$DATABASE_PASSWORD" \
  -v app_database="$DATABASE_NAME" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE :"app_database" OWNER :"app_user";
SQL
