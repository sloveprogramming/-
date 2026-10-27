import { cn } from "@/utils/cn";
import { brandDisplayClass } from "./font";
import { Mascot } from "./Mascot";
import type { MascotCycle } from "./mascotFrames";

/**
 * The AgentSDR logo — the one source for the app chrome and the login
 * screen. The mascot's pixels live in ./mascotFrames.ts; the favicon
 * (src/app/icon.svg, apple-icon.png) and the recorder extension's icons are
 * this same tile drawn as static files; change them together.
 */

/** The icon tile's corner radius. */
export const ICON_RADIUS = "14%";

/** How a logo's mascot moves: a walk cycle, looping or only while its `.group` is hovered. */
export type Walk = { walk?: MascotCycle; walkOn?: "always" | "hover" };

/**
 * Shade, the mascot, on a glass app tile. `small` trims the glow for header
 * and footer sizes, where the headline's halo would read as a blur. `walk`
 * animates it (see Mascot); without it the tile is the still logo.
 */
export function AppIcon({ className, small = false, walk, walkOn = "always" }: { className?: string; small?: boolean } & Walk) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-b from-[#5b7bff] to-[#1f3bad]",
        small
          ? "shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_0_0_1px_rgb(255_255_255/0.18),0_2px_8px_-2px_rgb(51_92_255/0.55)]"
          : "shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_0_0_1px_rgb(255_255_255/0.18),0_8px_24px_-6px_rgb(51_92_255/0.8)]",
        className,
      )}
      // A square tile with gently rounded corners, not an app-store squircle.
      style={{ borderRadius: ICON_RADIUS }}
    >
      {/* Soft grid on the icon face, like a glass app tile. */}
      <span className="absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.08)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.08)_1px,transparent_1px)] bg-[size:25%_25%]" />
      <Mascot cycle={walk} play={walkOn} className="relative size-[62%] text-white drop-shadow-[0_1px_1px_rgb(11_10_26/0.35)]" />
    </span>
  );
}

/** The mascot alone, standing, in currentColor: the mark without its tile. */
export function AgentMark({ className }: { className?: string }) {
  return <Mascot className={className} />;
}

/**
 * Tile and name together. The name takes the surrounding text colour, so
 * it follows the theme; pass a colour in `className` on fixed backgrounds.
 */
export function Logo({
  className,
  iconClassName = "size-7",
  textClassName = "text-[19px]",
  walk,
  walkOn,
}: {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
} & Walk) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <AppIcon small className={iconClassName} walk={walk} walkOn={walkOn} />
      <span className={cn(brandDisplayClass, "leading-none tracking-[-0.01em]", textClassName)}>新农哥</span>
    </span>
  );
}
