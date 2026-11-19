import { useEffect, type ReactNode } from "react";
import { IconClose } from "./Icons.js";

export interface ModalDrawerProps {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  onClose: () => void;
  children: ReactNode;
}

export function ModalDrawer({
  open,
  title,
  subtitle,
  onClose,
  children,
}: ModalDrawerProps) {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="aw-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="aw-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="aw-modal-handle" aria-hidden="true" />

        <div className="aw-modal-header">
          <div>
            <h2 className="aw-modal-title">{title}</h2>
            {subtitle && <p className="aw-modal-subtitle">{subtitle}</p>}
          </div>

          <button
            type="button"
            className="aw-icon-circle-btn"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <IconClose size={18} />
          </button>
        </div>

        <div className="aw-drawer-body">{children}</div>
      </div>
    </div>
  );
}
