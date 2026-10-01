import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A panel from the right edge over the page: the source of a criterion, the report, a form. Esc, the cross and the
 * backdrop close it; on a phone it takes the whole screen.
 */
export function Sheet({ open, onClose, title, sub, actions, children, width = "md", className }: {
  open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode;
  width?: "md" | "lg"; className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-screen flex-col border-l border-line bg-side shadow-pop outline-none",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-6 data-[state=open]:duration-200",
            width === "lg" ? "sm:w-[min(880px,100vw)]" : "sm:w-[min(680px,100vw)]", className,
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-body font-semibold text-fg">{title}</Dialog.Title>
              {sub && <div className="mt-0.5 text-meta text-fg-3">{sub}</div>}
            </div>
            {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
            <Dialog.Close className="rounded-control p-1.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60" aria-label="Закрыть (Esc)">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
