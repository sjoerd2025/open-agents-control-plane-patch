import { useEffect, useState } from "react";
import { ChatCircleText } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { AppBreadcrumbs } from "../components/AppBreadcrumbs";
import { api, type AnthropicAgent } from "../api";
import { randomSessionTitle, modelId } from "../utils";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import type { View } from "../App";
import { useToasts } from "../toasts";

export function SessionFormView({ navigate }: { navigate: (v: View) => void }) {
  const { push } = useToasts();
  const [agents, setAgents] = useState<AnthropicAgent[]>([]);
  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState(randomSessionTitle());

  useEffect(() => {
    api
      .agents()
      .then((data) => {
        setAgents(data.data || []);
        if (data.data && data.data.length > 0) setAgentId(data.data[0].id);
      })
      .catch((err: Error) => push(err.message, "error"));
  }, [push]);

  const create = async () => {
    if (!agentId) {
      push("Select an agent", "error");
      return;
    }
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    try {
      const s = await api.createSession({
        agent: { type: "agent", id: agent.id, version: agent.version },
        title: title.trim() || `${agent.name} – ${new Date().toLocaleString()}`,
      });
      push(`Session created: ${s.id}`);
      navigate({ kind: "session-detail", sessionId: s.id });
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  return (
    <>
      <AppBreadcrumbs
        navigate={navigate}
        items={[{ label: "Sessions", view: { kind: "sessions" } }]}
        current="New"
      />

      <PageHeader
        icon={ChatCircleText}
        title="New Session"
        description="Spin up a new Claude Managed Agent session."
      />

      <Section>
        <div className="field-stack">
          <Select
            label="Agent"
            value={agentId}
            onValueChange={(v) => setAgentId(v as string)}
            renderValue={(v) => {
              const a = agents.find((a) => a.id === v);
              return a ? `${a.name} (${modelId(a.model)})` : (v as string);
            }}
          >
            {agents.map((a) => (
              <Select.Option key={a.id} value={a.id}>
                {a.name} ({modelId(a.model)})
              </Select.Option>
            ))}
          </Select>
          <Input
            label="Title"
            placeholder="My Session"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="actions">
            <Button variant="primary" onClick={create}>
              Create Session
            </Button>
            <Button
              variant="ghost"
              onClick={() => navigate({ kind: "sessions" })}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
