import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

/** A small dialog in the middle: a question, a choice, the actions. */
export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[18%] z-50 w-[calc(100vw-32px)] max-w-[500px] -translate-x-1/2 rounded-sheet bg-side shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="px-5 pt-5 text-body font-semibold text-fg">{title}</Dialog.Title>
          <div className="px-5 pb-5 pt-3">{children}</div>
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
