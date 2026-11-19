"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";

import { ImageDetail } from "@/components/image-detail";
import { ImageGallery } from "@/components/image-gallery";
import {
  sizeText,
  useImageAssets,
  type FinalVersion,
  type ImageAsset,
  type SlideKey,
} from "@/components/image-assets";
import { NobgEraser } from "@/components/nobg-eraser";
import { api, fileHref } from "@/lib/api";
import { fail, messageOf, notify } from "@/lib/notify";

type DownloadState = "queued" | "active" | "done" | "failed";

type DownloadTask = {
  id: number;
  url: string;
  key: string;
  imageKey: string;
  state: DownloadState;
  imgUrl?: string;
};

type CutoutTask = {
  assetId: string;
  label: string;
  state: DownloadState;
};

export function CaptureBoard() {
  const images = useImageAssets();
  const items = images.items;
  const loaded = images.loaded;
  const selected = images.selected;
  const loadItems = images.loadItems;
  const itemsRef = images.itemsRef;
  const selectedRef = images.selectedRef;
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [slide, setSlide] = useState<SlideKey>("image");
  const [erasing, setErasing] = useState(false);
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
        imageKey: needsResolve(url) ? "" : key,
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

  function enqueueResolved(sourceUrl: string, imgUrls: string[]) {
    if (imgUrls.length === 0) return;
    const known = knownUrlKeys();
    const fresh: DownloadTask[] = [];
    for (const imgUrl of imgUrls) {
      const key = urlKey(imgUrl);
      if (known.has(key)) continue;
      known.add(key);
      downloadSeq.current += 1;
      fresh.push({
        id: downloadSeq.current,
        url: sourceUrl,
        key,
        imageKey: key,
        imgUrl,
        state: "queued",
      });
    }
    if (fresh.length === 0) return;
    downloadsRef.current = [...downloadsRef.current, ...fresh];
    publishDownloads();
  }

  async function runDownload(task: DownloadTask): Promise<"added" | "duplicate"> {
    let imgUrl = task.imgUrl || task.url;
    let sourceUrl = "";
    let sourceType: "manual" | "crawler" = "manual";
    if (task.imgUrl || needsResolve(task.url)) {
      if (!task.imgUrl) {
        const provider = isPixiv(task.url) ? "pixiv" : "pinterest";
        const resolved = await api<{ imgUrl: string; imgUrls?: string[] }>(
          "capture/resolve",
          {
            method: "POST",
            body: JSON.stringify({ provider, url: task.url }),
          },
        );
        const list = (resolved.imgUrls ?? []).filter((item) => item.trim() !== "");
        const urls = list.length > 0 ? list : [resolved.imgUrl];
        const first = urls[0];
        if (!first) throw new Error("没有解析出图片");
        imgUrl = first;
        enqueueResolved(task.url, urls.slice(1));
      }
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
        <ImageGallery
          advanceProcessed
          items={items}
          loaded={loaded}
          selectedId={selected?.id ?? null}
          onSelect={(id) => {
            setErasing(false);
            images.select(id);
          }}
        />

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
                    placeholder="拖拽或粘贴图片、Pinterest / Pixiv 链接"
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
                  图片和链接都可以拖进来或粘贴。Pixiv 作品页会收下每一页原图。
                </p>
              </>
            )}
          </form>
        </section>

        <ImageDetail
          hotkeys
          loaded={loaded}
          selected={selected}
          approveVersion={versionOf(currentSlide?.key)}
          erasing={erasing}
          cutoutBusy={
            selected
              ? cutouts.some(
                  (task) =>
                    task.assetId === selected.id &&
                    (task.state === "queued" || task.state === "active"),
                )
              : false
          }
          onSelect={(id) => {
            setErasing(false);
            images.select(id);
          }}
          onReload={loadItems}
          onChanged={() => setErasing(false)}
        />
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
    </>
  );
}

function versionOf(key: SlideKey | undefined): FinalVersion {
  if (key === "raw") return "raw";
  if (key === "nobg") return "nobg";
  return "processed";
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

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isPinterestHost(host: string): boolean {
  return (
    host === "pin.it" ||
    host.endsWith(".pin.it") ||
    host === "pinterest.com" ||
    host.endsWith(".pinterest.com") ||
    host === "pinimg.com" ||
    host.endsWith(".pinimg.com")
  );
}

function isPixivHost(host: string): boolean {
  return host === "pixiv.net" || host.endsWith(".pixiv.net");
}

function isPximgHost(host: string): boolean {
  return host === "pximg.net" || host.endsWith(".pximg.net");
}

function pixivArtworkId(url: URL): string | null {
  const fromPath = /\/artworks\/(\d+)/.exec(url.pathname);
  if (fromPath?.[1]) return fromPath[1];
  const illustId = url.searchParams.get("illust_id");
  if (illustId && /^\d+$/.test(illustId)) return illustId;
  return null;
}

function urlKey(value: string): string {
  const text = value.trim();
  try {
    const url = new URL(text);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    const host = url.hostname;
    if (isPixivHost(host)) {
      const id = pixivArtworkId(url);
      if (id) return `https://www.pixiv.net/artworks/${id}`;
    }
    if (isPinterestHost(host) || isPixivHost(host) || isPximgHost(host)) {
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
  const host = hostOf(text);
  return host ? isPinterestHost(host) : false;
}

function isPixiv(value: string): boolean {
  const text = value.trim();
  if (/^(pixiv\.net\/|www\.pixiv\.net\/|i\.pximg\.)/i.test(text)) return true;
  const host = hostOf(text);
  return host ? isPixivHost(host) || isPximgHost(host) : false;
}

function needsResolve(value: string): boolean {
  return isPinterest(value) || isPixiv(value);
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
    /^(https?:\/\/|pin\.it\/|pinterest\.|www\.pinterest\.|i\.pinimg\.|pixiv\.net\/|www\.pixiv\.net\/|i\.pximg\.)/i.test(
      part,
    ),
  );
  return urls.length === parts.length ? urls : null;
}
