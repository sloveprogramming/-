import * as Badge from "@/components/alignui/badge";

/**
 * A status label with a dot for table cells ("已连接", "异常"). The
 * status is spelled out in the text; colour is reinforcement, not the message.
 *
 * Props: `status` "good" | "warning" | "critical" | "info" | "neutral", `children` the label.
 */
const COLOR = { good: "green", warning: "yellow", critical: "red", info: "blue", neutral: "gray" } as const;

export function StatusDotBadge({ status, children }: { status: keyof typeof COLOR; children: React.ReactNode }) {
  return (
    <Badge.Root variant="lighter" color={COLOR[status]} size="medium">
      <Badge.Dot />
      {children}
    </Badge.Root>
  );
}
