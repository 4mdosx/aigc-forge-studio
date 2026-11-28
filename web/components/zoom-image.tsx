'use client'

import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ZoomImageProps {
  src: string | null | undefined
  alt?: string
  /** 直接落在 <img> 上，沿用各页面原有尺寸/圆角样式 */
  className?: string
  /** 弹窗里「新标签打开」的目标，缺省同 src */
  href?: string
  /** 弹窗底部文案，缺省用 alt */
  caption?: string
  /** 底下一层容器只允许单击选中时，用 double 避免抢走单击 */
  zoomOn?: 'click' | 'double' | 'none'
  eager?: boolean
  /** 图片本身可拖拽（默认关，避免和框选/长按冲突） */
  draggable?: boolean
  /** 加载失败时的占位文案 */
  brokenLabel?: string
}

/**
 * 全站统一的图片展示组件。
 *
 * 为什么不用 wrapper 包一层：各页面的尺寸/圆角/object-fit 都写在 img 的 class 上
 * （.job-thumb / .task-shot / .capture-tile img …），包一层会破坏布局与选择器，
 * 所以直接把交互挂到 img 本身。弹窗走 portal 挂到 body，避开「img 嵌在 button 里」
 * 这种非法嵌套。
 */
export function ZoomImage({
  src,
  alt = '',
  className,
  href,
  caption,
  zoomOn = 'click',
  eager = false,
  draggable = true,
  brokenLabel = '读取失败',
}: ZoomImageProps) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)

  // src 变了就把失败态清掉（列表复用 DOM 节点时会串）
  useEffect(() => {
    setBroken(false)
  }, [src])

  if (!src) return null
  if (broken) {
    return (
      <span
        className={`zoom-broken${className ? ` ${className}` : ''}`}
        title={src}
        aria-label={alt || brokenLabel}
      >
        {brokenLabel}
      </span>
    )
  }

  const focusable = zoomOn !== 'none'
  return (
    <>
      <img
        className={`zoomable${zoomOn === 'double' ? ' zoomable-dbl' : ''}${className ? ` ${className}` : ''}`}
        src={src}
        alt={alt}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        draggable={draggable}
        tabIndex={focusable ? 0 : undefined}
        title={zoomOn === 'double' ? '双击放大' : undefined}
        onError={() => setBroken(true)}
        onClick={
          zoomOn === 'none'
            ? undefined
            : (event) => {
                if (zoomOn === 'double') return
                // 嵌在 <a>/<button> 里时不触发外层跳转与选中
                event.preventDefault()
                event.stopPropagation()
                setOpen(true)
              }
        }
        onDoubleClick={
          zoomOn === 'double'
            ? (event) => {
                event.preventDefault()
                event.stopPropagation()
                setOpen(true)
              }
            : undefined
        }
        onKeyDown={
          zoomOn === 'none'
            ? undefined
            : (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                setOpen(true)
              }
        }
      />
      {open ? (
        <ImageLightbox
          src={src}
          alt={alt}
          caption={caption}
          href={href}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

/** 单图放大弹窗。需要多图翻页的用 image-detail 里的浏览态查看器。 */
export function ImageLightbox({
  src,
  alt = '',
  caption,
  href,
  onClose,
}: {
  src: string
  alt?: string
  caption?: string
  href?: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
      // 这里千万别 dialog.close()：close 会派发 close 事件 → onClose → setOpen(false)，
      // 在 effect 双调用（StrictMode）下等于刚打开就自己关掉。卸载本身会移除元素。
    }
  }, [])

  const body = (
    <dialog
      ref={ref}
      className="lightbox"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="lightbox-stage" onClick={onClose}>
        <img src={src} alt={alt} onClick={onClose} />
      </div>
      <div className="lightbox-bar">
        <span className="lightbox-caption" title={caption ?? alt}>
          {caption ?? alt ?? ''}
        </span>
        <a className="lightbox-link" href={href ?? src} target="_blank" rel="noreferrer">
          新标签打开
        </a>
        <button
          type="button"
          className="lightbox-close"
          aria-label="关闭"
          title="关闭（Esc）"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
    </dialog>
  )

  // 走 portal：img 可能嵌在 <button>/<a> 里，内联 <dialog> 属于非法嵌套。
  // 弹窗只在意点击后才渲染，SSR 阶段不会走到这里。
  if (typeof document === 'undefined') return null
  return createPortal(body, document.body)
}
