/**
 * 企业邮箱 SMTP：给 outreach_mailboxes 加发信通道字段。
 *
 * Run with:  bun --conditions=react-server scripts/add-smtp-mailboxes.ts
 *
 * 改造背景：原来连邮箱只需要报一个地址（Google Workspace 服务账号域委派），
 * 没有密码。国内没有这条路，所以每个邮箱要能自己带 SMTP 主机、端口、账号、
 * 密码。密码用 INTEGRATION_CREDENTIALS_KEY 加密后存 smtp_secret_encrypted。
 *
 * 幂等：所有 DDL 都带 IF NOT EXISTS，约束用 DO 块判断，可重复执行。
 */
import { Client } from "pg";

const DDL = `
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'gmail';
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_host text;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_port integer;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_secure boolean NOT NULL DEFAULT true;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_user text;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS smtp_secret_encrypted text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_mailboxes_provider_chk') THEN
    ALTER TABLE outreach_mailboxes
      ADD CONSTRAINT outreach_mailboxes_provider_chk
      CHECK (provider IN ('gmail', 'smtp'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_mailboxes_smtp_port_chk') THEN
    ALTER TABLE outreach_mailboxes
      ADD CONSTRAINT outreach_mailboxes_smtp_port_chk
      CHECK (smtp_port IS NULL OR (smtp_port > 0 AND smtp_port <= 65535));
  END IF;
END $$;

-- SMTP 邮箱必须配齐连接信息；已有行都是 gmail，所以 NOT VALID 不会挡住迁移。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_mailboxes_smtp_complete_chk') THEN
    ALTER TABLE outreach_mailboxes
      ADD CONSTRAINT outreach_mailboxes_smtp_complete_chk
      CHECK (
        provider <> 'smtp'
        OR (smtp_host IS NOT NULL AND smtp_port IS NOT NULL AND smtp_user IS NOT NULL AND smtp_secret_encrypted IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
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

    const { rows } = await client.query(
      `SELECT email_address, provider, smtp_host, smtp_port, smtp_secure
         FROM outreach_mailboxes ORDER BY created_at`,
    );
    console.table(rows);
    console.log(`outreach_mailboxes 现有 ${rows.length} 个邮箱`);
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
