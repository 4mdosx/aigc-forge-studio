'use client'

import type { CSSProperties } from 'react'
import { Toaster } from 'sonner'
import 'sonner/dist/styles.css'

const paper = {
  '--normal-bg': '#f7f3ea',
  '--normal-border': '#d8cec0',
  '--normal-text': '#241f1a',
  '--success-bg': '#e7f0ec',
  '--success-border': '#c5ddd4',
  '--success-text': '#0c5c49',
  '--error-bg': '#f8e8e4',
  '--error-border': '#e2b2a8',
  '--error-text': '#7d2a22',
  fontFamily: '"Avenir Next", "Segoe UI", sans-serif',
} as CSSProperties

export function Notices() {
  return (
    <Toaster
      theme="light"
      position="top-center"
      closeButton
      richColors
      duration={3800}
      visibleToasts={3}
      offset={16}
      style={paper}
      toastOptions={{ closeButtonAriaLabel: '关闭' }}
    />
  )
}
