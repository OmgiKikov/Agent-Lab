import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, IconButton } from "./ui";

/** A dialog with a backdrop, focus trap and Esc, built on Radix. Title and one sentence of what happens, then the content. */
export function Modal({ open, onClose, title, description, children, className }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-48px)] w-[calc(100vw-32px)] max-w-[720px] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg",
            "border border-lab-edge bg-lab-panel shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div className="min-w-0">
              <Dialog.Title className="text-lead font-medium text-lab-ink">{title}</Dialog.Title>
              <Dialog.Description className={cn("mt-1 text-body text-lab-mute", !description && "sr-only")}>{description ?? title}</Dialog.Description>
            </div>
            <Dialog.Close asChild><IconButton icon={X} label="Закрыть" className="-mr-2 -mt-1" /></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** «Вы уверены?» with a plain sentence about the consequence. `danger` when the action cannot be undone. */
export function Confirm({ open, onClose, onConfirm, title, children, action, danger }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; children: ReactNode; action: string; danger?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} className="max-w-[460px]">
      <div className="px-6 pb-5 pt-1 text-body text-lab-text">{children}</div>
      <div className="flex justify-end gap-2 border-t border-lab-line px-6 py-4">
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => { onConfirm(); onClose(); }}>{action}</Button>
      </div>
    </Modal>
  );
}
