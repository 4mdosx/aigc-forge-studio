"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const HISTORY_LIMIT = 8;

export function NobgEraser({
  src,
  onCancel,
  onSave,
}: {
  src: string;
  onCancel: () => void;
  onSave: (blob: Blob) => Promise<void>;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const [size, setSize] = useState(28);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let alive = true;
    const image = new Image();
    const fit = () => {
      if (!canvas.width || !canvas.height) return;
      const box = frame.getBoundingClientRect();
      const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
      canvas.style.width = `${Math.max(1, canvas.width * scale)}px`;
      canvas.style.height = `${Math.max(1, canvas.height * scale)}px`;
    };
    image.onload = () => {
      if (!alive) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
      history.current = [];
      setCanUndo(false);
      setReady(true);
      fit();
    };
    image.src = src;
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [src]);

  function point(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
      radius: (sizeRef.current * canvas.width) / rect.width / 2,
    };
  }

  function stamp(from: { x: number; y: number }, to: { x: number; y: number }, radius: number) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.lineWidth = radius * 2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.restore();
  }

  function remember() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    history.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
    setCanUndo(true);
  }

  function undo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const shot = history.current.pop();
    if (!canvas || !ctx || !shot) return;
    ctx.putImageData(shot, 0, 0);
    setCanUndo(history.current.length > 0);
  }

  const undoRef = useRef(undo);
  undoRef.current = undo;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undoRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || saving) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    setSaving(true);
    try {
      await onSave(blob);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="capture-eraser">
      <div className="capture-erase-bar">
        <span>擦除</span>
        <input
          type="range"
          min={8}
          max={96}
          value={size}
          aria-label="笔刷大小"
          onChange={(event) => setSize(Number(event.target.value))}
        />
        <button type="button" className="quiet" disabled={!canUndo} onClick={undo}>
          撤销
        </button>
        <button type="button" className="quiet" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? "保存中…" : "完成"}
        </button>
        <button type="button" className="quiet" disabled={saving} onClick={onCancel}>
          取消
        </button>
      </div>
      <div className="capture-frame alpha" ref={frameRef}>
        <canvas
          ref={canvasRef}
          aria-label="擦除画布"
          onPointerDown={(event) => {
            if (!ready) return;
            const at = point(event);
            if (!at) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            remember();
            drawing.current = true;
            last.current = at;
            stamp(at, at, at.radius);
          }}
          onPointerMove={(event) => {
            const canvas = canvasRef.current;
            const frame = frameRef.current;
            if (canvas && frame) {
              const box = frame.getBoundingClientRect();
              setCursor({ x: event.clientX - box.left, y: event.clientY - box.top });
            }
            if (!drawing.current || !last.current) return;
            const at = point(event);
            if (!at) return;
            stamp(last.current, at, at.radius);
            last.current = at;
          }}
          onPointerUp={() => {
            drawing.current = false;
            last.current = null;
          }}
          onPointerLeave={() => setCursor(null)}
        />
        {cursor ? (
          <span
            className="capture-brush"
            style={{
              width: size,
              height: size,
              left: cursor.x - size / 2,
              top: cursor.y - size / 2,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
