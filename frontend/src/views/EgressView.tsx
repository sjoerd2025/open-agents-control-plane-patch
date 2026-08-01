import { useCallback, useEffect, useId, useState } from "react";
import { ShieldCheck, Plus, Trash, BookOpenText } from "@phosphor-icons/react";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Empty } from "@cloudflare/kumo/components/empty";
import {
  api,
  type AnthropicAgent,
  type EgressPolicy,
  type EgressRule,
  type ApplyToMatcher,
  type SecretItem,
  type VpcBinding,
} from "../api";
import { newPolicyId } from "../utils";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/Section";
import { MultiPillInput } from "../components/MultiPillInput";
import { useToasts } from "../toasts";

// Canonical matcher we write when the user picks an agent from the
// "Apply to agent" dropdown on the policy form. The resolver injects
// `agent_id` into the matcher fields from the local sessions row, so
// this round-trips through the same code path as any other matcher.
const AGENT_MATCH_FIELD = "agent_id";

// Detect a policy that scopes itself to exactly one agent via the
// canonical matcher shape. Returns the agent id when the pattern fits,
// otherwise null. Used to round-trip the "Apply to agent…" picker
// across reloads.
function detectLinkedAgentId(policy: EgressPolicy): string | null {
  if (policy.appliesToAll) return null;
  if (policy.applyTo.length !== 1) return null;
  const [m] = policy.applyTo;
  if (m.field !== AGENT_MATCH_FIELD) return null;
  if (m.operator !== "equals") return null;
  if (!m.value) return null;
  return m.value;
}

const PROXY_TEMPLATE = `// This function is loaded into a Dynamic Worker and runs on every outbound
// request from the sandbox. It must export a default fetch handler.
//
// Read more: https://developers.cloudflare.com/dynamic-workers/
export default {
  async fetch(request, env, ctx) {
    console.log("[egress proxy]", request.method, request.url);
    return fetch(request);
  },
};`;

const RULE_BADGE: Record<
  EgressRule["type"],
  "success" | "error" | "info" | "warning" | "secondary"
> = {
  allow: "success",
  deny: "error",
  "header-injection": "info",
  proxy: "warning",
  "vpc-service": "secondary",
};

const RULE_LABEL: Record<EgressRule["type"], string> = {
  allow: "Allow",
  deny: "Deny",
  "header-injection": "Header injection",
  proxy: "Proxy function",
  "vpc-service": "VPC service",
};

// Pill labels shown on the index row to summarise what's in a policy. We use
// a friendlier wording than the rule-card labels because this is the
// at-a-glance view, not the editor.
const RULE_PILL_LABEL: Record<EgressRule["type"], string> = {
  allow: "Allow list",
  deny: "Deny list",
  "header-injection": "Secret injection",
  proxy: "Proxy function",
  "vpc-service": "VPC",
};

const HOST_PATTERN_HELP =
  "Hostnames, wildcards (*.example.com), or IPs — separated by Enter or comma";

// A blank matcher row. Used as the default when a policy has no `applyTo`
// entries so the form always shows at least one (un-removable) matcher.
function emptyMatcher(): ApplyToMatcher {
  return { field: "", operator: "equals", value: "" };
}

const DOC_LINKS = {
  outbound:
    "https://developers.cloudflare.com/sandbox/guides/outbound-traffic/",
  dynamicWorkers: "https://developers.cloudflare.com/dynamic-workers/",
  workersVpc: "https://developers.cloudflare.com/workers-vpc/",
};

