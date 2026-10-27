/**
 * The brand's display face.
 *
 * This used to be Geist from `next/font/google`. The app now ships a Chinese
 * UI, and a Google-hosted webfont is both the wrong face for Chinese and
 * unreachable from mainland China at build time, so the face is defined once
 * as `--font-landing-display` in `app/globals.css` and this module only names
 * the class that points at it.
 */
export const brandDisplayClass = "font-[family-name:var(--font-landing-display)] font-medium";
