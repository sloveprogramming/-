/**
 * Agent 观测表：agent_runs / agent_events。
 *
 * Run with:  bun --conditions=react-server scripts/create-agent-tables.ts
 *
 * 改造背景：一次回复从"一次模型调用"变成"多轮 + 若干工具调用"。要回答
 * "改造后是不是更好了"，先得有运行记录。这两张表就是那把尺子。
 *
 * 幂等：DDL 都带 IF NOT EXISTS。
 */
import { Client } from "pg";

const DDL = `
CREATE TABLE IF NOT EXISTS agent_runs (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  subject_type text,
  subject_id uuid,
  model text,
  steps integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  tool_calls integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT agent_runs_kind_chk CHECK (kind IN ('classify', 'draft', 'research')),
  CONSTRAINT agent_runs_status_chk CHECK (status IN ('running', 'completed', 'failed', 'aborted'))
);

CREATE INDEX IF NOT EXISTS agent_runs_org_started_idx ON agent_runs (organization_id, started_at);
CREATE INDEX IF NOT EXISTS agent_runs_subject_idx ON agent_runs (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS agent_events (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  type text NOT NULL,
  tool text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  ok boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_events_type_chk CHECK (type IN ('llm_call', 'tool_call', 'tool_result', 'error', 'finish'))
);

CREATE INDEX IF NOT EXISTS agent_events_run_seq_idx ON agent_events (run_id, seq);
`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '2min'");
    await client.query("BEGIN");
    await client.query(DDL);
    await client.query("COMMIT");

    const { rows } = await client.query(`
      SELECT table_name,
             (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public')::int AS columns
      FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_name IN ('agent_runs', 'agent_events')
      ORDER BY table_name
    `);
    console.table(rows);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
