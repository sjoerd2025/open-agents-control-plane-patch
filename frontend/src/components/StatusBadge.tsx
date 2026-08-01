import { Badge } from "@cloudflare/kumo/components/badge";
import {
  containerBadgeIntent,
  intentBadgeVariant,
  sessionStatusIntent,
  type StatusIntent,
} from "../utils";

export function StatusBadge({
  status,
  kind,
}: {
  status: string | undefined;
  kind: "container" | "session";
}) {
  const intent: StatusIntent =
    kind === "container" ? containerBadgeIntent(status) : sessionStatusIntent(status);
  return <Badge variant={intentBadgeVariant[intent]}>{status || "unknown"}</Badge>;
}
