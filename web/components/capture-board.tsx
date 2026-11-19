"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";

import { api, fileHref } from "@/lib/api";
import { fail, messageOf, notify } from "@/lib/notify";

type ImageStatus = "collected" | "processed" | "approved" | "rejected";

interface ImageAsset {
  id: string;
  status: ImageStatus;
  source: {
    type: "manual" | "crawler";
    sourceUrl: string;
    imgUrl: string;
  };
  original: {
    path: string;
    width: number;
    height: number;
    hash: string;
  };
  processed?: {
    path: string;
    width: number;
    height: number;
  };
  tags: string[];
  embedding: number[];
  tagsModelVersion: string;
  embeddingModelVersion: string;
  reviewedAt: number;
  note?: string;
  createdAt: number;
  updatedAt: number;
  originalUrl: string;
  processedUrl: string | null;
  duplicate?: boolean;
}

type EditField = "sourceUrl" | "imgUrl" | "tags" | "embedding";

export function CaptureBoard() {
  const [items, setItems] = useState<ImageAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [slide, setSlide] = useState<"raw" | "image">("image");
  const [editing, setEditing] = useState<EditField | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const focusNewest = useRef(false);

  const loadItems = useCallback(async () => {
    try {
      const body = await api<{ items: ImageAsset[] }>("capture/assets");
      setItems(body.items);
      setSelectedId((cur) => {
        if (focusNewest.current) {
          focusNewest.current = false;
          return body.items[0]?.id ?? null;
        }
        if (cur && body.items.some((item) => item.id === cur)) return cur;
        return body.items[0]?.id ?? null;
      });
      setLoaded(true);
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // 有预处理中条目时 2.5s 轮询，全部落定即停
  useEffect(() => {
    if (!items.some((item) => item.status === "collected")) return;
    const timer = setInterval(() => void loadItems(), 2500);
    return () => clearInterval(timer);
  }, [items, loadItems]);

  function beginEdit(field: EditField, value: string) {
    setEditing(field);
    setDraft(value);
  }

  async function saveEdit(item: ImageAsset) {
    if (!editing || saving) return;
    const patch: {
      sourceUrl?: string;
      imgUrl?: string;
      tags?: string[];
      embedding?: number[];
    } = {};
    if (editing === "sourceUrl") patch.sourceUrl = draft.trim();
    if (editing === "imgUrl") patch.imgUrl = draft.trim();
    if (editing === "tags") {
      patch.tags = draft
        .split(/[,;\n]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
    }
    if (editing === "embedding") {
      const parts = draft.split(/[,;\s]+/).filter((part) => part !== "");
      const embedding = parts.map(Number);
      if (embedding.some((value) => !Number.isFinite(value))) {
        fail("embedding 需要一组数字");
        return;
      }
      patch.embedding = embedding;
    }
    setSaving(true);
    try {
      await api(`capture/assets/${item.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setEditing(null);
      await loadItems();
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  async function review(item: ImageAsset, action: "approve" | "reject") {
    try {
      await api(`capture/assets/${item.id}/${action}`, { method: "POST" });
      notify(action === "approve" ? "已通过，目录移到 assets" : "已拒绝");
      await loadItems();
    } catch (err) {
      fail(messageOf(err));
    }
  }

  async function submitUrls(rawUrls: string[]) {
    const pending = rawUrls
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (pending.length === 0) return;
    setSubmitting(true);
    let added = 0;
    let duplicates = 0;
    const errors: string[] = [];
    try {
      for (const item of pending) {
        try {
          let imgUrl = item;
          let sourceUrl = "";
          let sourceType: "manual" | "crawler" = "manual";
          if (isPinterest(item)) {
            const resolved = await api<{ imgUrl: string }>("capture/resolve", {
              method: "POST",
              body: JSON.stringify({ provider: "pinterest", url: item }),
            });
            imgUrl = resolved.imgUrl;
            sourceUrl = item;
            sourceType = "crawler";
          }
          const body = await api<{ duplicate?: boolean }>("capture/collected", {
            method: "POST",
            body: JSON.stringify({ sourceType, sourceUrl, imgUrl }),
          });
          if (body.duplicate) duplicates += 1;
          else added += 1;
        } catch (err) {
          errors.push(messageOf(err));
        }
      }
      if (added > 0) {
        notify(
          added === 1
            ? "已下载原图，预处理进行中"
            : `已接收 ${added} 个链接，预处理进行中`,
        );
        setUrl("");
      }
      if (duplicates > 0)
        notify(
          duplicates === 1
            ? "重复图片，已跳过"
            : `${duplicates} 个链接是重复图片，已跳过`,
        );
      if (errors.length > 0) fail(errors[0] ?? "采集失败");
      if (added > 0) focusNewest.current = true;
      if (added > 0 || duplicates > 0) await loadItems();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitFiles(files: File[]) {
    if (files.length === 0) return;
    setSubmitting(true);
    let added = 0;
    const errors: string[] = [];
    try {
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        try {
          await api("capture/collected", { method: "POST", body: form });
          added += 1;
        } catch (err) {
          errors.push(`${file.name || "图片"}: ${messageOf(err)}`);
        }
      }
      if (added > 0) {
        notify(
          added === 1
            ? "已接收图片，预处理进行中"
            : `已接收 ${added} 张图片，预处理进行中`,
        );
      }
      if (errors.length > 0) fail(errors[0] ?? "上传失败");
      if (added > 0) {
        focusNewest.current = true;
        await loadItems();
      }
    } finally {
      setSubmitting(false);
    }
  }

  function submitPin(event: FormEvent) {
    event.preventDefault();
    void submitUrls([url]);
  }

  async function takeIncoming(files: File[], urls: string[] | null) {
    if (files.length > 0) await submitFiles(files);
    if (urls) await submitUrls(urls);
  }

  function takeDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const files = imageFiles(event.dataTransfer.files);
    const urls =
      files.length > 0
        ? null
        : urlsOnly(
            event.dataTransfer.getData("text/uri-list") ||
              event.dataTransfer.getData("text/plain"),
          );
    if (files.length === 0 && !urls) return;
    void takeIncoming(files, urls);
  }

  function takePaste(event: ClipboardEvent<HTMLElement>) {
    const files = imageFilesFromClipboard(event.clipboardData);
    const urls =
      files.length > 0
        ? null
        : urlsOnly(event.clipboardData.getData("text/plain"));
    if (files.length === 0 && !urls) return;
    event.preventDefault();
    void takeIncoming(files, urls);
  }

  const doneCount = items.filter(
    (item) => item.status === "processed" || item.status === "approved",
  ).length;
  const processingCount = items.filter(
    (item) => item.status === "collected",
  ).length;
  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      if (!selected) return;
      if (event.key === "ArrowLeft" && selected.originalUrl) {
        event.preventDefault();
        setSlide("raw");
      }
      if (event.key === "ArrowRight" && selected.processedUrl) {
        event.preventDefault();
        setSlide("image");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  const slides = selected
    ? [
        selected.originalUrl
          ? { key: "raw" as const, label: "原始", href: selected.originalUrl }
          : null,
        selected.processedUrl
          ? {
              key: "image" as const,
              label: "预处理",
              href: selected.processedUrl,
            }
          : null,
      ].filter((item) => item !== null)
    : [];
  const currentSlide =
    slides.find((item) => item.key === slide) ?? slides[0] ?? null;

  return (
    <>
      <div className="capture-split">
        <section className="panel capture-stage">
          <div className="column-head">
            <h2>采集</h2>
            <button
              type="button"
              className="quiet"
              onClick={() => void loadItems()}
            >
              刷新
            </button>
          </div>

          <form
            tabIndex={0}
            className={dragging ? "capture-drop dragging" : "capture-drop"}
            onMouseDown={(event) => {
              if (
                event.target instanceof HTMLElement &&
                event.target.closest("input, button, a")
              )
                return;
              event.currentTarget.focus();
            }}
            onSubmit={submitPin}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node))
                return;
              setDragging(false);
            }}
            onDrop={takeDrop}
            onPaste={takePaste}
          >
            {selected ? (
              <>
                <div className="capture-hero">
                  {currentSlide ? (
                    <img src={fileHref(currentSlide.href)} alt={selected.id} />
                  ) : (
                    <span className="capture-missing">
                      {selected.status === "collected" ? "处理中…" : "无图"}
                    </span>
                  )}
                  <div
                    className="capture-switch"
                    role="group"
                    aria-label="切换原始和预处理"
                  >
                    <button
                      type="button"
                      className={currentSlide?.key === "raw" ? "active" : ""}
                      disabled={!selected.originalUrl}
                      onClick={() => setSlide("raw")}
                    >
                      原始
                    </button>
                    <button
                      type="button"
                      className={currentSlide?.key === "image" ? "active" : ""}
                      disabled={!selected.processedUrl}
                      onClick={() => setSlide("image")}
                    >
                      预处理
                    </button>
                  </div>
                </div>
                <p className="muted">拖到大图上或粘贴，可以继续采集。</p>
              </>
            ) : (
              <>
                <div className="capture-input">
                  <input
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    enterKeyHint="send"
                    placeholder="拖拽或粘贴图片、Pinterest 链接"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={submitting || url.trim() === ""}
                  >
                    {submitting ? "接收中…" : "采集"}
                  </button>
                </div>
                <p className="muted">
                  图片和链接都可以拖进来或粘贴。原图落到 data/capture/raw/。
                </p>
              </>
            )}
          </form>
        </section>

        <section className="panel capture-info">
          <div className="column-head">
            <h2>图像</h2>
            <span className="muted">
              完成 {doneCount}
              {processingCount > 0 ? ` · 处理中 ${processingCount}` : ""}
            </span>
          </div>
          <div className="capture-info-body">
            {!loaded ? (
              <p className="muted">加载中…</p>
            ) : !selected ? (
              <p className="muted">还没有图片。把图片或链接拖进左侧。</p>
            ) : (
              <>
                {selected.status === "processed" ? (
                  <div className="row capture-actions">
                    <button
                      type="button"
                      className="quiet"
                      disabled={selected.status !== "processed"}
                      onClick={() => void review(selected, "approve")}
                    >
                      通过
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      disabled={selected.status !== "processed"}
                      onClick={() => void review(selected, "reject")}
                    >
                      拒绝
                    </button>
                  </div>
                ) : null}
                <dl className="capture-meta">
                  <dt>状态</dt>
                  <dd>
                    <span className={`capture-badge ${selected.status}`}>
                      {statusLabel(selected.status)}
                    </span>
                  </dd>
                  <dt>尺寸</dt>
                  <dd>{sizeText(selected)}</dd>
                  <dt>源地址</dt>
                  <dd>
                    <Editable
                      active={editing === "sourceUrl"}
                      draft={draft}
                      saving={saving}
                      text={selected.source.sourceUrl}
                      onDraft={setDraft}
                      onOpen={() =>
                        beginEdit("sourceUrl", selected.source.sourceUrl)
                      }
                      onCancel={() => setEditing(null)}
                      onSave={() => void saveEdit(selected)}
                    />
                  </dd>
                  <dt>图像地址</dt>
                  <dd>
                    <Editable
                      active={editing === "imgUrl"}
                      draft={draft}
                      saving={saving}
                      text={selected.source.imgUrl}
                      onDraft={setDraft}
                      onOpen={() => beginEdit("imgUrl", selected.source.imgUrl)}
                      onCancel={() => setEditing(null)}
                      onSave={() => void saveEdit(selected)}
                    />
                  </dd>
                  <dt>标签</dt>
                  <dd>
                    <Editable
                      active={editing === "tags"}
                      draft={draft}
                      saving={saving}
                      multiline
                      text={selected.tags.join(", ")}
                      hint={selected.tagsModelVersion}
                      onDraft={setDraft}
                      onOpen={() => beginEdit("tags", selected.tags.join(", "))}
                      onCancel={() => setEditing(null)}
                      onSave={() => void saveEdit(selected)}
                    />
                  </dd>
                  <dt>向量</dt>
                  <dd>
                    <Editable
                      active={editing === "embedding"}
                      draft={draft}
                      saving={saving}
                      multiline
                      text={embeddingPreview(selected.embedding)}
                      hint={selected.embeddingModelVersion}
                      onDraft={setDraft}
                      onOpen={() =>
                        beginEdit("embedding", selected.embedding.join(", "))
                      }
                      onCancel={() => setEditing(null)}
                      onSave={() => void saveEdit(selected)}
                    />
                  </dd>
                  <dt>时间</dt>
                  <dd>{formatTime(selected.createdAt)}</dd>
                </dl>
                {items.length > 1 ? (
                  <div className="capture-picks">
                    {items.map((item) => {
                      const thumb = item.processedUrl ?? item.originalUrl;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={
                            item.id === selected.id
                              ? "capture-pick active"
                              : "capture-pick"
                          }
                          aria-label={
                            item.source.sourceUrl ||
                            item.source.imgUrl ||
                            item.id
                          }
                          onClick={() => {
                            setEditing(null);
                            setSelectedId(item.id);
                          }}
                        >
                          {thumb ? (
                            <img src={fileHref(thumb)} alt="" />
                          ) : (
                            <span className="capture-pick-missing">
                              {statusLabel(item.status)}
                            </span>
                          )}
                          <span>
                            <span className={`capture-badge ${item.status}`}>
                              {statusLabel(item.status)}
                            </span>
                            <span className="capture-pick-line">
                              {item.original.width && item.original.height
                                ? `${item.original.width}×${item.original.height}`
                                : item.id}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function Editable({
  active,
  draft,
  saving,
  text,
  hint,
  multiline,
  onDraft,
  onOpen,
  onCancel,
  onSave,
}: {
  active: boolean;
  draft: string;
  saving: boolean;
  text: string;
  hint?: string;
  multiline?: boolean;
  onDraft: (value: string) => void;
  onOpen: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (!active) {
    return (
      <button type="button" className="capture-field" onClick={onOpen}>
        <span>{text === "" ? "空" : text}</span>
        {hint ? <span className="capture-field-hint">{hint}</span> : null}
      </button>
    );
  }
  const fieldProps = {
    autoFocus: true,
    value: draft,
    disabled: saving,
    onChange: (event: { target: { value: string } }) =>
      onDraft(event.target.value),
    onKeyDown: (event: {
      key: string;
      metaKey: boolean;
      ctrlKey: boolean;
      preventDefault: () => void;
    }) => {
      if (event.key === "Escape") onCancel();
      if (
        event.key === "Enter" &&
        (!multiline || event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        onSave();
      }
    },
  };
  return (
    <span className="capture-field-edit">
      {multiline ? (
        <textarea rows={4} {...fieldProps} />
      ) : (
        <input {...fieldProps} />
      )}
      <span className="row">
        <button type="button" disabled={saving} onClick={onSave}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button type="button" className="quiet" onClick={onCancel}>
          取消
        </button>
      </span>
    </span>
  );
}

function statusLabel(status: string): string {
  if (status === "collected") return "已采集";
  if (status === "processed") return "已处理";
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已拒绝";
  return status;
}

function sizeText(item: ImageAsset): string {
  const original =
    item.original.width && item.original.height
      ? `${item.original.width}×${item.original.height}`
      : "";
  const processed =
    item.processed && item.processed.width && item.processed.height
      ? `${item.processed.width}×${item.processed.height}`
      : "";
  if (original && processed) return `${original} → ${processed}`;
  return original || processed || "—";
}

function embeddingPreview(values: number[]): string {
  if (values.length === 0) return "";
  const head = values.slice(0, 4).map((value) => value.toFixed(3));
  return values.length > 4 ? `${head.join(", ")} …` : head.join(", ");
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isPinterest(value: string): boolean {
  const text = value.trim();
  if (/^(pin\.it\/|pinterest\.|www\.pinterest\.|i\.pinimg\.)/i.test(text))
    return true;
  try {
    const host = new URL(text).hostname.toLowerCase();
    return (
      host === "pin.it" ||
      host.endsWith(".pin.it") ||
      host === "pinterest.com" ||
      host.endsWith(".pinterest.com") ||
      host === "pinimg.com" ||
      host.endsWith(".pinimg.com")
    );
  } catch {
    return false;
  }
}

function imageFiles(list: FileList | null): File[] {
  if (!list) return [];
  return [...list].filter(
    (file) =>
      file.type.startsWith("image/") ||
      /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.name),
  );
}

function imageFilesFromClipboard(data: DataTransfer): File[] {
  const listed = imageFiles(data.files);
  if (listed.length > 0) return listed;
  const found: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) found.push(file);
  }
  return found;
}

function urlsOnly(text: string): string[] | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const body = lines.some((line) => line.startsWith("#"))
    ? lines.filter((line) => line !== "" && !line.startsWith("#"))
    : lines.filter((line) => line !== "");
  const parts = body.flatMap((line) => line.split(/\s+/));
  if (parts.length === 0) return null;
  const urls = parts.filter((part) =>
    /^(https?:\/\/|pin\.it\/|pinterest\.|www\.pinterest\.|i\.pinimg\.)/i.test(
      part,
    ),
  );
  return urls.length === parts.length ? urls : null;
}
