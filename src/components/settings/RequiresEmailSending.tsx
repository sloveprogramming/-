import Link from "next/link";
import type { ReactNode } from "react";
import { RiMailAddLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { EmptyState } from "@/components/page/EmptyState";
import { requirePageOrgContext } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { mailboxes } from "@/lib/outreach/schema";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";

/**
 * 邮件版块（活动、收件箱）的入口条件。
 *
 * 改造：原来这里写死 `RequiresPlatform platform="google"`——整个邮件版块等
 * Google Workspace。国内部署用的是企业邮箱 SMTP（自带凭据），所以现在的条件是
 * 「有一个 SMTP 邮箱」**或**「Google Workspace 已连接」，两者满足其一即可。
 *
 * 都不满足时给的是"添加发信邮箱"，而不是"去连 Google"——后者在国内是死路。
 */
export async function RequiresEmailSending({ children, className }: { children: ReactNode; className?: string }) {
  const ctx = await requirePageOrgContext();
  const ready = await runInOrganization(ctx.organizationId, async () => {
    const [smtpMailbox] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(inOrg(mailboxes))
      .limit(1);
    if (smtpMailbox) return true;
    return isPlatformConnected("google");
  });
  if (ready) return <>{children}</>;

  const prompt = (
    <Frame className="mx-auto max-w-2xl">
      <FramePanel>
        <EmptyState
          icon={RiMailAddLine}
          title="先添加一个发信邮箱"
          description="添加企业邮箱（腾讯企业邮 / 阿里云 / 网易企业邮）之后，这里就能建外发活动、收发客户回复。"
          action={
            <Button.Root asChild variant="primary" mode="filled" size="small">
              <Link href="/settings/email-accounts">去添加发信邮箱</Link>
            </Button.Root>
          }
        />
      </FramePanel>
    </Frame>
  );
  return className ? <div className={className}>{prompt}</div> : prompt;
}
