import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, titleFont } from "./ui";

/** A dialog with a backdrop, focus trap and Esc, built on Radix. */
export function Modal({ open, onClose, title, description, children, className }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75 backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-48px)] w-[calc(100vw-32px)] max-w-[720px] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl",
            "border border-white/10 bg-[#0b0b0b] shadow-[0_24px_80px_rgba(0,0,0,0.7)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
            <div>
              <Dialog.Title className="text-[19px] font-medium text-lab-ink" style={titleFont}>{title}</Dialog.Title>
              <Dialog.Description className={cn("mt-1 text-[13px] text-lab-dim", !description && "sr-only")}>{description ?? title}</Dialog.Description>
            </div>
            <Dialog.Close asChild><Button variant="ghost" size="sm" className="-mr-2 -mt-1 !px-2" aria-label="Закрыть"><X className="size-4" /></Button></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** «Вы уверены?» with a plain sentence about the consequence. */
export function Confirm({ open, onClose, onConfirm, title, children, action }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; children: ReactNode; action: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} className="max-w-[460px]">
      <div className="px-6 pb-5 pt-2 text-[13px] leading-relaxed text-lab-mute">{children}</div>
      <div className="flex justify-end gap-2 border-t border-white/[0.06] px-6 py-4">
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={() => { onConfirm(); onClose(); }}>{action}</Button>
      </div>
    </Modal>
  );
}
