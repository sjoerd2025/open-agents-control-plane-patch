// Registry of documentation pages.
//
// The actual markdown lives at <repo-root>/docs/*.md so the same files
// render on GitHub and in the dashboard. Vite's `?raw` query inlines the
// markdown source into the bundle at build time; at dev-server time it's
// fetched on demand. `import.meta.glob` keeps each doc in its own chunk.
//
// To add a new doc: drop a new .md file in /docs and add an entry below.
// The order here drives the sidebar order and the prev/next navigation
// at the bottom of each page.
import type { Icon } from "@phosphor-icons/react";
import {
  Info,
  TreeStructure,
  Cube,
  ShieldCheck,
  Network,
  Lego,
  LockKey,
  Package,
  Archive,
  Browser,
  EnvelopeSimple,
} from "@phosphor-icons/react";

import about from "../../../../docs/about.md?raw";
import isolateVsVm from "../../../../docs/isolate-vs-vm-sandboxes.md?raw";
import customizingSandboxes from "../../../../docs/customizing-sandboxes.md?raw";
import architecture from "../../../../docs/architecture.md?raw";
import applyingEgress from "../../../../docs/applying-egress-policies.md?raw";
import connectingPrivate from "../../../../docs/connecting-to-private-services.md?raw";
import browserRenderingTools from "../../../../docs/browser-rendering-tools.md?raw";
import agentEmail from "../../../../docs/agent-email.md?raw";
import addingTools from "../../../../docs/adding-custom-tools.md?raw";
import snapshots from "../../../../docs/snapshots-and-state-persistence.md?raw";
import securingAccess from "../../../../docs/securing-access.md?raw";

export interface DocPage {
  slug: string;
  // Full page title — rendered in the page header.
  title: string;
  // Short label for the sidebar. The sidebar column is narrow (especially
  // when the user resizes their viewport), so we keep these to ~2 words
  // each to avoid mid-word truncation.
  sidebarTitle: string;
  description: string;
  icon: Icon;
  content: string;
}

export const DOCS: DocPage[] = [
  {
    slug: "about",
    title: "About",
    sidebarTitle: "About",
    description: "How and why to run Claude Managed Agents on Cloudflare.",
    icon: Info,
    content: about,
  },
  {
    slug: "isolate-vs-vm-sandboxes",
    title: "Isolate vs VM-based Sandboxes",
    sidebarTitle: "Isolate vs VM",
    description:
      "When to pick a Workers Isolate workspace vs a MicroVM container — and what each gets you.",
    icon: Cube,
    content: isolateVsVm,
  },
  {
    slug: "customizing-sandboxes",
    title: "Customizing Sandboxes",
    sidebarTitle: "Customize Sandbox",
    description:
      "Bake tools into the MicroVM image and pick an instance size that fits the workload.",
    icon: Package,
    content: customizingSandboxes,
  },
  {
    slug: "architecture",
    title: "Architecture",
    sidebarTitle: "Architecture",
    description:
      "How the Claude Managed Agents, Cloudflare Workers, Sandboxes, and tools all fit together.",
    icon: TreeStructure,
    content: architecture,
  },
  {
    slug: "applying-egress-policies",
    title: "Applying Egress Policies",
    sidebarTitle: "Egress Policies",
    description:
      "Lock down outbound traffic per session with allow/deny rules and dynamic Worker proxies.",
    icon: ShieldCheck,
    content: applyingEgress,
  },
  {
    slug: "connecting-to-private-services",
    title: "Connecting to Private Services",
    sidebarTitle: "Private Services",
    description:
      "Reach VPC services, private databases, and internal APIs from inside an agent session.",
    icon: Network,
    content: connectingPrivate,
  },
  {
    slug: "browser-rendering-tools",
    title: "Browser Rendering Tools",
    sidebarTitle: "Browser Tools",
    description:
      "Drive a real Chrome from your agent — fetch JS-heavy pages, take screenshots, run CDP scripts.",
    icon: Browser,
    content: browserRenderingTools,
  },
  {
    slug: "agent-email",
    title: "Agent Email",
    sidebarTitle: "Agent Email",
    description:
      "Provision a per-agent inbox and let the agent send and read mail through Cloudflare Email Routing.",
    icon: EnvelopeSimple,
    content: agentEmail,
  },
  {
    slug: "adding-custom-tools",
    title: "Adding Custom Tools",
    sidebarTitle: "Custom Tools",
    description:
      "Extend the agent with your own tools using Cloudflare bindings and the Sandbox SDK.",
    icon: Lego,
    content: addingTools,
  },
  {
    slug: "snapshots-and-state-persistence",
    title: "Snapshots & state persistence",
    sidebarTitle: "Snapshots",
    description:
      "How MicroVM sessions back /workspace up to R2 on hibernation and restore it on the next dispatch.",
    icon: Archive,
    content: snapshots,
  },
  {
    slug: "securing-access",
    title: "Securing Access",
    sidebarTitle: "Securing Access",
    description:
      "Put Cloudflare Access in front of the dashboard and constrain who can launch sessions.",
    icon: LockKey,
    content: securingAccess,
  },
];

export function findDoc(slug: string): DocPage | undefined {
  return DOCS.find((d) => d.slug === slug);
}
