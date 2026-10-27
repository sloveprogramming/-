import { cn } from "@/utils/cn";

/**
 * 企业标识：用公司域名的首字母做一个小色块。
 *
 * 原来这里是从 callingShared 拿的 favicon 组件，会去请求对方站点的 favicon.ico；
 * 那个模块随 WhatsApp 拨号一起删了。改成纯字标有两个好处：不发外部请求（国内
 * 访问境外站点经常超时，一屏几十行会拖慢列表），离线也能显示。
 */
export function CompanyFavicon({ domain, className }: { domain: string; className?: string }) {
  const letter = (domain.replace(/^https?:\/\//, "").replace(/^www\./, "")[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded bg-bg-weak-50 text-[10px] font-medium text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200",
        className,
      )}
    >
      {letter}
    </span>
  );
}
