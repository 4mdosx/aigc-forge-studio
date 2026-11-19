"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  STATUSES,
  statusLabel,
  type ImageAsset,
  type ImageStatus,
} from "@/components/image-assets";
import { api, fileHref } from "@/lib/api";
import { messageOf } from "@/lib/notify";

export function ImageGallery({
  items,
  loaded,
  selectedId,
  onSelect,
  query = false,
  tagSeed = null,
}: {
  items: ImageAsset[];
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query?: boolean;
  tagSeed?: { tag: string; nonce: number } | null;
}) {
  const [statusFilter, setStatusFilter] = useState<ImageStatus[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [recommended, setRecommended] = useState<string[]>([]);
  const [recommendFor, setRecommendFor] = useState("");
  const [recommendError, setRecommendError] = useState<string | null>(null);
  const [order, setOrder] = useState<"near" | "far">("near");
  const [topN, setTopN] = useState("12");
  const [near, setNear] = useState<{ anchor: string; ids: string[] } | null>(
    null,
  );
  const [nearBusy, setNearBusy] = useState(false);
  const [nearError, setNearError] = useState<string | null>(null);
  const [groupCount, setGroupCount] = useState("3");
  const [grouped, setGrouped] = useState<{
    key: string;
    groups: string[][];
    skipped: string[];
  } | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [galleryBody, setGalleryBody] = useState<HTMLDivElement | null>(null);
  const doneCount = items.filter(
    (item) => item.status === "processed" || item.status === "approved",
  ).length;
  const processingCount = items.filter(
    (item) => item.status === "collected",
  ).length;
  const statusMatched =
    statusFilter.length === 0
      ? items
      : items.filter((item) => statusFilter.includes(item.status));
  const tagMatched =
    !query || tagFilter.length === 0
      ? statusMatched
      : statusMatched.filter((item) =>
          tagFilter.every((tag) =>
            item.tags.some((itemTag) => tagKey(itemTag) === tagKey(tag)),
          ),
        );
  const filterKey = `${statusFilter.join("\n")}\n${tagFilter.join("\n")}`;
  const ranked =
    query && near && tagMatched.some((item) => item.id === near.anchor)
      ? tagMatched
          .filter((item) => near.ids.includes(item.id))
          .sort(
            (left, right) =>
              near.ids.indexOf(left.id) - near.ids.indexOf(right.id),
          )
      : null;
  const visible = ranked ?? tagMatched;
  const visibleKey = visible.map((item) => item.id).join("\n");
  const sections =
    query && grouped && grouped.key === visibleKey
      ? grouped.groups.map((ids) =>
          ids
            .map((id) => visible.find((item) => item.id === id))
            .filter((item): item is ImageAsset => item !== undefined),
        )
      : null;
  const skipped =
    sections && grouped
      ? grouped.skipped
          .map((id) => visible.find((item) => item.id === id))
          .filter((item): item is ImageAsset => item !== undefined)
      : [];

  useEffect(() => {
    setNear(null);
    setGrouped(null);
    setNearError(null);
    setGroupError(null);
  }, [filterKey]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of statusMatched) {
      for (const tag of item.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }, [statusMatched]);
  const vocabKey = [...tagCounts.keys()].sort().join("\n");
  const shuffled = useMemo(() => shuffleTags(vocabKey), [vocabKey]);
  const needle = tagQuery.trim();
  const suggestions =
    needle === ""
      ? shuffled
          .filter((tag) => !tagFilter.includes(tag))
          .slice(0, 24)
          .map((tag) => ({ tag, count: tagCounts.get(tag) }))
      : (recommendFor === needle ? recommended : [])
          .filter((tag) => !tagFilter.includes(tag))
          .map((tag) => ({ tag, count: tagCounts.get(tag) }));

  useEffect(() => {
    if (!query || tagSeed === null || tagSeed.tag === "") return;
    setTagFilter((cur) =>
      cur.includes(tagSeed.tag) ? cur : [...cur, tagSeed.tag],
    );
  }, [query, tagSeed]);

  useEffect(() => {
    if (!query) return;
    const text = tagQuery.trim();
    if (text === "") {
      setRecommended([]);
      setRecommendFor("");
      setRecommendError(null);
      return;
    }
    const tags = text.split(/[\s,，]+/).filter((tag) => tag !== "");
    if (tags.length === 0) return;
    setRecommendError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ recommendations: string[] }>("tag/recommend", {
        method: "POST",
        body: JSON.stringify({ tags }),
        signal: controller.signal,
      })
        .then((body) => {
          if (controller.signal.aborted) return;
          setRecommended(body.recommendations);
          setRecommendFor(text);
          setRecommendError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setRecommended([]);
          setRecommendFor(text);
          setRecommendError(messageOf(err));
        });
    }, 280);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, tagQuery]);

  function toggleStatus(status: ImageStatus) {
    setStatusFilter((cur) =>
      cur.includes(status)
        ? cur.filter((item) => item !== status)
        : [...cur, status],
    );
  }

  function toggleTag(tag: string) {
    setTagFilter((cur) =>
      cur.includes(tag) ? cur.filter((item) => item !== tag) : [...cur, tag],
    );
  }

  async function runNear() {
    if (!selectedId) {
      setNearError("先选中一张图片");
      return;
    }
    const anchor = tagMatched.find((item) => item.id === selectedId);
    if (!anchor) {
      setNearError("当前图片不在筛选结果里");
      return;
    }
    const count = Number(topN);
    if (!Number.isInteger(count) || count < 1) {
      setNearError("N 必须是正整数");
      return;
    }
    const ids = tagMatched
      .filter((item) => item.id !== selectedId)
      .map((item) => item.id);
    if (ids.length === 0) {
      setNearError("筛选结果里没有其它图片");
      return;
    }
    setNearBusy(true);
    setNearError(null);
    try {
      const params = new URLSearchParams({
        k: String(count),
        order,
        ids: ids.join(","),
      });
      const result = await api<{ neighbors: Array<{ id: string }> }>(
        `capture/assets/${encodeURIComponent(selectedId)}/nearest?${params}`,
      );
      setNear({
        anchor: selectedId,
        ids: result.neighbors.map((item) => item.id),
      });
      setGrouped(null);
    } catch (err) {
      setNearError(messageOf(err));
    } finally {
      setNearBusy(false);
    }
  }

  async function runGroups() {
    const count = Number(groupCount);
    if (!Number.isInteger(count) || count < 1) {
      setGroupError("组数必须是正整数");
      return;
    }
    const ids = visible.map((item) => item.id);
    if (ids.length === 0) {
      setGroupError("没有可分组的图片");
      return;
    }
    setGroupBusy(true);
    setGroupError(null);
    try {
      const result = await api<{
        groups: Array<{ ids: string[] }>;
        skipped: string[];
      }>("capture/assets/groups", {
        method: "POST",
        body: JSON.stringify({ ids, groups: count }),
      });
      setGrouped({
        key: ids.join("\n"),
        groups: result.groups.map((group) => group.ids),
        skipped: result.skipped,
      });
    } catch (err) {
      setGroupError(messageOf(err));
    } finally {
      setGroupBusy(false);
    }
  }

  function clearQuery() {
    setNear(null);
    setGrouped(null);
    setNearError(null);
    setGroupError(null);
  }

  function renderTiles(list: ImageAsset[]) {
    return list.map((item) => {
      const thumb = item.thumbUrl
        ? `${item.thumbUrl}?v=${item.updatedAt}`
        : (item.processedUrl ?? item.originalUrl);
      return (
        <GalleryTile
          key={item.id}
          active={item.id === selectedId}
          label={item.source.sourceUrl || item.source.imgUrl || item.id}
          root={galleryBody}
          src={thumb ? fileHref(thumb) : null}
          status={item.status}
          onSelect={() => onSelect(item.id)}
        />
      );
    });
  }

  return (
    <section className="panel capture-gallery">
      <div className="column-head">
        <h2>图库</h2>
        <span className="muted">
          {query ? `显示 ${visible.length} · ` : ""}
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
      {query ? (
        <div className="gallery-query">
          <div className="gallery-query-row">
            <div className="capture-filters" role="group" aria-label="远近">
              <button
                type="button"
                className={order === "near" ? "active" : ""}
                aria-pressed={order === "near"}
                onClick={() => setOrder("near")}
              >
                接近
              </button>
              <button
                type="button"
                className={order === "far" ? "active" : ""}
                aria-pressed={order === "far"}
                onClick={() => setOrder("far")}
              >
                远离
              </button>
            </div>
            <span>前</span>
            <input
              type="number"
              min={1}
              aria-label="数量"
              value={topN}
              onChange={(event) => setTopN(event.target.value)}
            />
            <button type="button" disabled={nearBusy} onClick={() => void runNear()}>
              {nearBusy ? "查询中…" : "查询"}
            </button>
            <button
              type="button"
              disabled={near === null && grouped === null}
              onClick={clearQuery}
            >
              清除
            </button>
          </div>
          {nearError ? <p className="gallery-query-error">{nearError}</p> : null}
          <div className="gallery-query-row">
            <span>标签</span>
            <input
              type="search"
              aria-label="搜索标签"
              placeholder="输入后推荐相关标签"
              value={tagQuery}
              onChange={(event) => setTagQuery(event.target.value)}
            />
          </div>
          <div className="capture-filters" role="group" aria-label="按标签筛选">
            {tagFilter.map((tag) => (
              <button
                key={tag}
                type="button"
                className="active"
                aria-pressed
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
            {suggestions.map((item) => (
              <button
                key={item.tag}
                type="button"
                aria-pressed={false}
                onClick={() => toggleTag(item.tag)}
              >
                {item.tag}
                {item.count !== undefined ? ` ${item.count}` : ""}
              </button>
            ))}
          </div>
          {needle !== "" && recommendFor !== needle && recommendError === null ? (
            <p className="muted gallery-query-note">推荐中…</p>
          ) : null}
          {needle !== "" && recommendFor === needle && recommendError === null && suggestions.length === 0 ? (
            <p className="muted gallery-query-note">没有可推荐的标签。</p>
          ) : null}
          {recommendError ? <p className="gallery-query-error">{recommendError}</p> : null}
          <div className="gallery-query-row">
            <span>分成</span>
            <input
              type="number"
              min={1}
              aria-label="组数"
              value={groupCount}
              onChange={(event) => setGroupCount(event.target.value)}
            />
            <span>组</span>
            <button
              type="button"
              disabled={groupBusy || visible.length === 0}
              onClick={() => void runGroups()}
            >
              {groupBusy ? "分组中…" : "分组"}
            </button>
          </div>
          {groupError ? <p className="gallery-query-error">{groupError}</p> : null}
        </div>
      ) : null}
      <div
        className={
          sections ? "capture-gallery-body gallery-grouped" : "capture-gallery-body"
        }
        ref={setGalleryBody}
      >
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : items.length === 0 ? (
          <p className="muted">还没有图片。</p>
        ) : visible.length === 0 ? (
          <p className="muted">没有符合筛选的图片。</p>
        ) : sections ? (
          <>
            {sections.map((group, index) => (
              <section key={group.map((item) => item.id).join(",") || index} className="gallery-group">
                <h3>
                  组 {index + 1} · {group.length}
                </h3>
                {renderTiles(group)}
              </section>
            ))}
            {skipped.length > 0 ? (
              <section className="gallery-group">
                <h3>未分组 · {skipped.length}</h3>
                {renderTiles(skipped)}
              </section>
            ) : null}
          </>
        ) : (
          renderTiles(visible)
        )}
      </div>
    </section>
  );
}

function tagKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s_]+/g, "_");
}

function shuffleTags(vocabKey: string): string[] {
  if (vocabKey === "") return [];
  const tags = vocabKey.split("\n");
  for (let index = tags.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const current = tags[index] as string;
    tags[index] = tags[swap] as string;
    tags[swap] = current;
  }
  return tags;
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
