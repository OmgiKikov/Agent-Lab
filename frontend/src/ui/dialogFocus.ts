import { useEffect, useRef, useState } from "react";

/** Remember the opener before the dialog's native autoFocus runs, including dialogs mounted only while open. */
export function useDialogFocus(open: boolean, onClose?: (event: Event) => void) {
  const [initial] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const trigger = useRef<HTMLElement | null>(initial);
  useEffect(() => {
    if (open) return;
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) trigger.current = event.target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [open]);
  return {
    onCloseAutoFocus: (event: Event) => {
      onClose?.(event);
      if (!event.defaultPrevented && trigger.current?.isConnected) {
        event.preventDefault();
        trigger.current.focus();
      }
    },
  };
}
