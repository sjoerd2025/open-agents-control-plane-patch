import { useCallback, useEffect, useState } from "react";
import { Key, ArrowsClockwise, Trash } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { api, type SecretItem } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { relTime } from "../utils";
import { useToasts } from "../toasts";

export function SecretsView() {
  const { push } = useToasts();
  const [items, setItems] = useState<SecretItem[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSecrets();
      setItems(data.items);
    } catch (err) {
      push((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!name.trim() || !value) {
      push("Both name and value are required", "error");
      return;
    }
    try {
      await api.putSecret(name.trim(), value);
      push(`Saved secret: ${name} - this may take a moment to propagate`);
      setName("");
      setValue("");
      load();
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  const remove = async (key: string) => {
    if (!confirm(`Delete secret "${key}"?`)) return;
    try {
      await api.deleteSecret(key);
      push(`Deleted secret: ${key}`);
      load();
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  return (
    <>
      <PageHeader
        icon={Key}
        title="Secrets"
        description="Name/value pairs your sandboxes can use to securely access external services. Reference them from an Egress Policy to safely inject auth headers on outbound requests — secret values are never seen by the agent."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={ArrowsClockwise}
            onClick={load}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      <Section title="New Secret">
        <div className="row-2">
          <Input
            label="Name"
            placeholder="API_KEY"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="Value"
            type="password"
            placeholder="secret value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="actions">
          <Button variant="primary" size="sm" onClick={save}>
            Save Secret
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setName("");
              setValue("");
            }}
          >
            Clear
          </Button>
        </div>
      </Section>

      <Section title="Stored Secrets">
        {items.length === 0 ? (
          <div className="empty-state">No secrets yet.</div>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.key}>
                  <td className="mono">{s.key}</td>
                  <td
                    className="muted"
                    style={{ fontSize: "0.75rem" }}
                    title={
                      s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""
                    }
                  >
                    {s.updatedAt ? relTime(s.updatedAt) : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Button
                      variant="secondary-destructive"
                      size="sm"
                      icon={Trash}
                      onClick={() => remove(s.key)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
