-- Tables the Firecrawl API needs for browser sessions and interact when it
-- runs self-hosted (USE_DB_AUTHENTICATION=false, DATABASE_URL set).
-- Mirrors apps/api/src/db/schema/public.ts; team_id is text because the
-- self-hosted team id is "bypass", not a UUID. Idempotent.

CREATE TABLE IF NOT EXISTS public.browser_sessions (
  id uuid NOT NULL PRIMARY KEY,
  zero_data_retention boolean NOT NULL DEFAULT false,
  team_id text NOT NULL,
  request_id uuid,
  should_bill boolean NOT NULL DEFAULT true,
  browser_id text NOT NULL,
  workspace_id text NOT NULL,
  context_id text NOT NULL,
  cdp_url text NOT NULL,
  cdp_path text NOT NULL,
  stream_web_view boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  ttl_total integer NOT NULL,
  ttl_without_activity integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  credits_used integer,
  cdp_interactive_path text,
  scrape_id uuid,
  profile_name text
);
CREATE INDEX IF NOT EXISTS browser_sessions_team_status_idx ON public.browser_sessions (team_id, status);
CREATE INDEX IF NOT EXISTS browser_sessions_scrape_idx ON public.browser_sessions (scrape_id);
CREATE INDEX IF NOT EXISTS browser_sessions_browser_idx ON public.browser_sessions (browser_id);

CREATE TABLE IF NOT EXISTS public.browser_profiles (
  team_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  saved_at timestamptz NOT NULL,
  size_bytes bigint,
  PRIMARY KEY (team_id, name)
);

CREATE TABLE IF NOT EXISTS public.browser_session_activities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id text NOT NULL,
  session_id text NOT NULL,
  language text NOT NULL,
  timeout integer NOT NULL,
  exit_code integer,
  killed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text DEFAULT 'browser'
);
