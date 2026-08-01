import { useCallback, useEffect, useMemo, type MouseEvent } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { marked } from "marked";
import { PageHeader } from "../components/PageHeader";
import { DOCS, findDoc, type DocPage } from "./docs/registry";
import { useViewNavigate } from "../App";

// Renders a single markdown documentation page from /docs/*.md.
//
// `marked` is configured for GFM + line breaks so tables and pipe-delimited
// rows render as expected; the markdown is parsed once via useMemo because
// it never changes after import. We wrap the output in `.markdown-body` so
// the typography/code-block styles are scoped to documentation content
// without leaking into other views.
export function DocView({ slug }: { slug: string }) {
  const doc = findDoc(slug);
  const navigate = useViewNavigate();

  if (!doc) {
    return (
      <PageHeader
        icon={DOCS[0].icon}
        title="Documentation page not found"
        description={`No doc registered for "${slug}".`}
      />
    );
  }

  const html = useMemo(
    () =>
      marked.parse(stripLeadingH1(doc.content), {
        gfm: true,
        breaks: false,
        async: false,
      }) as string,
    [doc.content],
  );

  const { prev, next } = useMemo(() => neighbours(doc), [doc]);

  // Reset scroll when switching between docs. The scrollable element is
  // `.app-main` (the window itself doesn't scroll), so window.scrollTo in
  // useViewNavigate is a no-op here. Watching `slug` covers sidebar clicks,
  // prev/next pager, and inline doc-to-doc links.
  useEffect(() => {
    const main = document.querySelector(".app-main");
    if (main) main.scrollTo({ top: 0, behavior: "auto" });
    else if (typeof window !== "undefined") window.scrollTo(0, 0);
  }, [slug]);

  // Authors write inter-doc links as `/docs/<slug>` (renders fine on
  // GitHub via the markdown rewrite, and is a real URL in the dashboard).
  // Intercept those clicks and turn them into a react-router push so we
  // don't full-page-reload between recipes.
  const onContentClick = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      const target = (e.target as HTMLElement).closest("a");
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href) return;
      // Skip external, anchor, and modified-click navigations.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (target.target === "_blank") return;
      if (href.startsWith("#")) return;
      const match = /^\/docs\/([^/?#]+)/.exec(href);
      if (!match) return;
      e.preventDefault();
      navigate({ kind: "doc", slug: decodeURIComponent(match[1]) });
    },
    [navigate],
  );

  return (
    <>
      <PageHeader icon={doc.icon} title={doc.title} description={doc.description} />

      <article
        className="markdown-body"
        onClick={onContentClick}
        // The markdown source is authored in this repo and shipped as part
        // of the build, so it's trusted; rendering the parsed HTML directly
        // is intentional and avoids the cost of a React markdown renderer.
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <nav className="docs-pager" aria-label="Documentation navigation">
        {prev ? (
          <button
            type="button"
            className="docs-pager-link prev"
            onClick={() => navigate({ kind: "doc", slug: prev.slug })}
          >
            <CaretLeft size={14} weight="regular" />
            <span className="docs-pager-stack">
              <span className="docs-pager-label">Previous</span>
              <span className="docs-pager-title">{prev.title}</span>
            </span>
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button
            type="button"
            className="docs-pager-link next"
            onClick={() => navigate({ kind: "doc", slug: next.slug })}
          >
            <span className="docs-pager-stack right">
              <span className="docs-pager-label">Next</span>
              <span className="docs-pager-title">{next.title}</span>
            </span>
            <CaretRight size={14} weight="regular" />
          </button>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}

// The markdown files start with a `# Title` so they render correctly on
// GitHub, but the dashboard already shows the title in <PageHeader>. Drop
// the first heading (and the blank line after it) before parsing so we
// don't render the title twice.
function stripLeadingH1(content: string): string {
  return content.replace(/^\s*#\s+.*\r?\n+/, "");
}

function neighbours(doc: DocPage): { prev?: DocPage; next?: DocPage } {
  const i = DOCS.findIndex((d) => d.slug === doc.slug);
  return {
    prev: i > 0 ? DOCS[i - 1] : undefined,
    next: i >= 0 && i < DOCS.length - 1 ? DOCS[i + 1] : undefined,
  };
}

// Re-export so callers (sidebar, breadcrumb) can iterate over docs without
// importing from /views/docs/registry directly.
export { DOCS };
