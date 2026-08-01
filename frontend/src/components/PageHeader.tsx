import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

// Mirrors the Cloudflare dashboard "page header" pattern: an icon next to a
// large heading, a one-line description, and an optional action slot on the
// right (Documentation buttons, "New X", filters, etc.).
export interface PageHeaderProps {
  icon: Icon;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ icon: IconComp, title, description, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1>
          <IconComp className="page-header-icon" weight="regular" />
          {title}
        </h1>
        {description && <p className="page-header-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
