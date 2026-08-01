import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import type { ReactNode } from "react";

// Card-like content section used inside every page below the PageHeader.
// Wraps Kumo's LayerCard with a consistent header / actions layout.
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <LayerCard className="section-card">
      {(title || actions) && (
        <div className="section-header">
          <div>
            {title && <h2 className="section-title">{title}</h2>}
            {description && <p className="section-description">{description}</p>}
          </div>
          {actions && <div className="section-actions">{actions}</div>}
        </div>
      )}
      <div className="section-body">{children}</div>
    </LayerCard>
  );
}
