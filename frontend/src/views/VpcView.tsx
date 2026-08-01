import { useEffect, useState } from "react";
import { Network, ArrowSquareOut, BookOpenText } from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Button } from "@cloudflare/kumo/components/button";
import { LinkButton } from "@cloudflare/kumo/components/button";
import { CodeBlock } from "@cloudflare/kumo/components/code";
import { api, type VpcBinding } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { useToasts } from "../toasts";

const DOCS_URL = "https://developers.cloudflare.com/workers-vpc/";

const EXAMPLE_WRANGLER = `// wrangler.jsonc
{
  // Declare the binding(s) — that's the whole config.
  // https://developers.cloudflare.com/workers-vpc/configuration/
  //
  // The dashboard discovers them via scripts/sync-vpc-bindings.mjs,
  // which runs automatically on \`npm run build\`.
  "vpc_networks": [
    { "binding": "MESH", "network_id": "cf1:network", "remote": true }
  ],
  "vpc_services": [
    { "binding": "INTERNAL_API", "service_id": "00000000-..." }
  ]
}`;

export function VpcView() {
  const { push } = useToasts();
  const [items, setItems] = useState<VpcBinding[] | null>(null);
  const [docsUrl, setDocsUrl] = useState<string>(DOCS_URL);

  useEffect(() => {
    api
      .vpc()
      .then((res) => {
        setItems(res.items);
        if (res.docsUrl) setDocsUrl(res.docsUrl);
      })
      .catch((err: Error) => {
        push(err.message, "error");
        setItems([]);
      });
  }, [push]);

  return (
    <>
      <PageHeader
        icon={Network}
        title="VPC + Mesh"
        description={
          <>
            Bindings to Cloudflare Tunnels and Mesh declared in your
            <code style={{ marginLeft: 6 }}>wrangler.jsonc</code>. Once
            configured, egress policies and tools can route traffic to them.
          </>
        }
        actions={
          <LinkButton
            variant="secondary"
            size="sm"
            icon={ArrowSquareOut}
            href={docsUrl}
            external
          >
            Documentation
          </LinkButton>
        }
      />

      {items === null ? (
        <Section>
          <div className="empty-state">Loading...</div>
        </Section>
      ) : items.length === 0 ? (
        <Section>
          <Empty
            icon={<Network size={48} weight="duotone" />}
            title="No VPC bindings configured"
            description="Connect this Worker to private services on Cloudflare Tunnel or Cloudflare Mesh by declaring vpc_networks or vpc_services in wrangler.jsonc. Run `npm run vpc:sync` (or any build) and the dashboard picks them up."
            contents={
              <div style={{ display: "flex", gap: 8 }}>
                <LinkButton
                  variant="primary"
                  icon={BookOpenText}
                  href={docsUrl}
                  external
                >
                  Read the Workers VPC docs
                </LinkButton>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(EXAMPLE_WRANGLER);
                    push("Copied wrangler.jsonc snippet to clipboard");
                  }}
                >
                  Copy example config
                </Button>
              </div>
            }
          />
          <div style={{ marginTop: "1rem" }}>
            <p
              className="muted"
              style={{ fontSize: "0.8125rem", marginBottom: "0.5rem" }}
            >
              Example configuration:
            </p>
            <CodeBlock code={EXAMPLE_WRANGLER} lang="jsonc" />
          </div>
        </Section>
      ) : (
        <Section
          title="Bindings"
          description="Each binding maps to an env property on the Worker"
        >
          <table className="kv-table">
            <thead>
              <tr>
                <th>Binding</th>
                <th>Type</th>
                <th>ID</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.binding}>
                  <td className="mono">
                    <strong>{b.binding}</strong>
                  </td>
                  <td>
                    <Badge variant={b.type === "network" ? "info" : "warning"}>
                      {b.type}
                    </Badge>
                  </td>
                  <td className="mono" style={{ fontSize: "0.75rem" }}>
                    {b.id}
                  </td>
                  <td className="muted">{b.description || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}
