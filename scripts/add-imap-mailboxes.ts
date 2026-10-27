/**
 * 企业邮收信（IMAP）：给 outreach_mailboxes 加收信字段。
 *
 * Run with:  bun --conditions=react-server scripts/add-imap-mailboxes.ts
 *
 * 上一轮做了 SMTP 发信，这一轮补收信。企业邮箱的收信是 IMAP 轮询（没有 Gmail
 * 那种 Pub/Sub 推送），游标用递增的 UID 而不是 historyId。
 *
 * 幂等：DDL 都带 IF NOT EXISTS，约束用 DO 块判断。
 */
import { Client } from "pg";

const DDL = `
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_host text;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_port integer;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_secure boolean NOT NULL DEFAULT true;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_user text;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS imap_secret_encrypted text;
ALTER TABLE outreach_mailboxes ADD COLUMN IF NOT EXISTS last_imap_uid integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_mailboxes_imap_port_chk') THEN
    ALTER TABLE outreach_mailboxes
      ADD CONSTRAINT outreach_mailboxes_imap_port_chk
      CHECK (imap_port IS NULL OR (imap_port > 0 AND imap_port <= 65535));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_mailboxes_imap_uid_chk') THEN
    ALTER TABLE outreach_mailboxes
      ADD CONSTRAINT outreach_mailboxes_imap_uid_chk
      CHECK (last_imap_uid IS NULL OR last_imap_uid >= 0);
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
      `SELECT email_address, provider, imap_host, imap_port, last_imap_uid
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
