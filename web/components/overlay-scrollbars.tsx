'use client'

import { useEffect } from 'react'

const thumbMin = 28
const thumbThickness = 6
const thumbInset = 2

export function OverlayScrollbars() {
  useEffect(() => {
    const layer = document.createElement('div')
    layer.className = 'scrollbar-layer'
    layer.setAttribute('popover', 'manual')
    document.body.appendChild(layer)

    const thumbs = new Map<string, { el: HTMLElement; axis: 'x' | 'y'; node: HTMLDivElement }>()
    const listened = new WeakSet<HTMLElement>()
    const ids = new WeakMap<HTMLElement, number>()
    let nextId = 1
    let frame = 0
    let dragging: {
      el: HTMLElement
      axis: 'x' | 'y'
      start: number
      startScroll: number
    } | null = null

    const raise = () => {
      if (!('showPopover' in layer)) return
      try {
        if (layer.matches(':popover-open')) layer.hidePopover()
        layer.showPopover()
      } catch {
        // The layer can already be switching top-layer order.
      }
    }

    const idOf = (el: HTMLElement) => {
      const existing = ids.get(el)
      if (existing) return existing
      const id = nextId
      nextId += 1
      ids.set(el, id)
      return id
    }

    const scrollable = (el: HTMLElement) => {
      if (!el.isConnected || layer.contains(el)) return { x: false, y: false }
      const openDialogs = document.querySelectorAll('dialog[open]')
      const topDialog = openDialogs[openDialogs.length - 1]
      if (topDialog && el !== topDialog && !topDialog.contains(el)) return { x: false, y: false }
      if (el.closest('dialog:not([open])')) return { x: false, y: false }
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return { x: false, y: false }
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return { x: false, y: false }
      const allows = (value: string) => value === 'auto' || value === 'scroll' || value === 'overlay'
      const overflows = (scroll: number, client: number) => scroll > client + 4
      return {
        x: allows(style.overflowX) && overflows(el.scrollWidth, el.clientWidth),
        y: allows(style.overflowY) && overflows(el.scrollHeight, el.clientHeight),
      }
    }

    const place = (el: HTMLElement, axis: 'x' | 'y', node: HTMLDivElement, both: boolean) => {
      const rect = el.getBoundingClientRect()
      if (axis === 'y') {
        const size = Math.max(thumbMin, (el.clientHeight / el.scrollHeight) * el.clientHeight)
        const max = el.scrollHeight - el.clientHeight
        const travel = Math.max(1, el.clientHeight - size)
        const offset = max <= 0 ? 0 : (el.scrollTop / max) * (el.clientHeight - size)
        node.style.left = `${rect.right - thumbThickness - thumbInset}px`
        node.style.top = `${rect.top + offset}px`
        node.style.width = `${thumbThickness}px`
        node.style.height = `${size}px`
        return
      }
      const endGap = both ? thumbThickness + thumbInset * 2 : 0
      const room = Math.max(1, el.clientWidth - endGap)
      const size = Math.max(thumbMin, Math.min(room, (el.clientWidth / el.scrollWidth) * room))
      const max = el.scrollWidth - el.clientWidth
      const offset = max <= 0 ? 0 : (el.scrollLeft / max) * Math.max(0, room - size)
      node.style.left = `${rect.left + offset}px`
      node.style.top = `${rect.bottom - thumbThickness - thumbInset}px`
      node.style.width = `${size}px`
      node.style.height = `${thumbThickness}px`
    }

    const moveTo = (el: HTMLElement, axis: 'x' | 'y', delta: number, startScroll: number) => {
      const viewport = axis === 'y' ? el.clientHeight : el.clientWidth
      const scrollSize = axis === 'y' ? el.scrollHeight : el.scrollWidth
      const size = Math.max(thumbMin, (viewport / scrollSize) * viewport)
      const max = scrollSize - viewport
      const travel = Math.max(1, viewport - size)
      const next = startScroll + (delta / travel) * max
      if (axis === 'y') el.scrollTop = next
      else el.scrollLeft = next
    }

    const syncPositions = () => {
      for (const thumb of thumbs.values()) {
        const axes = scrollable(thumb.el)
        if (!(thumb.axis === 'x' ? axes.x : axes.y)) continue
        place(thumb.el, thumb.axis, thumb.node, axes.x && axes.y)
      }
    }

    const sync = () => {
      const found = new Set<string>()
      const elements: HTMLElement[] = [document.documentElement, document.body]
      for (const node of document.querySelectorAll<HTMLElement>('body *')) elements.push(node)
      for (const el of elements) {
        const axes = scrollable(el)
        if (!axes.x && !axes.y) continue
        if (!listened.has(el)) {
          listened.add(el)
          el.addEventListener('scroll', syncPositions, { passive: true })
        }
        for (const axis of ['x', 'y'] as const) {
          if (!axes[axis]) continue
          const key = `${idOf(el)}:${axis}`
          found.add(key)
          let thumb = thumbs.get(key)
          if (!thumb) {
            const node = document.createElement('div')
            node.className = 'scrollbar-thumb'
            node.dataset.axis = axis
            layer.appendChild(node)
            node.addEventListener('pointerdown', (event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.stopPropagation()
              node.setPointerCapture(event.pointerId)
              dragging = {
                el,
                axis,
                start: axis === 'y' ? event.clientY : event.clientX,
                startScroll: axis === 'y' ? el.scrollTop : el.scrollLeft,
              }
            })
            thumb = { el, axis, node }
            thumbs.set(key, thumb)
          }
          place(el, axis, thumb.node, axes.x && axes.y)
        }
      }
      for (const [key, thumb] of thumbs) {
        if (found.has(key)) continue
        thumb.node.remove()
        thumbs.delete(key)
      }
    }

    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(sync)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return
      const delta = (dragging.axis === 'y' ? event.clientY : event.clientX) - dragging.start
      moveTo(dragging.el, dragging.axis, delta, dragging.startScroll)
    }

    const onPointerUp = () => {
      dragging = null
    }

    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDialogElement) raise()
      schedule()
    }

    raise()
    const observer = new MutationObserver((records) => {
      if (records.every((record) => layer.contains(record.target))) return
      schedule()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'class', 'style', 'hidden'],
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    document.addEventListener('toggle', onToggle, true)
    schedule()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('toggle', onToggle, true)
      layer.remove()
    }
  }, [])

  return null
}
