CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL DEFAULT gen_random_uuid(),
  source_id INTEGER REFERENCES sources(id),
  external_id TEXT,                    -- ID from source system (Jira key, Trello card ID, etc.)
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open, in_progress, done, closed, archived
  priority TEXT,                       -- low, medium, high, critical
  assignee TEXT,
  reporter TEXT,
  project TEXT,                        -- project/board name
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_date DATE,
  completed_at TIMESTAMPTZ,
  external_url TEXT,                   -- link back to source
  parent_task_id UUID,                 -- for subtasks (references tasks.record_id)
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_record_active ON tasks(record_id) WHERE effective_to IS NULL AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(source_id, external_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

CREATE OR REPLACE VIEW current_tasks AS
  SELECT * FROM tasks WHERE effective_to IS NULL AND is_active = TRUE;
