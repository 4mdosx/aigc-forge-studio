"use client";

import { useEffect, useRef, useState } from "react";

import { Dialog } from "@/components/dialog";
import {
  sizeText,
  statusLabel,
  type FinalVersion,
  type ImageAsset,
  type SlideKey,
} from "@/components/image-assets";
import { isStyleVector, StyleRadar } from "@/components/style-radar";
import { api, fileHref } from "@/lib/api";
import { fail, messageOf, notify } from "@/lib/notify";

type NearestOrder = "near" | "far";

interface NearestImage {
  id: string;
  cosine: number;
  l2: number;
  thumbUrl: string | null;
  processedUrl: string | null;
  originalUrl: string;
  updatedAt: number;
}

type EditField = "sourceUrl" | "imgUrl" | "tags" | "embedding";

export function ImageDetail({
  loaded,
  selected,
  preview = false,
  approveVersion = "processed",
  erasing = false,
  cutoutBusy = false,
  onSelect,
  onReload,
  onChanged,
  onPickTag,
}: {
  loaded: boolean;
  selected: ImageAsset | null;
  preview?: boolean;
  approveVersion?: FinalVersion;
  erasing?: boolean;
  cutoutBusy?: boolean;
  onSelect: (id: string) => void;
  onReload: () => Promise<void>;
  onChanged?: () => void;
  onPickTag?: (tag: string) => void;
}) {
  const [slide, setSlide] = useState<SlideKey>("image");
  const [editing, setEditing] = useState<EditField | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [nearestOpen, setNearestOpen] = useState(false);
  const [nearestLoading, setNearestLoading] = useState(false);
  const [nearestError, setNearestError] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<NearestImage[] | null>(null);
  const [nearestCount, setNearestCount] = useState("10");
  const [nearestOrder, setNearestOrder] = useState<NearestOrder>("near");
  const nearestRequest = useRef(0);
  const selectedId = selected?.id ?? null;

  useEffect(() => {
    nearestRequest.current += 1;
    setNearestOpen(false);
    setNearestLoading(false);
    setNeighbors(null);
    setNearestError(null);
    setEditing(null);
    setConfirmDelete(false);
    setSlide("image");
  }, [selectedId]);

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
      await onReload();
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  function closeNearest() {
    nearestRequest.current += 1;
    setNearestOpen(false);
  }

  function openNearest(item: ImageAsset) {
    setNearestCount("10");
    setNearestOrder("near");
    void loadNearest(item, 10, "near");
  }

  function searchNearest(item: ImageAsset, order: NearestOrder) {
    const count = nearestLimit(nearestCount);
    if (count === null) {
      setNearestError("数量必须是正整数");
      return;
    }
    setNearestOrder(order);
    void loadNearest(item, count, order);
  }

  async function loadNearest(
    item: ImageAsset,
    count: number,
    order: NearestOrder,
  ) {
    const ticket = nearestRequest.current + 1;
    nearestRequest.current = ticket;
    setConfirmDelete(false);
    setNearestOpen(true);
    setNearestLoading(true);
    setNearestError(null);
    setNeighbors(null);
    try {
      const body = await api<{ neighbors: NearestImage[] }>(
        `capture/assets/${item.id}/nearest?k=${count}&order=${order}`,
      );
      if (ticket !== nearestRequest.current) return;
      setNeighbors(body.neighbors);
    } catch (err) {
      if (ticket !== nearestRequest.current) return;
      setNearestError(messageOf(err));
    } finally {
      if (ticket === nearestRequest.current) setNearestLoading(false);
    }
  }

  function chooseNeighbor(id: string) {
    closeNearest();
    onSelect(id);
  }

  async function removeAsset(item: ImageAsset) {
    if (deleting) return;
    setDeleting(true);
    try {
      await api(`capture/assets/${item.id}`, { method: "DELETE" });
      setConfirmDelete(false);
      onChanged?.();
      notify("已删除");
      await onReload();
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setDeleting(false);
    }
  }

  async function review(
    item: ImageAsset,
    action: "approve" | "reject",
    version?: FinalVersion,
  ) {
    try {
      await api(`capture/assets/${item.id}/${action}`, {
        method: "POST",
        body:
          action === "approve"
            ? JSON.stringify({ version: version ?? "processed" })
            : undefined,
      });
      notify(action === "approve" ? "已通过，当前版本写入资产" : "已拒绝");
      await onReload();
    } catch (err) {
      fail(messageOf(err));
    }
  }

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
        selected.nobgUrl
          ? {
              key: "nobg" as const,
              label: "移除背景",
              href: `${selected.nobgUrl}?v=${selected.updatedAt}`,
            }
          : null,
      ].filter((item) => item !== null)
    : [];
  const currentSlide =
    slides.find((item) => item.key === slide) ??
    slides.find((item) => item.key === "image") ??
    slides[0] ??
    null;
  const version = preview ? versionOf(currentSlide?.key) : approveVersion;

  useEffect(() => {
    if (!preview) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      if (!selected) return;
      const order: SlideKey[] = [];
      if (selected.originalUrl) order.push("raw");
      if (selected.processedUrl) order.push("image");
      if (selected.nobgUrl) order.push("nobg");
      const shown =
        order.find((key) => key === slide) ??
        order.find((key) => key === "image") ??
        order[0];
      const index = order.indexOf(shown);
      const next = event.key === "ArrowLeft" ? order[index - 1] : order[index + 1];
      if (!next) return;
      event.preventDefault();
      setSlide(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, selected, slide]);

  return (
    <section className={preview ? "panel capture-info image-detail" : "panel capture-info"}>
      {selected ? (
        <div className="image-detail-corner">
          <button
            type="button"
            className="quiet"
            disabled={deleting || erasing || !hasVector(selected.embedding)}
            title={hasVector(selected.embedding) ? "最接近的图" : "还没有向量"}
            onClick={() => void openNearest(selected)}
          >
            接近
          </button>
          <button
            type="button"
            className="quiet"
            disabled={deleting || erasing}
            onClick={() => setConfirmDelete(true)}
          >
            删除
          </button>
        </div>
      ) : null}
      <div className="column-head">
        <h2>图像</h2>
      </div>
      {preview && selected ? (
        <div
          className={
            currentSlide?.key === "nobg"
              ? "capture-hero alpha image-detail-hero"
              : "capture-hero image-detail-hero"
          }
        >
          {currentSlide ? (
            <img src={fileHref(currentSlide.href)} alt={selected.id} />
          ) : (
            <span className="capture-missing">
              {selected.status === "collected" ? "处理中…" : "无图"}
            </span>
          )}
        </div>
      ) : null}
      <div className="capture-info-body">
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : !selected ? (
          <p className="muted">从左侧图库选择一张图片。</p>
        ) : (
          <>
            {selected.status === "processed" ? (
              <div className="row capture-actions">
                <button
                  type="button"
                  className="quiet"
                  disabled={cutoutBusy || erasing}
                  onClick={() => void review(selected, "approve", version)}
                >
                  通过
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => void review(selected, "reject")}
                >
                  拒绝
                </button>
              </div>
            ) : null}
            <div className="style-radar-block">
              <div className="style-radar-head">
                <span>向量</span>
                {editing !== "embedding" && isStyleVector(selected.embedding) ? (
                  <button
                    type="button"
                    className="style-radar-edit"
                    onClick={() => beginEdit("embedding", selected.embedding.join(", "))}
                  >
                    编辑
                  </button>
                ) : null}
              </div>
              {editing === "embedding" ? (
                <Editable
                  active
                  draft={draft}
                  saving={saving}
                  multiline
                  text={embeddingPreview(selected.embedding)}
                  hint={selected.embeddingModelVersion}
                  onDraft={setDraft}
                  onOpen={() => beginEdit("embedding", selected.embedding.join(", "))}
                  onCancel={() => setEditing(null)}
                  onSave={() => void saveEdit(selected)}
                />
              ) : isStyleVector(selected.embedding) ? (
                <>
                  <StyleRadar values={selected.embedding} />
                  {selected.embeddingModelVersion ? (
                    <p className="style-radar-version">{selected.embeddingModelVersion}</p>
                  ) : null}
                </>
              ) : (
                <Editable
                  active={false}
                  draft={draft}
                  saving={saving}
                  multiline
                  text={embeddingPreview(selected.embedding)}
                  hint={selected.embeddingModelVersion}
                  onDraft={setDraft}
                  onOpen={() => beginEdit("embedding", selected.embedding.join(", "))}
                  onCancel={() => setEditing(null)}
                  onSave={() => void saveEdit(selected)}
                />
              )}
            </div>
            <dl className="capture-meta">
              <dt>标签</dt>
              <dd>
                {onPickTag && editing !== "tags" ? (
                  <div className="capture-tag-picks">
                    {selected.tags.length === 0 ? (
                      <span className="muted">空</span>
                    ) : (
                      <div className="capture-filters" role="group" aria-label="图片标签">
                        {selected.tags.map((tag, index) => (
                          <button
                            key={`${tag}-${index}`}
                            type="button"
                            onClick={() => onPickTag(tag)}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="capture-tag-edit"
                      onClick={() => beginEdit("tags", selected.tags.join(", "))}
                    >
                      编辑
                    </button>
                    {selected.tagsModelVersion ? (
                      <span className="capture-field-hint">{selected.tagsModelVersion}</span>
                    ) : null}
                  </div>
                ) : (
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
                )}
              </dd>
              <dt>源地址</dt>
              <dd>
                <Editable
                  active={editing === "sourceUrl"}
                  draft={draft}
                  saving={saving}
                  text={selected.source.sourceUrl}
                  onDraft={setDraft}
                  onOpen={() => beginEdit("sourceUrl", selected.source.sourceUrl)}
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
            </dl>
          </>
        )}
      </div>
      {selected ? (
        <div className="capture-info-foot">
          {preview ? <span className="capture-size">{sizeText(selected)}</span> : null}
          <span className={`capture-badge ${selected.status}`}>
            {statusLabel(selected.status)}
          </span>
          <time dateTime={new Date(selected.createdAt).toISOString()}>
            {formatTime(selected.createdAt)}
          </time>
        </div>
      ) : null}
      <Dialog
        open={nearestOpen}
        title={nearestOrder === "far" ? "最远" : "最近"}
        onClose={closeNearest}
      >
        <form
          className="nearest-query"
          onSubmit={(event) => {
            event.preventDefault();
            const submitter = (event.nativeEvent as SubmitEvent).submitter;
            const order =
              submitter instanceof HTMLButtonElement && submitter.value === "far"
                ? "far"
                : "near";
            if (selected) searchNearest(selected, order);
          }}
        >
          <label className="nearest-count">
            数量
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={nearestCount}
              onChange={(event) => setNearestCount(event.target.value)}
            />
          </label>
          <button
            type="submit"
            value="near"
            className={nearestOrder === "near" ? "quiet active" : "quiet"}
            disabled={nearestLoading || !selected}
          >
            最近
          </button>
          <button
            type="submit"
            value="far"
            className={nearestOrder === "far" ? "quiet active" : "quiet"}
            disabled={nearestLoading || !selected}
          >
            最远
          </button>
        </form>
        {nearestLoading ? <p className="muted">查找中…</p> : null}
        {nearestError ? <p>{nearestError}</p> : null}
        {neighbors && neighbors.length === 0 ? (
          <p className="muted">没有其它带向量的图片。</p>
        ) : null}
        {neighbors && neighbors.length > 0 ? (
          <div className="nearest-grid">
            {neighbors.map((item) => {
              const thumb = item.thumbUrl ? `${item.thumbUrl}?v=${item.updatedAt}` : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="nearest-tile"
                  onClick={() => chooseNeighbor(item.id)}
                >
                  {thumb ? (
                    <img src={fileHref(thumb)} alt="" />
                  ) : (
                    <span className="nearest-missing">无图</span>
                  )}
                  <span className="nearest-score">{item.cosine.toFixed(3)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={confirmDelete && selected !== null}
        title="删除图像"
        onClose={() => {
          if (!deleting) setConfirmDelete(false);
        }}
      >
        <p>图像文件和这条记录都会删掉，不能恢复。</p>
        <div className="row">
          <button
            type="button"
            className="quiet"
            disabled={deleting}
            onClick={() => setConfirmDelete(false)}
          >
            取消
          </button>
          <button
            type="button"
            disabled={deleting || !selected}
            onClick={() => {
              if (selected) void removeAsset(selected);
            }}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
        </div>
      </Dialog>
    </section>
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
    onChange: (event: { target: { value: string } }) => onDraft(event.target.value),
    onKeyDown: (event: {
      key: string;
      metaKey: boolean;
      ctrlKey: boolean;
      preventDefault: () => void;
    }) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onSave();
      }
    },
  };
  return (
    <span className="capture-field-edit">
      {multiline ? <textarea rows={4} {...fieldProps} /> : <input {...fieldProps} />}
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

function versionOf(key: SlideKey | undefined): FinalVersion {
  if (key === "raw") return "raw";
  if (key === "nobg") return "nobg";
  return "processed";
}

function nearestLimit(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw.trim())) return null;
  const count = Number(raw);
  return Number.isSafeInteger(count) ? count : null;
}

function hasVector(values: number[]): boolean {
  return (
    values.length > 0 &&
    values.every((value) => Number.isFinite(value)) &&
    values.some((value) => value !== 0)
  );
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
