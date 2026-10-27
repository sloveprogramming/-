import { RequiresEmailSending } from "@/components/settings/RequiresEmailSending";

/**
 * 邮件版块（活动、收件箱、备注、任务）。
 *
 * 改造：入口条件从「Google Workspace 已连接」换成「有一个发信邮箱或 Google
 * 已连接」，见 RequiresEmailSending。每个页面自带内边距，这里只给提示卡加边距。
 */

// Reads the database (is a sending mailbox available?), so the segment renders per request.
export const dynamic = "force-dynamic";

export default function OutreachLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequiresEmailSending className="h-full overflow-auto bg-bg-white-0 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      {children}
    </RequiresEmailSending>
  );
}
