import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { X } from "lucide-react";

/** A sheet from the right edge; Esc and the backdrop close it. */
export function Drawer({ open, onClose, title, sub, children }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-[min(720px,100vw)] flex-col border-l border-white/[0.08] bg-lab-surface shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right-8"
        >
          <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate font-mono text-small text-lab-ink">{title}</Dialog.Title>
              {sub && <div className="mt-1 text-meta text-lab-dim">{sub}</div>}
            </div>
            <Dialog.Close className="rounded p-1 text-lab-dim transition-colors hover:bg-white/[0.06] hover:text-lab-text" aria-label="Закрыть"><X className="size-4" /></Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
