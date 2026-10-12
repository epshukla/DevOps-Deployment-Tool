import type { ReactNode } from "react";

/**
 * The one container style (design-system/deployx/MASTER.md): hairline border,
 * flat panel fill, optional 44px header with a title and actions.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low ${className}`}
    >
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-outline-variant px-4 py-2">
          <div className="min-w-0">
            {title && <h2 className="truncate font-mono text-[13px] font-semibold">{title}</h2>}
            {description && (
              <p className="truncate text-xs text-on-surface-variant">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
