import { Breadcrumbs } from "@cloudflare/kumo/components/breadcrumbs";
import type { ReactNode } from "react";
import type { View } from "../App";

// Wraps Kumo's Breadcrumbs so links navigate via our `navigate(view)` callback
// instead of doing a real page nav (which would lose React state). We encode
// the item index into the href and decode it back on click.
export function AppBreadcrumbs({
  navigate,
  items,
  current,
}: {
  navigate: (v: View) => void;
  items: Array<{ label: ReactNode; view: View }>;
  current: ReactNode;
}) {
  return (
    <div
      onClickCapture={(e) => {
        const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#__nav__']");
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(link.getAttribute("href")?.replace("#__nav__", ""));
        const item = items[idx];
        if (item) navigate(item.view);
      }}
    >
      <Breadcrumbs>
        {items.flatMap((item, idx) => [
          <Breadcrumbs.Link key={`${idx}-link`} href={`#__nav__${idx}`}>
            {item.label}
          </Breadcrumbs.Link>,
          <Breadcrumbs.Separator key={`${idx}-sep`} />,
        ])}
        <Breadcrumbs.Current>{current}</Breadcrumbs.Current>
      </Breadcrumbs>
    </div>
  );
}
