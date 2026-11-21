"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Dataset } from "@/components/datasets";
import { Dialog } from "@/components/dialog";
import {
  RATINGS,
  ratingLabel,
  sizeText,
  statusLabel,
  type FinalVersion,
  type ImageAsset,
  type ImageRating,
  type SlideKey,
} from "@/components/image-assets";
import { isStyleVector, StyleRadar } from "@/components/style-radar";
import { api, fileHref } from "@/lib/api";
import { ZoomImage } from "@/components/zoom-image";
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
  browse = false,
  nearest = true,
  galleryIds = [],
  approveVersion = "processed",
  erasing = false,
  cutoutBusy = false,
  hotkeys = false,
  toDice = false,
  onSelect,
  onReload,
  onChanged,
  onPickTag,
  datasets,
}: {
  loaded: boolean;
  selected: ImageAsset | null;
  preview?: boolean;
  browse?: boolean;
  nearest?: boolean;
  galleryIds?: string[];
  approveVersion?: FinalVersion;
  erasing?: boolean;
  cutoutBusy?: boolean;
  hotkeys?: boolean;
  toDice?: boolean;
  onSelect: (id: string) => void;
  onReload: () => Promise<void>;
  onChanged?: () => void;
  onPickTag?: (tag: string) => void;
  datasets?: {
    items: Dataset[];
    focusId: string | null;
    onToggle: (datasetId: string, assetId: string, member: boolean) => void;
  };
}) {
  const router = useRouter();
  const [diceBusy, setDiceBusy] = useState(false);
  const [slide, setSlide] = useState<SlideKey>("image");
  const [editing, setEditing] = useState<EditField | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [nearestOpen, setNearestOpen] = useState(false);
  const [nearestLoading, setNearestLoading] = useState(false);
  const [nearestError, setNearestError] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<NearestImage[] | null>(null);
  const [nearestCount, setNearestCount] = useState("10");
  const [nearestOrder, setNearestOrder] = useState<NearestOrder>("near");
  const nearestRequest = useRef(0);
  const selectedId = selected?.id ?? null;
  const datasetItems = datasets?.items;
  const membership = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of datasetItems ?? []) map.set(item.id, new Set(item.assetIds));
    return map;
  }, [datasetItems]);

  useEffect(() => {
    nearestRequest.current += 1;
    setNearestOpen(false);
    setNearestLoading(false);
    setNeighbors(null);
    setNearestError(null);
    setEditing(null);
    setConfirmDelete(false);
    setSlide("image");
    if (!selectedId) setZoom(false);
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

  async function saveRating(item: ImageAsset, rating: ImageRating) {
    if (saving || item.rating === rating) return;
    setSaving(true);
    try {
      await api(`capture/assets/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({ rating }),
      });
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

  async function sendToDice(item: ImageAsset) {
    if (diceBusy) return;
    setDiceBusy(true);
    try {
      const res = await api<{ id: string }>("dice/tags2intent", {
        method: "POST",
        body: JSON.stringify({ imageId: item.id }),
      });
      router.push(`/dice?rid=${res.id}`);
    } catch (err) {
      fail(messageOf(err));
    } finally {
      setDiceBusy(false);
    }
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

  const reviewing = useRef(false);

  async function review(
    item: ImageAsset,
    action: "approve" | "reject",
    version?: FinalVersion,
  ) {
    if (reviewing.current) return;
    reviewing.current = true;
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
    } finally {
      reviewing.current = false;
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

  const hotkeyState = useRef({
    selected,
    version,
    erasing,
    cutoutBusy,
    deleting,
    confirmDelete,
    nearestOpen,
    zoom,
  });
  hotkeyState.current = {
    selected,
    version,
    erasing,
    cutoutBusy,
    deleting,
    confirmDelete,
    nearestOpen,
    zoom,
  };
  const hotkeyActions = useRef({ saveRating, review });
  hotkeyActions.current = { saveRating, review };

  useEffect(() => {
    if (!hotkeys) return;
    function onKey(event: KeyboardEvent) {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      const state = hotkeyState.current;
      const item = state.selected;
      if (!item || state.erasing || state.confirmDelete || state.nearestOpen || state.zoom) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const index = RATINGS.indexOf((item.rating ?? "") as ImageRating);
        const nextIndex =
          event.key === "ArrowRight" ? (index < 0 ? 0 : index + 1) : index - 1;
        const next = RATINGS[nextIndex];
        if (!next || next === item.rating) return;
        event.preventDefault();
        void hotkeyActions.current.saveRating(item, next);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (item.status === "processed" && !state.cutoutBusy) {
          void hotkeyActions.current.review(item, "approve", state.version);
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (item.status === "processed") {
          void hotkeyActions.current.review(item, "reject");
        }
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        if (!state.deleting) setConfirmDelete(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys]);

  const browseIndex = selected ? galleryIds.indexOf(selected.id) : -1;

  function stepGallery(delta: number) {
    if (browseIndex < 0) return;
    const nextId = galleryIds[browseIndex + delta];
    if (!nextId) return;
    onSelect(nextId);
  }

  useEffect(() => {
    if (!preview || zoom) return;
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
  }, [preview, zoom, selected, slide]);

  useEffect(() => {
    if (!browse || !zoom) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      if (browseIndex < 0) return;
      const nextId =
        event.key === "ArrowLeft"
          ? galleryIds[browseIndex - 1]
          : galleryIds[browseIndex + 1];
      if (!nextId) return;
      event.preventDefault();
      onSelect(nextId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [browse, zoom, browseIndex, galleryIds, onSelect]);

  return (
    <section className={preview ? "panel capture-info image-detail" : "panel capture-info"}>
      {selected ? (
        <div className="image-detail-corner">
          {toDice ? (
            <button
              type="button"
              className="quiet"
              title="用这张图的标签作为 dice 起点"
              disabled={diceBusy || deleting || erasing || selected.tags.length === 0}
              onClick={() => void sendToDice(selected)}
            >
              {diceBusy ? "…" : "🧠"}
            </button>
          ) : null}
          {nearest ? (
            <button
              type="button"
              className="quiet"
              disabled={deleting || erasing || !hasVector(selected.embedding)}
              title={hasVector(selected.embedding) ? "最接近的图" : "还没有向量"}
              onClick={() => void openNearest(selected)}
            >
              接近
            </button>
          ) : null}
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
          {currentSlide && browse ? (
            <button
              type="button"
              className="image-detail-open"
              aria-label="查看大图"
              onClick={() => setZoom(true)}
            >
              <img src={fileHref(currentSlide.href)} alt={selected.id} />
            </button>
          ) : currentSlide ? (
            // 非浏览态没有大图翻页，直接用统一放大组件
            <ZoomImage src={fileHref(currentSlide.href)} alt={selected.id} eager />
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
            {datasets ? (
              <DatasetMembership
                items={datasets.items}
                focusId={datasets.focusId}
                assetId={selected.id}
                membership={membership}
                onToggle={datasets.onToggle}
              />
            ) : null}
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
              <dt>分级</dt>
              <dd>
                <div className="capture-filters" role="group" aria-label="调整分级">
                  {RATINGS.map((rating) => {
                    const on = selected.rating === rating;
                    return (
                      <button
                        key={rating}
                        type="button"
                        className={on ? "active" : ""}
                        aria-pressed={on}
                        disabled={saving}
                        onClick={() => void saveRating(selected, rating)}
                      >
                        {ratingLabel(rating)}
                      </button>
                    );
                  })}
                </div>
              </dd>
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
      {browse && zoom && selected ? (
        <Dialog
          open
          className="image-lightbox"
          title={
            browseIndex >= 0
              ? `大图 · ${browseIndex + 1} / ${galleryIds.length}`
              : "大图"
          }
          onClose={() => setZoom(false)}
        >
          <div
            className={
              currentSlide?.key === "nobg"
                ? "image-lightbox-stage alpha"
                : "image-lightbox-stage"
            }
          >
            <button
              type="button"
              className="quiet icon image-lightbox-nav prev"
              aria-label="上一张"
              title="上一张"
              disabled={browseIndex <= 0}
              onClick={() => stepGallery(-1)}
            >
              <ChevronLeft size={22} />
            </button>
            {currentSlide ? (
              <img src={fileHref(currentSlide.href)} alt={selected.id} />
            ) : (
              <span className="capture-missing">无图</span>
            )}
            <button
              type="button"
              className="quiet icon image-lightbox-nav next"
              aria-label="下一张"
              title="下一张"
              disabled={browseIndex < 0 || browseIndex >= galleryIds.length - 1}
              onClick={() => stepGallery(1)}
            >
              <ChevronRight size={22} />
            </button>
          </div>
        </Dialog>
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
                    <ZoomImage src={fileHref(thumb)} alt={item.id} zoomOn="double" />
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

function DatasetMembership({
  items,
  focusId,
  assetId,
  membership,
  onToggle,
}: {
  items: Dataset[];
  focusId: string | null;
  assetId: string;
  membership: Map<string, Set<string>>;
  onToggle: (datasetId: string, assetId: string, member: boolean) => void;
}) {
  const ordered =
    focusId === null
      ? items
      : [...items].sort((left, right) => {
          if (left.id === focusId) return -1;
          if (right.id === focusId) return 1;
          return 0;
        });
  return (
    <div className="dataset-membership">
      <div className="style-radar-head">
        <span>数据集</span>
      </div>
      {items.length === 0 ? (
        <p className="muted">还没有数据集。在左侧新建一个。</p>
      ) : (
        <div className="capture-filters" role="group" aria-label="加入或移出数据集">
          {ordered.map((item) => {
            const on = membership.get(item.id)?.has(assetId) ?? false;
            return (
              <button
                key={item.id}
                type="button"
                className={
                  (on ? "active" : "") + (item.id === focusId ? " dataset-focus" : "")
                }
                aria-pressed={on}
                title={on ? `从「${item.name}」移出` : `加入「${item.name}」`}
                onClick={() => onToggle(item.id, assetId, on)}
              >
                {item.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
