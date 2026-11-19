"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";

import { Dialog } from "@/components/dialog";
import { NobgEraser } from "@/components/nobg-eraser";
import { isStyleVector, StyleRadar } from "@/components/style-radar";
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
  nobgUrl: string | null;
  thumbUrl: string | null;
  duplicate?: boolean;
}

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

type SlideKey = "raw" | "image" | "nobg";
type DownloadState = "queued" | "active" | "done" | "failed";

type DownloadTask = {
  id: number;
  url: string;
  key: string;
  imageKey: string;
  state: DownloadState;
};

type CutoutTask = {
  assetId: string;
  label: string;
  state: DownloadState;
};
type FinalVersion = "raw" | "processed" | "nobg";

type EditField = "sourceUrl" | "imgUrl" | "tags" | "embedding";

const STATUSES: ImageStatus[] = [
  "collected",
  "processed",
  "approved",
  "rejected",
];

export function CaptureBoard() {
  const [items, setItems] = useState<ImageAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [slide, setSlide] = useState<SlideKey>("image");
  const [erasing, setErasing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState<EditField | null>(null);
  const [statusFilter, setStatusFilter] = useState<ImageStatus[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [nearestOpen, setNearestOpen] = useState(false);
  const [nearestLoading, setNearestLoading] = useState(false);
  const [nearestError, setNearestError] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<NearestImage[] | null>(null);
  const [nearestCount, setNearestCount] = useState("10");
  const [nearestOrder, setNearestOrder] = useState<NearestOrder>("near");
  const nearestRequest = useRef(0);
  const knownIds = useRef<Set<string> | null>(null);
  const selectedRef = useRef(selectedId);
  const itemsRef = useRef<ImageAsset[]>([]);
  const downloadsRef = useRef<DownloadTask[]>([]);
  const downloadSeq = useRef(0);
  const pumping = useRef(false);
  const pumpGen = useRef(0);
  const addedCount = useRef(0);
  const duplicateCount = useRef(0);
  const hideDownloads = useRef<number | null>(null);
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const cutoutsRef = useRef<CutoutTask[]>([]);
  const cutoutPumping = useRef(false);
  const cutoutGen = useRef(0);
  const cutoutAdded = useRef(0);
  const cutoutSkipped = useRef(0);
  const hideCutouts = useRef<number | null>(null);
  const [cutouts, setCutouts] = useState<CutoutTask[]>([]);
  const [galleryBody, setGalleryBody] = useState<HTMLDivElement | null>(null);
  selectedRef.current = selectedId;
  itemsRef.current = items;

  const loadItems = useCallback(async () => {
    try {
      const body = await api<{ items: ImageAsset[] }>("capture/assets");
      const previous = knownIds.current;
      const arrived = previous
        ? body.items.filter((item) => !previous.has(item.id))
        : [];
      knownIds.current = new Set(body.items.map((item) => item.id));
      itemsRef.current = body.items;
      setItems(body.items);
      if (arrived[0]) setEditing(null);
      setSelectedId((cur) => {
        if (arrived[0]) return arrived[0].id;
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

  async function loadNearest(item: ImageAsset, count: number, order: NearestOrder) {
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
    setEditing(null);
    setErasing(false);
    setConfirmDelete(false);
    setSelectedId(id);
    closeNearest();
  }

  async function removeAsset(item: ImageAsset) {
    if (deleting) return;
    setDeleting(true);
    try {
      await api(`capture/assets/${item.id}`, { method: "DELETE" });
      setConfirmDelete(false);
      setErasing(false);
      setEditing(null);
      notify("已删除");
      await loadItems();
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
      await loadItems();
    } catch (err) {
      fail(messageOf(err));
    }
  }

  function publishCutouts() {
    setCutouts(cutoutsRef.current.map((task) => ({ ...task })));
  }

  function cutoutQueued(item: ImageAsset): boolean {
    const hash = item.original.hash;
    return cutoutsRef.current.some((task) => {
      if (task.state === "failed") return false;
      if (task.assetId === item.id) return true;
      const other = itemsRef.current.find((row) => row.id === task.assetId);
      return Boolean(hash && other?.original.hash === hash);
    });
  }

  function cutoutExists(item: ImageAsset): boolean {
    if (item.nobgUrl) return true;
    const hash = item.original.hash;
    if (!hash) return false;
    return itemsRef.current.some(
      (row) => row.id !== item.id && row.original.hash === hash && row.nobgUrl,
    );
  }

  function enqueueCutout(item: ImageAsset) {
    if (!item.processedUrl) return;
    if (item.nobgUrl) {
      if (selectedRef.current === item.id) setSlide("nobg");
      return;
    }
    if (cutoutQueued(item)) {
      notify("这张图已在移除队列里");
      return;
    }
    if (cutoutExists(item)) {
      notify("这张图已经移除过背景，已跳过");
      return;
    }
    if (hideCutouts.current !== null) {
      window.clearTimeout(hideCutouts.current);
      hideCutouts.current = null;
    }
    cutoutsRef.current = [
      ...cutoutsRef.current,
      {
        assetId: item.id,
        label: item.source.sourceUrl || item.source.imgUrl || item.id,
        state: "queued",
      },
    ];
    publishCutouts();
    void pumpCutouts();
  }

  async function pumpCutouts() {
    if (cutoutPumping.current) return;
    cutoutPumping.current = true;
    const gen = ++cutoutGen.current;
    try {
      for (;;) {
        const next = cutoutsRef.current.find((task) => task.state === "queued");
        if (!next) break;
        const current = itemsRef.current.find((row) => row.id === next.assetId);
        if (current && cutoutExists(current)) {
          cutoutsRef.current = cutoutsRef.current.filter(
            (task) => task.assetId !== next.assetId,
          );
          cutoutSkipped.current += 1;
          publishCutouts();
          continue;
        }
        next.state = "active";
        publishCutouts();
        try {
          await api(`capture/assets/${next.assetId}/nobg`, { method: "POST" });
          next.state = "done";
          cutoutAdded.current += 1;
          await loadItems();
          if (selectedRef.current === next.assetId) setSlide("nobg");
        } catch (err) {
          next.state = "failed";
          fail(messageOf(err));
        }
        publishCutouts();
      }
    } finally {
      cutoutPumping.current = false;
      if (cutoutsRef.current.some((task) => task.state === "queued")) {
        void pumpCutouts();
        return;
      }
      if (gen !== cutoutGen.current) return;
      const added = cutoutAdded.current;
      const skipped = cutoutSkipped.current;
      cutoutAdded.current = 0;
      cutoutSkipped.current = 0;
      if (added > 0) {
        notify(added === 1 ? "背景已移除" : `已移除 ${added} 张图的背景`);
      }
      if (skipped > 0) {
        notify(
          skipped === 1
            ? "这张图已经移除过背景，已跳过"
            : `${skipped} 张图已经移除过背景，已跳过`,
        );
      }
      if (
        cutoutsRef.current.some(
          (task) => task.state === "queued" || task.state === "active",
        )
      ) {
        return;
      }
      hideCutouts.current = window.setTimeout(() => {
        hideCutouts.current = null;
        if (
          cutoutsRef.current.some(
            (task) => task.state === "queued" || task.state === "active",
          )
        ) {
          return;
        }
        cutoutsRef.current = [];
        publishCutouts();
      }, 900);
    }
  }

  function publishDownloads() {
    setDownloads(downloadsRef.current.map((task) => ({ ...task })));
  }

  function knownUrlKeys(exceptId?: number): Set<string> {
    const keys = new Set<string>();
    for (const item of itemsRef.current) {
      if (item.source.sourceUrl) keys.add(urlKey(item.source.sourceUrl));
      if (item.source.imgUrl) keys.add(urlKey(item.source.imgUrl));
    }
    for (const task of downloadsRef.current) {
      if (task.id === exceptId || task.state === "failed") continue;
      keys.add(task.key);
      if (task.imageKey) keys.add(task.imageKey);
    }
    return keys;
  }

  function enqueueUrls(rawUrls: string[]) {
    const known = knownUrlKeys();
    const fresh: DownloadTask[] = [];
    let skipped = 0;
    for (const raw of rawUrls) {
      const url = raw.trim();
      if (url === "") continue;
      const key = urlKey(url);
      if (known.has(key)) {
        skipped += 1;
        continue;
      }
      known.add(key);
      downloadSeq.current += 1;
      fresh.push({
        id: downloadSeq.current,
        url,
        key,
        imageKey: isPinterest(url) ? "" : key,
        state: "queued",
      });
    }
    if (skipped > 0) {
      notify(
        skipped === 1
          ? "这个链接已经有了，已跳过"
          : `${skipped} 个链接已经有了，已跳过`,
      );
    }
    if (fresh.length === 0) return;
    if (hideDownloads.current !== null) {
      window.clearTimeout(hideDownloads.current);
      hideDownloads.current = null;
    }
    downloadsRef.current = [...downloadsRef.current, ...fresh];
    publishDownloads();
    setUrl("");
    void pumpDownloads();
  }

  async function runDownload(task: DownloadTask): Promise<"added" | "duplicate"> {
    let imgUrl = task.url;
    let sourceUrl = "";
    let sourceType: "manual" | "crawler" = "manual";
    if (isPinterest(task.url)) {
      const resolved = await api<{ imgUrl: string }>("capture/resolve", {
        method: "POST",
        body: JSON.stringify({ provider: "pinterest", url: task.url }),
      });
      imgUrl = resolved.imgUrl;
      sourceUrl = task.url;
      sourceType = "crawler";
      const imageKey = urlKey(imgUrl);
      task.imageKey = imageKey;
      if (knownUrlKeys(task.id).has(imageKey)) return "duplicate";
    }
    const body = await api<{ duplicate?: boolean }>("capture/collected", {
      method: "POST",
      body: JSON.stringify({ sourceType, sourceUrl, imgUrl }),
    });
    return body.duplicate ? "duplicate" : "added";
  }

  async function pumpDownloads() {
    if (pumping.current) return;
    pumping.current = true;
    const gen = ++pumpGen.current;
    try {
      for (;;) {
        const next = downloadsRef.current.find((task) => task.state === "queued");
        if (!next) break;
        next.state = "active";
        publishDownloads();
        try {
          const result = await runDownload(next);
          if (result === "duplicate") {
            downloadsRef.current = downloadsRef.current.filter(
              (task) => task.id !== next.id,
            );
            duplicateCount.current += 1;
          } else {
            next.state = "done";
            addedCount.current += 1;
            await loadItems();
          }
        } catch (err) {
          next.state = "failed";
          fail(messageOf(err));
        }
        publishDownloads();
      }
    } finally {
      pumping.current = false;
      if (downloadsRef.current.some((task) => task.state === "queued")) {
        void pumpDownloads();
        return;
      }
      if (gen !== pumpGen.current) return;
      const added = addedCount.current;
      const duplicates = duplicateCount.current;
      addedCount.current = 0;
      duplicateCount.current = 0;
      if (added > 0) {
        notify(
          added === 1
            ? "已下载原图，预处理进行中"
            : `已接收 ${added} 个链接，预处理进行中`,
        );
      }
      if (duplicates > 0) {
        notify(
          duplicates === 1
            ? "重复图片，已跳过"
            : `${duplicates} 个链接是重复图片，已跳过`,
        );
      }
      if (
        downloadsRef.current.some(
          (task) => task.state === "queued" || task.state === "active",
        )
      ) {
        return;
      }
      hideDownloads.current = window.setTimeout(() => {
        hideDownloads.current = null;
        if (
          downloadsRef.current.some(
            (task) => task.state === "queued" || task.state === "active",
          )
        ) {
          return;
        }
        downloadsRef.current = [];
        publishDownloads();
      }, 900);
    }
  }

  useEffect(() => {
    return () => {
      if (hideDownloads.current !== null) {
        window.clearTimeout(hideDownloads.current);
      }
      if (hideCutouts.current !== null) {
        window.clearTimeout(hideCutouts.current);
      }
    };
  }, []);

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
      if (added > 0) await loadItems();
    } finally {
      setSubmitting(false);
    }
  }

  function submitPin(event: FormEvent) {
    event.preventDefault();
    enqueueUrls([url]);
  }

  async function takeIncoming(files: File[], urls: string[] | null) {
    if (files.length > 0) await submitFiles(files);
    if (urls) enqueueUrls(urls);
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

  function takePaste(event: {
    clipboardData: DataTransfer | null;
    preventDefault(): void;
  }) {
    const data = event.clipboardData;
    if (!data) return;
    const files = imageFilesFromClipboard(data);
    const urls = files.length > 0 ? null : urlsOnly(data.getData("text/plain"));
    if (files.length === 0 && !urls) return;
    event.preventDefault();
    void takeIncoming(files, urls);
  }

  const onPasteRef = useRef(takePaste);
  onPasteRef.current = takePaste;

  useEffect(() => {
    function onPaste(event: globalThis.ClipboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return;
      }
      onPasteRef.current(event);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const doneCount = items.filter(
    (item) => item.status === "processed" || item.status === "approved",
  ).length;
  const processingCount = items.filter(
    (item) => item.status === "collected",
  ).length;
  const visible =
    statusFilter.length === 0
      ? items
      : items.filter((item) => statusFilter.includes(item.status));
  const selected = items.find((item) => item.id === selectedId) ?? null;

  function toggleStatus(status: ImageStatus) {
    setStatusFilter((cur) =>
      cur.includes(status)
        ? cur.filter((item) => item !== status)
        : [...cur, status],
    );
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      if (!selected || erasing) return;
      const order: SlideKey[] = [];
      if (selected.originalUrl) order.push("raw");
      if (selected.processedUrl) order.push("image");
      if (selected.nobgUrl) order.push("nobg");
      const index = order.indexOf(slide);
      const next =
        event.key === "ArrowLeft" ? order[index - 1] : order[index + 1];
      if (!next) return;
      event.preventDefault();
      setSlide(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, slide, erasing]);
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

  return (
    <>
      <div className="capture-split">
        <section className="panel capture-gallery">
          <div className="column-head">
            <h2>图库</h2>
            <span className="muted">
              完成 {doneCount}
              {processingCount > 0 ? ` · 处理中 ${processingCount}` : ""}
            </span>
          </div>
          <div className="capture-filters" role="group" aria-label="按状态筛选">
            {STATUSES.map((status) => {
              const on = statusFilter.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  className={on ? "active" : ""}
                  aria-pressed={on}
                  onClick={() => toggleStatus(status)}
                >
                  {statusLabel(status)}
                </button>
              );
            })}
          </div>
          <div className="capture-gallery-body" ref={setGalleryBody}>
            {!loaded ? (
              <p className="muted">加载中…</p>
            ) : items.length === 0 ? (
              <p className="muted">还没有图片。</p>
            ) : visible.length === 0 ? (
              <p className="muted">没有符合筛选的图片。</p>
            ) : (
              visible.map((item) => {
                const thumb = item.thumbUrl
                  ? `${item.thumbUrl}?v=${item.updatedAt}`
                  : (item.processedUrl ?? item.originalUrl);
                return (
                  <GalleryTile
                    key={item.id}
                    active={item.id === selected?.id}
                    label={item.source.sourceUrl || item.source.imgUrl || item.id}
                    root={galleryBody}
                    src={thumb ? fileHref(thumb) : null}
                    status={item.status}
                    onSelect={() => {
                      setEditing(null);
                      setErasing(false);
                      setConfirmDelete(false);
                      setSelectedId(item.id);
                    }}
                  />
                );
              })
            )}
          </div>
        </section>

        <section className="panel capture-stage">
          <div className="column-head">
            <h2>采集</h2>
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
                <div
                  className={
                    currentSlide?.key === "nobg"
                      ? "capture-hero alpha"
                      : "capture-hero"
                  }
                >
                  {erasing && selected.nobgUrl ? (
                    <NobgEraser
                      src={fileHref(`${selected.nobgUrl}?v=${selected.updatedAt}`)}
                      onCancel={() => setErasing(false)}
                      onSave={async (blob) => {
                        try {
                          await api(`capture/assets/${selected.id}/nobg`, {
                            method: "PUT",
                            body: blob,
                            headers: { "content-type": "image/png" },
                          });
                          notify("已写回移除背景的版本");
                          setErasing(false);
                          await loadItems();
                        } catch (err) {
                          fail(messageOf(err));
                          throw err;
                        }
                      }}
                    />
                  ) : currentSlide ? (
                    <img src={fileHref(currentSlide.href)} alt={selected.id} />
                  ) : (
                    <span className="capture-missing">
                      {selected.status === "collected" ? "处理中…" : "无图"}
                    </span>
                  )}
                  {selected.status === "approved" || erasing ? null : (
                    <div
                      className="capture-switch"
                      role="group"
                      aria-label="切换原始、预处理和移除背景"
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
                      <button
                        type="button"
                        className={currentSlide?.key === "nobg" ? "active" : ""}
                        disabled={
                          !selected.processedUrl ||
                          cutouts.some(
                            (task) =>
                              task.assetId === selected.id &&
                              (task.state === "queued" || task.state === "active"),
                          )
                        }
                        onClick={() => enqueueCutout(selected)}
                      >
                        {cutoutLabelFor(cutouts, selected.id)}
                      </button>
                      {currentSlide?.key === "nobg" ? (
                        <button type="button" onClick={() => setErasing(true)}>
                          擦除
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className="capture-stage-foot">
                  <p className="muted">拖到大图上或粘贴，可以继续采集。</p>
                  <span className="capture-size">{sizeText(selected)}</span>
                </div>
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
                  图片和链接都可以拖进来或粘贴。
                </p>
              </>
            )}
          </form>
        </section>

        <section className="panel capture-info">
          <div className="column-head">
            <h2>图像</h2>
          </div>
          <div className="capture-info-body">
            {!loaded ? (
              <p className="muted">加载中…</p>
            ) : !selected ? (
              <p className="muted">从左侧图库选择一张图片。</p>
            ) : (
              <>
                <div className="row capture-actions">
                  {selected.status === "processed" ? (
                    <>
                      <button
                        type="button"
                        className="quiet"
                        disabled={
                          selected.status !== "processed" ||
                          cutouts.some(
                            (task) =>
                              task.assetId === selected.id &&
                              (task.state === "queued" || task.state === "active"),
                          ) ||
                          erasing
                        }
                        onClick={() =>
                          void review(
                            selected,
                            "approve",
                            versionOf(currentSlide?.key),
                          )
                        }
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
                    </>
                  ) : null}
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
                <div className="style-radar-block">
                  <div className="style-radar-head">
                    <span>向量</span>
                    {editing !== "embedding" &&
                    isStyleVector(selected.embedding) ? (
                      <button
                        type="button"
                        className="style-radar-edit"
                        onClick={() =>
                          beginEdit(
                            "embedding",
                            selected.embedding.join(", "),
                          )
                        }
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
                      onOpen={() =>
                        beginEdit("embedding", selected.embedding.join(", "))
                      }
                      onCancel={() => setEditing(null)}
                      onSave={() => void saveEdit(selected)}
                    />
                  ) : isStyleVector(selected.embedding) ? (
                    <>
                      <StyleRadar values={selected.embedding} />
                      {selected.embeddingModelVersion ? (
                        <p className="style-radar-version">
                          {selected.embeddingModelVersion}
                        </p>
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
                      onOpen={() =>
                        beginEdit("embedding", selected.embedding.join(", "))
                      }
                      onCancel={() => setEditing(null)}
                      onSave={() => void saveEdit(selected)}
                    />
                  )}
                </div>
                <dl className="capture-meta">
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
                </dl>
              </>
            )}
          </div>
          {selected ? (
            <div className="capture-info-foot">
              <span className={`capture-badge ${selected.status}`}>
                {statusLabel(selected.status)}
              </span>
              <time dateTime={new Date(selected.createdAt).toISOString()}>
                {formatTime(selected.createdAt)}
              </time>
            </div>
          ) : null}
        </section>
      </div>
      {downloads.length > 0 ? (
        <div className="capture-downloads">
          <div
            className="capture-download-bar"
            role="progressbar"
            aria-label="下载进度"
            aria-valuemin={0}
            aria-valuemax={downloads.length}
            aria-valuenow={downloads.filter((task) => task.state === "done").length}
          >
            {downloads.map((task) => (
              <span
                key={task.id}
                className={`capture-download-seg ${task.state}`}
                title={task.url}
              />
            ))}
          </div>
          <p className="muted capture-download-label">{downloadLabel(downloads)}</p>
        </div>
      ) : null}
      {cutouts.length > 0 ? (
        <div className="capture-downloads">
          <div
            className="capture-download-bar"
            role="progressbar"
            aria-label="移除背景进度"
            aria-valuemin={0}
            aria-valuemax={cutouts.length}
            aria-valuenow={cutouts.filter((task) => task.state === "done").length}
          >
            {cutouts.map((task) => (
              <span
                key={task.assetId}
                className={`capture-download-seg ${task.state}`}
                title={task.label}
              />
            ))}
          </div>
          <p className="muted capture-download-label">{cutoutLabel(cutouts)}</p>
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
              const thumb = item.thumbUrl
                ? `${item.thumbUrl}?v=${item.updatedAt}`
                : null;
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

function versionOf(key: SlideKey | undefined): FinalVersion {
  if (key === "raw") return "raw";
  if (key === "nobg") return "nobg";
  return "processed";
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

function GalleryTile({
  active,
  label,
  root,
  src,
  status,
  onSelect,
}: {
  active: boolean;
  label: string;
  root: HTMLElement | null;
  src: string | null;
  status: ImageStatus;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!root) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root, rootMargin: "280px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  return (
    <button
      ref={ref}
      type="button"
      className={active ? "capture-tile active" : "capture-tile"}
      aria-label={label}
      onClick={onSelect}
    >
      {src && near ? (
        <img src={src} alt="" decoding="async" />
      ) : src ? (
        <span className="capture-tile-pending" />
      ) : (
        <span className="capture-tile-missing">{statusLabel(status)}</span>
      )}
      <span className={`capture-badge ${status}`}>{statusLabel(status)}</span>
    </button>
  );
}

function cutoutLabelFor(tasks: CutoutTask[], assetId: string): string {
  const task = tasks.find((item) => item.assetId === assetId);
  if (task?.state === "active") return "移除中…";
  if (task?.state === "queued") return "排队中…";
  return "移除背景";
}

function cutoutLabel(tasks: CutoutTask[]): string {
  const total = tasks.length;
  const done = tasks.filter((task) => task.state === "done").length;
  const queued = tasks.filter((task) => task.state === "queued").length;
  const failed = tasks.filter((task) => task.state === "failed").length;
  const active = tasks.some((task) => task.state === "active");
  if (queued > 0) return `正在移除背景 ${done + 1}/${total}，还有 ${queued} 个在排队`;
  if (active) return `正在移除背景 ${done + 1}/${total}`;
  if (failed > 0) return `移除结束，${failed} 个没有完成`;
  return `已移除 ${done}/${total}`;
}

function downloadLabel(tasks: DownloadTask[]): string {
  const total = tasks.length;
  const done = tasks.filter((task) => task.state === "done").length;
  const queued = tasks.filter((task) => task.state === "queued").length;
  const failed = tasks.filter((task) => task.state === "failed").length;
  const active = tasks.some((task) => task.state === "active");
  if (queued > 0) return `正在下载 ${done + 1}/${total}，还有 ${queued} 个在排队`;
  if (active) return `正在下载 ${done + 1}/${total}`;
  if (failed > 0) return `下载结束，${failed} 个没有下下来`;
  return `已下载 ${done}/${total}`;
}

function urlKey(value: string): string {
  const text = value.trim();
  try {
    const url = new URL(text);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    const host = url.hostname;
    if (
      host === "pin.it" ||
      host.endsWith(".pin.it") ||
      host === "pinterest.com" ||
      host.endsWith(".pinterest.com") ||
      host === "pinimg.com" ||
      host.endsWith(".pinimg.com")
    ) {
      url.search = "";
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return text;
  }
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