export function EgressView() {
  const { push } = useToasts();
  const [policies, setPolicies] = useState<EgressPolicy[]>([]);
  const [editing, setEditing] = useState<EgressPolicy | null>(null);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [vpc, setVpc] = useState<VpcBinding[]>([]);
  const [dataFields, setDataFields] = useState<string[]>([]);
  const [agents, setAgents] = useState<AnthropicAgent[]>([]);

  // We fetch policies + secrets + VPC bindings + data fields + agents
  // together but each is independent — a transient failure in one (e.g.
  // /api/vpc when VPC isn't bound) shouldn't drop a fresh policies list
  // on the floor. `allSettled` keeps each section best-effort. Agents
  // power the "Apply to agent…" picker on the form.
  const load = useCallback(async () => {
    const [p, s, v, f, a] = await Promise.allSettled([
      api.listPolicies(),
      api.listSecrets(),
      api.vpc(),
      api.policyDataFields(),
      api.agents(),
    ]);
    if (p.status === "fulfilled") setPolicies(p.value.items);
    else push((p.reason as Error).message, "error");
    if (s.status === "fulfilled") setSecrets(s.value.items);
    if (v.status === "fulfilled") setVpc(v.value.items);
    if (f.status === "fulfilled") setDataFields(f.value.items);
    if (a.status === "fulfilled") setAgents(a.value.data || []);
  }, [push]);

  useEffect(() => {
    load();
  }, [load]);

  const newPolicy = () => {
    const now = new Date().toISOString();
    setEditing({
      id: newPolicyId(),
      name: "",
      egressRules: [],
      // A new policy starts with one empty matcher in the form. The user
      // can either fill it in or flip "Apply to every sandbox" to clear it.
      applyTo: [emptyMatcher()],
      appliesToAll: false,
      createdAt: now,
      updatedAt: now,
    });
  };

  // When the user clicks an existing policy that has no `applyTo` entries
  // (legacy data, or a policy flagged `appliesToAll`), surface one empty
  // matcher so the form never renders an empty Applies-to section if the
  // user toggles `appliesToAll` off.
  const startEditing = (policy: EgressPolicy) => {
    setEditing({
      ...policy,
      applyTo: policy.applyTo.length > 0 ? policy.applyTo : [emptyMatcher()],
    });
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      push("Policy name is required", "error");
      return;
    }
    // The backend rejects policies that combine `appliesToAll` with
    // `applyTo` matchers, so clear the matchers when the catch-all is on.
    // Also normalise the legacy `sessionIds` array to empty since the UI
    // no longer surfaces it.
    const payload: EgressPolicy = {
      ...editing,
      name: editing.name.trim(),
      applyTo: editing.appliesToAll ? [] : editing.applyTo,
      sessionIds: [],
      updatedAt: new Date().toISOString(),
    };
    try {
      const saved = await api.savePolicy(payload);
      // Merge the server response straight into local state so the index
      // reflects the update synchronously — no dependency on a follow-up
      // refetch succeeding (or even running before the next render).
      setPolicies((cur) => {
        const idx = cur.findIndex((p) => p.id === saved.id);
        if (idx === -1) return [...cur, saved];
        const next = cur.slice();
        next[idx] = saved;
        return next;
      });
      push(`Saved policy: ${editing.name}`);
      setEditing(null);
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this policy?")) return;
    try {
      await api.deletePolicy(id);
      setPolicies((cur) => cur.filter((p) => p.id !== id));
      push("Deleted policy");
    } catch (err) {
      push((err as Error).message, "error");
    }
  };

  if (editing) {
    return (
      <PolicyForm
        draft={editing}
        secrets={secrets}
        vpc={vpc}
        dataFields={dataFields}
        agents={agents}
        onChange={setEditing}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    );
  }

  // Look up agents linked to a policy for the index. Keyed by id so the
  // row renders an "Agent: <name>" pill without another round-trip.
  const agentsById = new Map(agents.map((a) => [a.id, a]));

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title="Egress Policies"
        description={
          <>
            Control outbound traffic from sandboxes — allow/deny hosts,
            zero-trust auth injection, run a fully customizable proxy, or route
            to VPC services. Read more about{" "}
            <a href={DOC_LINKS.outbound} target="_blank" rel="noreferrer">
              sandbox outbound traffic
            </a>{" "}
            and{" "}
            <a href={DOC_LINKS.dynamicWorkers} target="_blank" rel="noreferrer">
              Dynamic Workers
            </a>
            .
          </>
        }
        actions={
          <>
            <LinkButton
              variant="ghost"
              size="sm"
              icon={BookOpenText}
              href={DOC_LINKS.outbound}
              external
            >
              Docs
            </LinkButton>
            <Button variant="primary" size="sm" icon={Plus} onClick={newPolicy}>
              New Policy
            </Button>
          </>
        }
      />

      <Section>
        {policies.length === 0 ? (
          <Empty
            icon={<ShieldCheck size={48} weight="duotone" />}
            title="No egress policies yet"
            description="Create a policy to control outbound traffic for your sandboxes."
            contents={
              <Button variant="primary" onClick={newPolicy}>
                Create Policy
              </Button>
            }
          />
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Contents</th>
                <th>Scope</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => {
                // Dedupe by rule type so a policy with three Allow rules
                // shows a single "Allow list" pill. Order follows
                // RULE_PILL_LABEL key order for visual consistency.
                const types = new Set(p.egressRules.map((r) => r.type));
                const ordered = (
                  Object.keys(RULE_PILL_LABEL) as EgressRule["type"][]
                ).filter((t) => types.has(t));
                return (
                  <tr
                    key={p.id}
                    className="clickable"
                    onClick={() => startEditing(p)}
                  >
                    <td>
                      <strong>{p.name}</strong>
                    </td>
                    <td>
                      <div
                        style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
                      >
                        {ordered.length === 0 ? (
                          <span
                            className="muted"
                            style={{ fontSize: "0.75rem" }}
                          >
                            —
                          </span>
                        ) : (
                          ordered.map((t) => (
                            <Badge key={t} variant={RULE_BADGE[t]}>
                              {RULE_PILL_LABEL[t]}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      {(() => {
                        if (p.appliesToAll) {
                          return <Badge variant="info">Every sandbox</Badge>;
                        }
                        const linkedAgentId = detectLinkedAgentId(p);
                        if (linkedAgentId) {
                          const agent = agentsById.get(linkedAgentId);
                          return (
                            <span title={linkedAgentId}>
                              <Badge variant="secondary">
                                Agent: {agent?.name ?? linkedAgentId}
                              </Badge>
                            </span>
                          );
                        }
                        if (p.applyTo.length > 0) {
                          return (
                            <Badge variant="secondary">
                              {p.applyTo.length} matcher
                              {p.applyTo.length === 1 ? "" : "s"}
                            </Badge>
                          );
                        }
                        return (
                          <span
                            className="muted"
                            style={{ fontSize: "0.75rem" }}
                          >
                            —
                          </span>
                        );
                      })()}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Button
                        variant="secondary-destructive"
                        size="sm"
                        icon={Trash}
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(p.id);
                        }}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

interface PolicyFormProps {
  draft: EgressPolicy;
  secrets: SecretItem[];
  vpc: VpcBinding[];
  dataFields: string[];
  agents: AnthropicAgent[];
  onChange: (p: EgressPolicy) => void;
  onCancel: () => void;
  onSave: () => void;
}

function PolicyForm({
  draft,
  secrets,
  vpc,
  dataFields,
  agents,
  onChange,
  onCancel,
  onSave,
}: PolicyFormProps) {
  const update = (patch: Partial<EgressPolicy>) =>
    onChange({ ...draft, ...patch });

  // Current agent link (if any). Read on every render so the picker
  // reflects matcher edits the user makes directly.
  const linkedAgentId = detectLinkedAgentId(draft);

  // Apply the canonical `agent_id equals <id>` matcher when the user
  // picks an agent. Replaces any existing matchers so the policy form
  // doesn't end up with two competing scopes. Clearing the dropdown
  // removes the matcher; the form falls back to the empty-matcher
  // placeholder the parent component already supplies.
  const onAgentLinkChange = (next: string | null) => {
    if (next) {
      update({
        appliesToAll: false,
        applyTo: [
          { field: AGENT_MATCH_FIELD, operator: "equals", value: next },
        ],
      });
    } else {
      update({ applyTo: [emptyMatcher()] });
    }
  };
  // One datalist per form so all matcher field inputs share the same
  // suggestion source.
  const dataFieldsListId = useId();

  const addRule = (type: EgressRule["type"]) => {
    let rule: EgressRule;
    if (type === "allow" || type === "deny") rule = { type, host: "" };
    else if (type === "header-injection")
      rule = { type, target: "", header: "", secretName: "" };
    else if (type === "proxy") rule = { type, code: PROXY_TEMPLATE };
    else rule = { type, binding: vpc[0]?.binding || "", hostname: "" };
    update({ egressRules: [...draft.egressRules, rule] });
  };

  const updateRule = (idx: number, patch: Partial<EgressRule>) => {
    const next = draft.egressRules.map((r, i) =>
      i === idx ? ({ ...r, ...patch } as EgressRule) : r,
    );
    update({ egressRules: next });
  };

  const removeRule = (idx: number) => {
    update({ egressRules: draft.egressRules.filter((_, i) => i !== idx) });
  };

  const hasAllow = draft.egressRules.some((r) => r.type === "allow");
  const hasDeny = draft.egressRules.some((r) => r.type === "deny");
  const hasProxy = draft.egressRules.some((r) => r.type === "proxy");
  const vpcConfigured = vpc.length > 0;

  return (
    <>
      <PageHeader
        icon={ShieldCheck}
        title={draft.name ? `Edit Policy: ${draft.name}` : "New Egress Policy"}
        description="Define egress rules, such as allowed or denied hosts, secrets to inject in headers, connections to private resources, or completely custom proxy rules."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={onSave}>
              Save Policy
            </Button>
          </>
        }
      />

      <Section title="Policy">
        <Input
          label="Name"
          placeholder="production-egress"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </Section>

      <Section
        title="Egress Rules"
        description="Evaluated in order: deny → allow → header injection → VPC service → optional proxy."
        actions={
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {!hasAllow && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addRule("allow")}
              >
                + Allow
              </Button>
            )}
            {!hasDeny && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addRule("deny")}
              >
                + Deny
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addRule("header-injection")}
            >
              + Header Injection
            </Button>
            {!hasProxy && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => addRule("proxy")}
              >
                + Proxy
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addRule("vpc-service")}
              disabled={!vpcConfigured}
              title={
                vpcConfigured
                  ? undefined
                  : "Add a vpc_networks or vpc_services entry to wrangler.jsonc first"
              }
            >
              + VPC Service
            </Button>
          </div>
        }
      >
        {draft.egressRules.length === 0 ? (
          <div className="empty-state">No rules yet. Add one above.</div>
        ) : (
          <div className="rule-stack">
            {draft.egressRules.map((rule, i) => (
              <RuleCard
                key={i}
                rule={rule}
                secrets={secrets}
                vpc={vpc}
                onChange={(patch) => updateRule(i, patch)}
                onRemove={() => removeRule(i)}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Applies To"
        description={
          <>
            Apply this policy to every sandbox, scope it to a single agent, or
            auto-match when a webhook <code>data</code> field matches a value.
            Field names below are suggested from past webhook deliveries.
          </>
        }
      >
        <div style={{ marginBottom: "0.75rem" }}>
          <Checkbox
            label="Apply to every sandbox"
            checked={draft.appliesToAll === true}
            onCheckedChange={(v) => update({ appliesToAll: Boolean(v) })}
          />
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--text-color-kumo-subtle)",
              marginTop: "0.25rem",
              marginLeft: "1.75rem",
            }}
          >
            Use this policy as the default for all sandboxes. Disables matchers
            below.
          </div>
        </div>
        {!draft.appliesToAll && (
          <div style={{ marginBottom: "0.75rem" }}>
            <Select
              label="Apply to agent"
              description="Scope this policy to a single agent. Writes an `agent_id equals <id>` matcher under the hood — replaces any other matchers below."
              value={linkedAgentId ?? ""}
              onValueChange={(v) => onAgentLinkChange((v as string) || null)}
              placeholder="— any agent —"
              renderValue={(v) => {
                if (!v) return "— any agent —";
                const a = agents.find((a) => a.id === v);
                return a ? `${a.name} (${a.id})` : (v as string);
              }}
            >
              <Select.Option value="">— any agent —</Select.Option>
              {agents.map((a) => (
                <Select.Option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                </Select.Option>
              ))}
            </Select>
          </div>
        )}
        {!draft.appliesToAll && (
          <div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--text-color-kumo-subtle)",
                marginBottom: "0.4rem",
              }}
            >
              Auto-match by webhook data field
            </div>
            {draft.applyTo.length === 0 && (
              <div className="empty-state" style={{ padding: "0.75rem" }}>
                No matchers yet.
              </div>
            )}
            <datalist id={dataFieldsListId}>
              {dataFields.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <div className="applies-stack">
              {draft.applyTo.map((m, i) => (
                <ApplyToRow
                  key={i}
                  matcher={m}
                  fieldsListId={dataFieldsListId}
                  onChange={(patch) =>
                    update({
                      applyTo: draft.applyTo.map((row, j) =>
                        i === j ? { ...row, ...patch } : row,
                      ),
                    })
                  }
                  onRemove={() =>
                    update({ applyTo: draft.applyTo.filter((_, j) => j !== i) })
                  }
                />
              ))}
            </div>
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <Button
                variant="ghost"
                size="sm"
                icon={Plus}
                onClick={() =>
                  update({
                    applyTo: [
                      ...draft.applyTo,
                      { field: "", operator: "equals", value: "" },
                    ],
                  })
                }
              >
                Add Match
              </Button>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

function RuleCard({
  rule,
  secrets,
  vpc,
  onChange,
  onRemove,
}: {
  rule: EgressRule;
  secrets: SecretItem[];
  vpc: VpcBinding[];
  onChange: (patch: Partial<EgressRule>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rule-card">
      <div className="rule-card-header">
        <Badge variant={RULE_BADGE[rule.type]}>{RULE_LABEL[rule.type]}</Badge>
        <Button
          variant="secondary-destructive"
          size="sm"
          icon={Trash}
          onClick={onRemove}
          aria-label={`Remove ${RULE_LABEL[rule.type]} rule`}
        >
          Remove
        </Button>
      </div>
      <RuleEditor rule={rule} secrets={secrets} vpc={vpc} onChange={onChange} />
    </div>
  );
}

function hostsFromString(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function RuleEditor({
  rule,
  secrets,
  vpc,
  onChange,
}: {
  rule: EgressRule;
  secrets: SecretItem[];
  vpc: VpcBinding[];
  onChange: (patch: Partial<EgressRule>) => void;
}) {
  if (rule.type === "allow" || rule.type === "deny") {
    const values = hostsFromString(rule.host || "");
    return (
      <MultiPillInput
        label={rule.type === "allow" ? "Allowed hosts" : "Denied hosts"}
        description={HOST_PATTERN_HELP}
        placeholder="api.example.com"
        values={values}
        onChange={(next) => onChange({ host: next.join(", ") })}
        ariaLabel={`${rule.type} hosts`}
      />
    );
  }

  if (rule.type === "header-injection") {
    return (
      <div className="rule-grid">
        <MultiPillInput
          label="Target hosts"
          description={HOST_PATTERN_HELP}
          placeholder="api.example.com"
          values={hostsFromString(rule.target || "")}
          onChange={(next) => onChange({ target: next.join(", ") })}
          ariaLabel="header injection target hosts"
        />
        <Input
          label="Header name"
          description="The HTTP header to write on matching requests"
          placeholder="x-auth-token"
          value={rule.header}
          onChange={(e) => onChange({ header: e.target.value })}
        />
        <Select
          label="Secret value"
          description="Picks the value from the Secrets KV. Manage in the Secrets tab."
          value={rule.secretName}
          onValueChange={(v) => onChange({ secretName: v as string })}
          placeholder="— select secret —"
        >
          {secrets.map((s) => (
            <Select.Option key={s.key} value={s.key}>
              {s.key}
            </Select.Option>
          ))}
        </Select>
      </div>
    );
  }

  if (rule.type === "proxy") {
    return (
      <div className="field-stack">
        <p className="muted" style={{ fontSize: "0.75rem", margin: 0 }}>
          Loaded into a Dynamic Worker and called for every outbound request
          from the sandbox. Header-injection secrets are exposed as{" "}
          <code>env.X_AUTH_TOKEN</code> (uppercased, underscored).
        </p>
        <textarea
          className="proxy-textarea"
          value={rule.code}
          onChange={(e) => onChange({ code: e.target.value })}
          spellCheck={false}
        />
      </div>
    );
  }

  if (rule.type === "vpc-service") {
    if (vpc.length === 0) {
      return (
        <p className="muted" style={{ fontSize: "0.8125rem", margin: 0 }}>
          No VPC bindings configured. Add a <code>vpc_networks</code> or{" "}
          <code>vpc_services</code> entry to <code>wrangler.jsonc</code> to use
          this rule.
        </p>
      );
    }
    // The hostname field is stored as a comma-separated string on the wire,
    // mirroring allow/deny so the matcher logic in src/egress/match.ts can
    // split and test each pattern.
    const hostnames = hostsFromString(rule.hostname || "");
    return (
      <div className="rule-grid">
        <Select
          label="Binding"
          description="Which VPC binding to dispatch through"
          value={rule.binding}
          onValueChange={(v) => onChange({ binding: v as string })}
        >
          {vpc.map((b) => (
            <Select.Option key={b.binding} value={b.binding}>
              {b.binding} ({b.type})
            </Select.Option>
          ))}
        </Select>
        <MultiPillInput
          label="Hostnames"
          description={HOST_PATTERN_HELP}
          placeholder="vcs.internal, *.svc.internal"
          values={hostnames}
          onChange={(next) => onChange({ hostname: next.join(", ") })}
          ariaLabel="vpc hostnames"
        />
      </div>
    );
  }

  return null;
}

function ApplyToRow({
  matcher,
  fieldsListId,
  onChange,
  onRemove,
}: {
  matcher: ApplyToMatcher;
  fieldsListId: string;
  onChange: (patch: Partial<ApplyToMatcher>) => void;
  onRemove: () => void;
}) {
  const operator = matcher.operator;

  return (
    <div className="apply-card">
      <div className="apply-row">
        <Input
          label="Field"
          placeholder="id, organization_id, workspace_id"
          value={matcher.field}
          onChange={(e) => onChange({ field: e.target.value })}
          aria-label="match field"
          // HTML datalist is attached via the `list` attribute, which Kumo's
          // Input forwards to the underlying <input>. The browser shows the
          // suggestions as a free-form combobox.
          list={fieldsListId}
        />
        <Select
          label="Operator"
          value={operator}
          onValueChange={(v) =>
            onChange({ operator: v as ApplyToMatcher["operator"] })
          }
        >
          <Select.Option value="equals">equals</Select.Option>
          <Select.Option value="contains">contains</Select.Option>
          <Select.Option value="matches">matches (regex)</Select.Option>
          <Select.Option value="is-one-of">is one of</Select.Option>
        </Select>
        <Button
          variant="secondary-destructive"
          size="sm"
          icon={Trash}
          onClick={onRemove}
          aria-label="Remove matcher"
          className="apply-remove"
        >
          Remove
        </Button>
      </div>
      <div className="apply-value">
        {operator === "is-one-of" ? (
          <MultiPillInput
            label="Values"
            description="Match if the field equals any of these"
            placeholder="prod, staging, ..."
            values={matcher.values || []}
            onChange={(values) => onChange({ values })}
            ariaLabel="match values"
          />
        ) : (
          <Input
            label="Value"
            placeholder={
              operator === "matches"
                ? "^prod-.*$"
                : operator === "contains"
                  ? "prod"
                  : "production"
            }
            value={matcher.value || ""}
            onChange={(e) => onChange({ value: e.target.value })}
            aria-label="match value"
          />
        )}
      </div>
    </div>
  );
}
