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
import { connectCaptureLive } from "@/lib/capture-live";
import { fail, messageOf, notify } from "@/lib/notify";
import { isSafetyHiddenRating, useSafetyMode } from "@/lib/safety-mode";

type TaskKind = "download" | "nobg";
type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

type CaptureTask = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  url: string;
  imgUrl: string;
  dedupeKey: string;
  assetId: string | null;
  liveId: string | null;
  label: string;
  attempts: number;
  maxAttempts: number;
  nextRunAt: number;
  error: string | null;
  result: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

type TaskList = {
  counts: Record<TaskKind, Record<TaskStatus, number>>;
  items: CaptureTask[];
};

const TERMINAL: TaskStatus[] = ["done", "failed", "skipped"];
const SEG_CLASS: Record<TaskStatus, string> = {
  pending: "queued",
  running: "active",
  done: "done",
  failed: "failed",
  skipped: "done",
};

export function CaptureBoard() {
  const images = useImageAssets();
  const safety = useSafetyMode();
  const items = images.items;
  const loaded = images.loaded;
  const selected =
    safety.ready &&
    images.selected &&
    !(safety.enabled && isSafetyHiddenRating(images.selected.rating))
      ? images.selected
      : null;
  const loadItems = images.loadItems;
  const selectedRef = images.selectedRef;
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [slide, setSlide] = useState<SlideKey>("image");
  const [erasing, setErasing] = useState(false);
  const [tasks, setTasks] = useState<CaptureTask[]>([]);
  const previousRef = useRef<Map<string, TaskStatus>>(new Map());
  const firstPollRef = useRef(true);
  const reportedRef = useRef("");
  const loadItemsRef = useRef(loadItems);
  loadItemsRef.current = loadItems;
  const [clock, setClock] = useState(() => Date.now());
  const [liveLink, setLiveLink] = useState({ extensions: 0, connected: false });

  function applyTasks(list: TaskList) {
    const previous = previousRef.current;
    let added = 0;
    let duplicates = 0;
    let cutouts = 0;
    let failures = 0;
    if (!firstPollRef.current) {
      for (const task of list.items) {
        const before = previous.get(task.id);
        if (before === undefined || before === task.status) continue;
        if (task.status === "done" || task.status === "skipped") {
          if (task.kind === "download") {
            if (task.status === "skipped") duplicates += 1;
            else added += 1;
          } else cutouts += 1;
        } else if (task.status === "failed") failures += 1;
      }
    }
    firstPollRef.current = false;
    previousRef.current = new Map(
      list.items.map((task) => [task.id, task.status]),
    );
    setTasks(list.items);
    setClock(Date.now());
    if (added > 0) {
      notify(added === 1 ? "已下载原图，预处理进行中" : `已接收 ${added} 个链接，预处理进行中`);
    }
    if (duplicates > 0) {
      notify(duplicates === 1 ? "重复图片，已跳过" : `${duplicates} 个链接是重复图片，已跳过`);
    }
    if (cutouts > 0) {
      notify(cutouts === 1 ? "背景已移除" : `已移除 ${cutouts} 张图的背景`);
    }
    if (failures > 0) fail(failures === 1 ? "有 1 个任务失败" : `有 ${failures} 个任务失败`);
    if (added > 0 || cutouts > 0) void loadItemsRef.current();
  }

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api<TaskList>("capture/tasks");
        if (!active) return;
        reportedRef.current = "";
        applyTasks(list);
      } catch (err) {
        const message = messageOf(err);
        if (!active || reportedRef.current === message) return;
        reportedRef.current = message;
        fail(message);
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function enqueueUrls(rawUrls: string[]) {
    const urls = rawUrls.map((value) => value.trim()).filter((value) => value !== "");
    if (urls.length === 0) return;
    try {
      const result = await api<{ added: number; duplicates: number }>(
        "capture/downloads",
        { method: "POST", body: JSON.stringify({ urls }) },
      );
      setUrl("");
      if (result.added > 0) {
        notify(result.added === 1 ? "已进入下载队列" : `已加入 ${result.added} 个链接`);
      }
      if (result.duplicates > 0) {
        notify(result.duplicates === 1 ? "重复图片，已跳过" : `${result.duplicates} 个链接是重复图片，已跳过`);
      }
      await loadItems();
    } catch (err) {
      fail(messageOf(err));
    }
  }

  async function enqueueCutout(item: ImageAsset) {
    if (!item.processedUrl) return;
    if (item.nobgUrl) {
      if (selectedRef.current === item.id) setSlide("nobg");
      return;
    }
    try {
      const result = await api<{ added: number; skipped: number }>(
        "capture/cutouts",
        { method: "POST", body: JSON.stringify({ assetIds: [item.id] }) },
      );
      if (result.skipped > 0) {
        notify("这张图已经移除过背景或已在队列中，已跳过");
      }
      if (result.added > 0) await loadItems();
    } catch (err) {
      fail(messageOf(err));
    }
  }


  useEffect(() => {
    const live = connectCaptureLive({
      onLink(link) {
        setLiveLink(link);
      },
    });
    return () => live.close();
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
    void enqueueUrls([url]);
  }

  async function takeIncoming(files: File[], urls: string[] | null) {
    if (files.length > 0) await submitFiles(files);
    if (urls) await enqueueUrls(urls);
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

  const visibleTasks = tasks.filter(
    (task) =>
      !TERMINAL.includes(task.status) ||
      clock - (task.finishedAt ?? 0) < 12000,
  );
  const downloads = visibleTasks.filter((task) => task.kind === "download");
  const cutouts = visibleTasks.filter((task) => task.kind === "nobg");

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
          total={images.total}
          pageOffset={images.pageOffset}
          done={images.done}
          processing={images.processing}
          unsafe={images.unsafe}
          loaded={loaded}
          selectedId={selected?.id ?? null}
          onSelect={(id) => {
            setErasing(false);
            images.select(id);
          }}
          onPage={images.loadPage}
          revision={images.revision}
          safety={safety.enabled}
          safetyReady={safety.ready}
          onSafety={(next) => void safety.setSafety(next)}
        />

        <section className="panel capture-stage">
          <div className="column-head">
            <h2>采集</h2>
            <span className="muted">{liveLabel(liveLink)}</span>
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
            {!safety.ready ? (
              <p className="muted">加载中…</p>
            ) : selected ? (
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
                              (task.status === "pending" || task.status === "running"),
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
          loaded={loaded && safety.ready}
          selected={selected}
          approveVersion={versionOf(currentSlide?.key)}
          erasing={erasing}
          cutoutBusy={
            selected
              ? cutouts.some(
                  (task) =>
                    task.assetId === selected.id &&
                    (task.status === "pending" || task.status === "running"),
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
            aria-valuenow={downloads.filter((task) => task.status === "done").length}
          >
            {downloads.map((task) => (
              <span
                key={task.id}
                className={`capture-download-seg ${SEG_CLASS[task.status]}`}
                title={task.label}
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
            aria-valuenow={cutouts.filter((task) => task.status === "done").length}
          >
            {cutouts.map((task) => (
              <span
                key={task.id}
                className={`capture-download-seg ${SEG_CLASS[task.status]}`}
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

function liveLabel(link: { connected: boolean; extensions: number }): string {
  if (!link.connected) return "采集通道未连接";
  return link.extensions > 0 ? "插件已连接" : "插件未连接";
}

function versionOf(key: SlideKey | undefined): FinalVersion {
  if (key === "raw") return "raw";
  if (key === "nobg") return "nobg";
  return "processed";
}

function cutoutLabelFor(tasks: CaptureTask[], assetId: string): string {
  const task = tasks.find((item) => item.assetId === assetId);
  if (task?.status === "running") return "移除中…";
  if (task?.status === "pending") return "排队中…";
  return "移除背景";
}

function cutoutLabel(tasks: CaptureTask[]): string {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === "done").length;
  const queued = tasks.filter((task) => task.status === "pending").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const active = tasks.some((task) => task.status === "running");
  if (queued > 0) return `正在移除背景 ${done + 1}/${total}，还有 ${queued} 个在排队`;
  if (active) return `正在移除背景 ${done + 1}/${total}`;
  if (failed > 0) return `移除结束，${failed} 个没有完成`;
  return `已移除 ${done}/${total}`;
}

function downloadLabel(tasks: CaptureTask[]): string {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === "done").length;
  const queued = tasks.filter((task) => task.status === "pending").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const active = tasks.some((task) => task.status === "running");
  if (queued > 0) return `正在下载 ${done + 1}/${total}，还有 ${queued} 个在排队`;
  if (active) return `正在下载 ${done + 1}/${total}`;
  if (failed > 0) return `下载结束，${failed} 个没有下下来`;
  return `已下载 ${done}/${total}`;
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
