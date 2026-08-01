import { forwardRef, type ReactElement } from "react";
import { type Icon, IconBase, type IconWeight } from "@phosphor-icons/react";

// Containers icon used by the Cloudflare dashboard. Ported from the stratus
// repo (apps/dash/.../WorkersObservability/icons/ContainersIcon). Original SVG
// is 512×512; Phosphor uses a 256×256 viewBox so we scale by 0.5.
const weights = new Map<IconWeight, ReactElement>([
  [
    "regular",
    <g transform="scale(0.5)" key="containers-icon">
      <path
        d="M448 341.37V170.61A32 32 0 0 0 432.11 143l-152-88.46a47.94 47.94 0 0 0-48.24 0L79.89 143A32 32 0 0 0 64 170.61v170.76A32 32 0 0 0 79.89 369l152 88.46a48 48 0 0 0 48.24 0l152-88.46A32 32 0 0 0 448 341.37"
        stroke="currentColor"
        strokeWidth="32"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="m69 153.99 187 110 187-110m-187 310v-200"
        stroke="currentColor"
        strokeWidth="32"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </g>,
  ],
]);

export const ContainersIcon: Icon = forwardRef((props, ref) => (
  <IconBase ref={ref} {...props} weights={weights} />
));

ContainersIcon.displayName = "ContainersIcon";
