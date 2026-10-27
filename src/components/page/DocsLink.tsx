import type { ReactNode } from "react";
import { RiBookOpenLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { docsPageUrl, type DocsPage } from "@/lib/support";
import { cn } from "@/utils/cn";

/**
 * "How to connect": a link to our own docs, opening in a new tab, put beside
 * every prompt that asks someone to connect an integration or an account.
 * `button` (default) is a secondary button for beside a Connect button;
 * `inline` is a text link for a sentence or a callout. Pass `page` for one of
 * DOCS_PAGES, or `href` for a URL that already is one (a catalog `guideUrl`).
 */
export function DocsLink({
  page,
  href,
  children = "如何连接",
  appearance = "button",
  size = "small",
  className,
}: ({ page: DocsPage; href?: never } | { href: string; page?: never }) & {
  children?: ReactNode;
  appearance?: "button" | "inline";
  /** The button's size, to match the button beside it. */
  size?: "xsmall" | "small";
  className?: string;
}) {
  const url = page ? docsPageUrl(page) : href;
  if (appearance === "inline") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn("inline-flex items-center gap-1 font-medium text-primary-base underline-offset-2 hover:underline", className)}
      >
        <RiBookOpenLine className="size-3.5 shrink-0" aria-hidden="true" />
        {children}
      </a>
    );
  }
  return (
    <Button.Root asChild variant="neutral" mode="stroke" size={size} className={className}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        <Button.Icon as={RiBookOpenLine} />
        {children}
      </a>
    </Button.Root>
  );
}
