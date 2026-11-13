'use client'

import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="quiet icon" aria-label="关闭" title="关闭" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {children}
    </dialog>
  )
}
