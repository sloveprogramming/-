/**
 * Agent 追踪与产物表。
 *
 * Run with:  bun --conditions=react-server scripts/add-agent-trace.ts
 *
 * 改造背景：多角色之后，"一次找客户"会变成多个角色、多次模型调用的组合。
 * 要回答"这次为什么花这么多、哪一步最慢、谁产出了什么"，需要两样东西：
 *
 *   1. `agent_runs.trace_id` —— 把同一次业务动作的所有执行串起来（一棵树）
 *   2. `agent_artifacts`    —— 角色之间真正传递的结构化产物
 *
 * 为什么不在 agent_runs 上存产物：那是"一次执行的输入摘要"，而产物是
 * "交给下游的东西"，一次 trace 有多条且要按顺序回放。混在一起就查不清了。
 *
 * 幂等：ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS，可重复执行。
 */
import { Client } from "pg";

const DDL = `
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trace_id uuid;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS role text;

CREATE INDEX IF NOT EXISTS agent_runs_trace_idx ON agent_runs (trace_id);
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs (parent_run_id);

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_kind_chk;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_chk
  CHECK (kind IN ('classify', 'draft', 'research', 'replan', 'qualify'));

CREATE TABLE IF NOT EXISTS agent_artifacts (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id uuid NOT NULL,
  role text NOT NULL,
  kind text NOT NULL,
  seq integer NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_artifacts_trace_idx ON agent_artifacts (organization_id, trace_id, seq);
CREATE INDEX IF NOT EXISTS agent_artifacts_kind_idx ON agent_artifacts (kind);
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

    const { rows: columns } = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_runs'
        AND column_name IN ('trace_id', 'parent_run_id', 'role')
      ORDER BY column_name
    `);
    console.log("agent_runs 新增列：");
    console.table(columns);

    const { rows: artifacts } = await client.query(`
      SELECT
        (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agent_artifacts')::int AS columns,
        (SELECT count(*) FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'agent_artifacts')::int AS indexes
    `);
    console.log("agent_artifacts：");
    console.table(artifacts);

    if ((artifacts[0]?.columns ?? 0) < 8) {
      throw new Error("agent_artifacts 列数不足，建表可能失败");
    }
    console.log("完成。");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
