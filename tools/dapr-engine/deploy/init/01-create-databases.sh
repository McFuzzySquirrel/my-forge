#!/bin/sh
set -eu

: "${DAPR_DB_PASSWORD:?DAPR_DB_PASSWORD is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --set dapr_password="$DAPR_DB_PASSWORD" \
  --set app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE myforge_dapr LOGIN PASSWORD :'dapr_password';
CREATE ROLE myforge_app LOGIN PASSWORD :'app_password';
CREATE DATABASE myforge_dapr OWNER myforge_dapr;
CREATE DATABASE myforge_app OWNER myforge_app;
SQL
