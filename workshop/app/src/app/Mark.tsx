/** The product's mark: a speech bubble with a tick, for a product that checks what an agent says to people. */
export function Mark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={`flex flex-shrink-0 items-center justify-center rounded-[9px] bg-fg text-white ${className ?? "size-8"}`}>
      <svg viewBox="0 0 24 24" className="size-[62%]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 4.5h10a3 3 0 0 1 3 3v4.5a3 3 0 0 1-3 3h-5.5l-4 3.5v-3.5H7a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3z" />
        <path d="m9 9.6 2.1 2.1L15.2 7.6" />
      </svg>
    </span>
  );
}
