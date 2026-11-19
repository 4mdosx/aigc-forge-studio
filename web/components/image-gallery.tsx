"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";

import {
  RATINGS,
  STATUSES,
  ratingLabel,
  statusLabel,
  type ImageAsset,
  type ImageRating,
  type ImageStatus,
} from "@/components/image-assets";
import { api, fileHref } from "@/lib/api";
import { fail, messageOf, notify } from "@/lib/notify";

export function ImageGallery({
  items,
  loaded,
  selectedId,
  onSelect,
  query = false,
  tagSeed = null,
  onVisible,
  onReload,
  advanceProcessed = false,
  selectable = false,
  datasetFocus = null,
  datasetOnly = false,
  onDatasetBatch,
}: {
  items: ImageAsset[];
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query?: boolean;
  tagSeed?: { tag: string; nonce: number } | null;
  onVisible?: (ids: string[]) => void;
  onReload?: () => Promise<void>;
  advanceProcessed?: boolean;
  selectable?: boolean;
  datasetFocus?: { id: string; name: string; members: ReadonlySet<string> } | null;
  datasetOnly?: boolean;
  onDatasetBatch?: (action: "add" | "remove", ids: string[]) => Promise<void>;
}) {
  const [statusFilter, setStatusFilter] = useState<ImageStatus[]>([]);
  const [ratingFilter, setRatingFilter] = useState<ImageRating[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState("");
  const [recommended, setRecommended] = useState<string[]>([]);
  const [recommendFor, setRecommendFor] = useState("");
  const [recommendError, setRecommendError] = useState<string | null>(null);
  const [order, setOrder] = useState<"near" | "far">("near");
  const [topN, setTopN] = useState("12");
  const [sampleCount, setSampleCount] = useState("12");
  const [near, setNear] = useState<{ anchor: string; ids: string[] } | null>(
    null,
  );
  const [nearBusy, setNearBusy] = useState(false);
  const [nearError, setNearError] = useState<string | null>(null);
  const [diverse, setDiverse] = useState<{ ids: string[] } | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [diverseError, setDiverseError] = useState<string | null>(null);
  const [groupCount, setGroupCount] = useState("3");
  const [grouped, setGrouped] = useState<{
    key: string;
    groups: string[][];
    skipped: string[];
  } | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [galleryBody, setGalleryBody] = useState<HTMLDivElement | null>(null);
  const galleryBodyRef = useRef<HTMLDivElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [acting, setActing] = useState<"approve" | "reject" | "delete" | null>(
    null,
  );
  const [acted, setActed] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [datasetBusy, setDatasetBusy] = useState(false);
  const pickAnchor = useRef<string | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const dragRef = useRef<MarqueeDrag | null>(null);
  const suppressClick = useRef(false);
  const doneCount = items.filter(
    (item) => item.status === "processed" || item.status === "approved",
  ).length;
  const processingCount = items.filter(
    (item) => item.status === "collected",
  ).length;
  const scoped =
    datasetOnly && datasetFocus
      ? items.filter((item) => datasetFocus.members.has(item.id))
      : items;
  const statusMatched =
    statusFilter.length === 0
      ? scoped
      : scoped.filter((item) => statusFilter.includes(item.status));
  const ratingMatched =
    !query || ratingFilter.length === 0
      ? statusMatched
      : statusMatched.filter((item) =>
          ratingFilter.includes((item.rating ?? "") as ImageRating),
        );
  const tagMatched =
    !query || tagFilter.length === 0
      ? ratingMatched
      : ratingMatched.filter((item) =>
          tagFilter.every((tag) =>
            item.tags.some((itemTag) => tagKey(itemTag) === tagKey(tag)),
          ),
        );
  const filterKey = `${statusFilter.join("\n")}\n${ratingFilter.join("\n")}\n${tagFilter.join("\n")}`;
  const scopeKey = datasetOnly && datasetFocus ? datasetFocus.id : "";
  const ranked =
    query && near && tagMatched.some((item) => item.id === near.anchor)
      ? tagMatched
          .filter((item) => near.ids.includes(item.id))
          .sort(
            (left, right) =>
              near.ids.indexOf(left.id) - near.ids.indexOf(right.id),
          )
      : null;
  const listed = ranked ?? tagMatched;
  const diversified =
    query && diverse
      ? diverse.ids.flatMap((id) => {
          const item = tagMatched.find((candidate) => candidate.id === id);
          return item ? [item] : [];
        })
      : null;
  const visible = diversified ?? listed;
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
  const browseKey = (sections ? [...sections.flat(), ...skipped] : visible)
    .map((item) => item.id)
    .join("\n");

  useEffect(() => {
    onVisible?.(browseKey === "" ? [] : browseKey.split("\n"));
  }, [browseKey, onVisible]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const reviewed = useRef({
    ids: [] as string[],
    selected: null as string | null,
    onlyProcessed: false,
  });

  useEffect(() => {
    if (!advanceProcessed) return;
    const ids = browseKey === "" ? [] : browseKey.split("\n");
    const onlyProcessed =
      statusFilter.length === 1 && statusFilter[0] === "processed";
    const before = reviewed.current;
    if (
      onlyProcessed &&
      before.onlyProcessed &&
      selectedId &&
      before.selected === selectedId &&
      before.ids.includes(selectedId) &&
      !ids.includes(selectedId)
    ) {
      const index = before.ids.indexOf(selectedId);
      const next =
        before.ids.slice(index + 1).find((id) => ids.includes(id)) ??
        [...before.ids.slice(0, index)].reverse().find((id) => ids.includes(id));
      if (next) onSelectRef.current(next);
    }
    reviewed.current = { ids, selected: selectedId, onlyProcessed };
  }, [advanceProcessed, browseKey, selectedId, statusFilter]);

  useEffect(() => {
    setNear(null);
    setDiverse(null);
    setGrouped(null);
    setNearError(null);
    setDiverseError(null);
    setGroupError(null);
  }, [filterKey, scopeKey]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of ratingMatched) {
      for (const tag of item.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }, [ratingMatched]);
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

  function toggleRating(rating: ImageRating) {
    setRatingFilter((cur) =>
      cur.includes(rating)
        ? cur.filter((item) => item !== rating)
        : [...cur, rating],
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
      setDiverse(null);
      setDiverseError(null);
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
    const ids = listed.map((item) => item.id);
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
      setDiverse(null);
      setDiverseError(null);
    } catch (err) {
      setGroupError(messageOf(err));
    } finally {
      setGroupBusy(false);
    }
  }

  async function runDiverse() {
    const count = Number(sampleCount);
    if (!Number.isInteger(count) || count < 1) {
      setDiverseError("张数必须是正整数");
      return;
    }
    const ids = listed.map((item) => item.id);
    if (ids.length === 0) {
      setDiverseError("没有可取样的图片");
      return;
    }
    if (count > ids.length) {
      setDiverseError(
        `当前列表有 ${ids.length} 张，张数必须在 1 到 ${ids.length} 之间`,
      );
      return;
    }
    setSampleBusy(true);
    setDiverseError(null);
    try {
      const result = await api<{
        groups: Array<{ ids: string[] }>;
        skipped: string[];
      }>("capture/assets/groups", {
        method: "POST",
        body: JSON.stringify({ ids, groups: count }),
      });
      const picked = centersOf(result.groups);
      if (picked.length === 0) {
        setDiverse(null);
        setDiverseError("这些图片还没有向量");
        return;
      }
      setDiverse({ ids: picked });
      setNear(null);
      setNearError(null);
      setGrouped(null);
    } catch (err) {
      setDiverseError(messageOf(err));
    } finally {
      setSampleBusy(false);
    }
  }

  function clearQuery() {
    setNear(null);
    setNearError(null);
  }

  function resetArrange() {
    setDiverse(null);
    setGrouped(null);
    setDiverseError(null);
    setGroupError(null);
    setSampleCount("12");
    setGroupCount("3");
  }

  const orderedIds = browseKey === "" ? [] : browseKey.split("\n");

  useEffect(() => {
    if (!selectable) return;
    const live = new Set(orderedIds);
    setPicked((cur) => {
      const next = [...cur].filter((id) => live.has(id));
      if (next.length === cur.size) return cur;
      return new Set(next);
    });
  }, [browseKey, selectable]);

  function togglePicking() {
    setPicking((on) => !on);
    setPicked(new Set());
    setConfirmDelete(false);
    pickAnchor.current = null;
  }

  function pickTile(id: string, shift: boolean) {
    if (acting) return;
    setConfirmDelete(false);
    const order = orderedIds;
    setPicked((cur) => {
      const next = new Set(cur);
      const anchor = pickAnchor.current;
      if (shift && anchor && order.includes(anchor) && order.includes(id)) {
        const start = order.indexOf(anchor);
        const end = order.indexOf(id);
        const [from, to] = start < end ? [start, end] : [end, start];
        for (const itemId of order.slice(from, to + 1)) next.add(itemId);
        return next;
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    pickAnchor.current = id;
  }

  function selectVisible() {
    if (acting) return;
    setConfirmDelete(false);
    const ids = orderedIds;
    setPicked((cur) => {
      const allOn = ids.length > 0 && ids.every((id) => cur.has(id));
      if (allOn) {
        const next = new Set(cur);
        for (const id of ids) next.delete(id);
        return next;
      }
      return new Set([...cur, ...ids]);
    });
  }

  function paintMarquee() {
    const drag = dragRef.current;
    const body = galleryBodyRef.current;
    if (!drag || !body) return;
    const dx = drag.clientX - drag.startX;
    const dy = drag.clientY - drag.startY;
    if (!drag.moved && dx * dx + dy * dy < 16) return;
    if (!drag.moved) setConfirmDelete(false);
    drag.moved = true;
    const edge = 36;
    const bounds = body.getBoundingClientRect();
    if (drag.clientY < bounds.top + edge) body.scrollTop -= 14;
    else if (drag.clientY > bounds.bottom - edge) body.scrollTop += 14;
    const current = contentPoint(body, drag.clientX, drag.clientY);
    const left = Math.min(drag.contentX, current.x);
    const top = Math.min(drag.contentY, current.y);
    const right = Math.max(drag.contentX, current.x);
    const bottom = Math.max(drag.contentY, current.y);
    const hits = tilesInContentBox(body, left, top, right, bottom);
    const next = new Set(drag.additive ? drag.base : []);
    for (const id of hits) next.add(id);
    setPicked(next);
    const anchor = hits[hits.length - 1];
    if (anchor) pickAnchor.current = anchor;
    setMarquee({
      left,
      top,
      width: right - left,
      height: bottom - top,
    });
  }

  function beginMarquee(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || acting) return;
    const body = event.currentTarget;
    const origin = contentPoint(body, event.clientX, event.clientY);
    const drag: MarqueeDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      contentX: origin.x,
      contentY: origin.y,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
      base: new Set(pickedRef.current),
      moved: false,
      frame: 0,
    };
    const tick = () => {
      if (dragRef.current !== drag) return;
      paintMarquee();
      drag.frame = requestAnimationFrame(tick);
    };
    const finish = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      cancelAnimationFrame(drag.frame);
      if (dragRef.current !== drag) return;
      drag.clientX = ev.clientX;
      drag.clientY = ev.clientY;
      if (drag.moved) paintMarquee();
      dragRef.current = null;
      setMarquee(null);
      suppressClick.current = true;
      if (!drag.moved) {
        const id = tileAtClientPoint(body, ev.clientX, ev.clientY);
        if (!id) return;
        pickTile(id, ev.shiftKey);
        if (!ev.shiftKey) onSelect(id);
      }
    };
    const track = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== drag.pointerId) return;
      drag.clientX = ev.clientX;
      drag.clientY = ev.clientY;
    };
    drag.frame = requestAnimationFrame(tick);
    dragRef.current = drag;
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function swallowMarqueeClick(event: MouseEvent) {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  async function applyPicked(action: "approve" | "reject" | "delete") {
    const ids = [...picked];
    if (ids.length === 0 || acting) return;
    setActing(action);
    setActed(0);
    setBatchTotal(ids.length);
    const failed: string[] = [];
    let done = 0;
    let firstError = "";
    for (const id of ids) {
      try {
        if (action === "delete") {
          await api(`capture/assets/${id}`, { method: "DELETE" });
        } else if (action === "reject") {
          await api(`capture/assets/${id}/reject`, { method: "POST" });
        } else {
          await api(`capture/assets/${id}/approve`, {
            method: "POST",
            body: JSON.stringify({ version: "processed" }),
          });
        }
        done += 1;
      } catch (err) {
        failed.push(id);
        if (firstError === "") firstError = messageOf(err);
      }
      setActed(done + failed.length);
    }
    setPicked(new Set(failed));
    setActing(null);
    setConfirmDelete(false);
    if (done > 0) {
      const label =
        action === "approve" ? "通过" : action === "reject" ? "拒绝" : "删除";
      notify(`已${label} ${done} 张`);
      await onReload?.();
    }
    if (failed.length > 0) fail(`${failed.length} 张未完成：${firstError}`);
  }

  async function applyDataset(action: "add" | "remove") {
    if (!onDatasetBatch || picked.size === 0 || acting || datasetBusy) return;
    setDatasetBusy(true);
    try {
      await onDatasetBatch(action, [...picked]);
    } finally {
      setDatasetBusy(false);
    }
  }

  function renderTiles(list: ImageAsset[]) {
    return list.map((item) => {
      const thumb = item.thumbUrl
        ? `${item.thumbUrl}?v=${item.updatedAt}`
        : (item.processedUrl ?? item.originalUrl);
      return (
        <GalleryTile
          key={item.id}
          id={item.id}
          active={item.id === selectedId}
          picked={selectable && picking && picked.has(item.id)}
          mark={selectable && picking}
          inSet={
            !datasetOnly &&
            datasetFocus !== null &&
            datasetFocus.members.has(item.id)
          }
          label={item.source.sourceUrl || item.source.imgUrl || item.id}
          root={galleryBody}
          src={thumb ? fileHref(thumb) : null}
          status={item.status}
          onSelect={(shift) => {
            if (selectable && picking) {
              pickTile(item.id, shift);
              if (!shift) onSelect(item.id);
              return;
            }
            onSelect(item.id);
          }}
        />
      );
    });
  }

  const visibleAllPicked =
    orderedIds.length > 0 && orderedIds.every((id) => picked.has(id));
  const actionLabel =
    acting === "approve" ? "通过" : acting === "reject" ? "拒绝" : "删除";

  return (
    <section className={"panel capture-gallery" + (query ? " gallery-has-arrange" : "")}>
      <div className="column-head">
        <h2>图库</h2>
        <div className="gallery-head-actions">
          <span className="muted">
            {datasetOnly && datasetFocus ? `「${datasetFocus.name}」 · ` : ""}
            {query ? `显示 ${visible.length} · ` : ""}
            完成 {doneCount}
            {processingCount > 0 ? ` · 处理中 ${processingCount}` : ""}
          </span>
          {selectable && !picking ? (
            <button type="button" className="quiet" onClick={togglePicking}>
              多选
            </button>
          ) : null}
        </div>
      </div>
      {selectable && picking ? (
        <SelectBar
          acted={acted}
          acting={acting}
          actionLabel={actionLabel}
          batchTotal={batchTotal}
          confirmDelete={confirmDelete}
          orderedCount={orderedIds.length}
          pickedCount={picked.size}
          visibleAllPicked={visibleAllPicked}
          onApprove={() => void applyPicked("approve")}
          onTogglePicking={togglePicking}
          onCancelDelete={() => setConfirmDelete(false)}
          onConfirmDelete={() => void applyPicked("delete")}
          onDelete={() => setConfirmDelete(true)}
          onReject={() => void applyPicked("reject")}
          onSelectVisible={selectVisible}
          datasetName={datasetFocus?.name ?? null}
          datasetBusy={datasetBusy}
          onDatasetAdd={onDatasetBatch ? () => void applyDataset("add") : undefined}
          onDatasetRemove={
            onDatasetBatch ? () => void applyDataset("remove") : undefined
          }
        />
      ) : null}
      {query ? null : (
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
      )}
      {query ? (
        <div className="gallery-query">
          <div className="gallery-query-row">
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
            <div className="capture-filters" role="group" aria-label="按分级筛选">
              {RATINGS.map((rating) => {
                const on = ratingFilter.includes(rating);
                return (
                  <button
                    key={rating}
                    type="button"
                    className={on ? "active" : ""}
                    aria-pressed={on}
                    onClick={() => toggleRating(rating)}
                  >
                    {ratingLabel(rating)}
                  </button>
                );
              })}
            </div>
          </div>
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
              disabled={near === null}
              onClick={clearQuery}
            >
              清除
            </button>
          </div>
          {nearError ? <p className="gallery-query-error">{nearError}</p> : null}
          <div className="gallery-query-row">
            <input
              type="search"
              aria-label="搜索标签"
              placeholder="标签"
              value={tagQuery}
              onChange={(event) => setTagQuery(event.target.value)}
            />
            <div className="gallery-tag-strip" role="group" aria-label="按标签筛选">
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
              {needle !== "" && recommendFor !== needle && recommendError === null ? (
                <span className="muted">推荐中…</span>
              ) : null}
              {needle !== "" &&
              recommendFor === needle &&
              recommendError === null &&
              suggestions.length === 0 ? (
                <span className="muted">没有可推荐的标签。</span>
              ) : null}
            </div>
          </div>
          {recommendError ? <p className="gallery-query-error">{recommendError}</p> : null}
        </div>
      ) : null}
      <div
        className={
          (sections
            ? "capture-gallery-body gallery-grouped"
            : "capture-gallery-body") + (marquee ? " selecting" : "")
        }
        ref={(node) => {
          galleryBodyRef.current = node;
          setGalleryBody(node);
        }}
        onPointerDown={selectable && picking ? beginMarquee : undefined}
        onClickCapture={selectable && picking ? swallowMarqueeClick : undefined}
      >
        {!loaded ? (
          <p className="muted">加载中…</p>
        ) : items.length === 0 ? (
          <p className="muted">还没有图片。</p>
        ) : datasetOnly && datasetFocus && datasetFocus.members.size === 0 ? (
          <p className="muted">「{datasetFocus.name}」里还没有图片。</p>
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
        {marquee ? (
          <div
            className="gallery-marquee"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        ) : null}
      </div>
      {query ? (
        <div className="gallery-arrange">
          <span>分布</span>
          <input
            type="number"
            min={1}
            aria-label="样本张数"
            value={sampleCount}
            onChange={(event) => setSampleCount(event.target.value)}
          />
          <span>张</span>
          <button
            type="button"
            disabled={sampleBusy || listed.length === 0}
            onClick={() => void runDiverse()}
          >
            {sampleBusy ? "取样中…" : "取样"}
          </button>
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
            disabled={groupBusy || listed.length === 0}
            onClick={() => void runGroups()}
          >
            {groupBusy ? "分组中…" : "分组"}
          </button>
          <button type="button" className="quiet" onClick={resetArrange}>
            重置
          </button>
          {diverseError || groupError ? (
            <p className="gallery-query-error">{diverseError || groupError}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SelectBar({
  acted,
  acting,
  actionLabel,
  batchTotal,
  confirmDelete,
  orderedCount,
  pickedCount,
  visibleAllPicked,
  onApprove,
  onCancelDelete,
  onConfirmDelete,
  onDelete,
  onReject,
  onSelectVisible,
  onTogglePicking,
  datasetName = null,
  datasetBusy = false,
  onDatasetAdd,
  onDatasetRemove,
}: {
  acted: number;
  acting: "approve" | "reject" | "delete" | null;
  actionLabel: string;
  batchTotal: number;
  confirmDelete: boolean;
  orderedCount: number;
  pickedCount: number;
  visibleAllPicked: boolean;
  onApprove: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onDelete: () => void;
  onReject: () => void;
  onSelectVisible: () => void;
  onTogglePicking: () => void;
  datasetName?: string | null;
  datasetBusy?: boolean;
  onDatasetAdd?: () => void;
  onDatasetRemove?: () => void;
}) {
  return (
    <div className="gallery-select-bar" role="toolbar" aria-label="批量操作">
      {confirmDelete ? (
        <>
          <span>
            {acting === "delete"
              ? `正在删除 ${acted}/${batchTotal}`
              : `删除已选的 ${pickedCount} 张？`}
          </span>
          <button type="button" disabled={acting !== null} onClick={onConfirmDelete}>
            确认删除
          </button>
          <button
            type="button"
            className="quiet"
            disabled={acting !== null}
            onClick={onCancelDelete}
          >
            取消
          </button>
        </>
      ) : (
        <>
          <span>
            {datasetBusy
              ? "正在更新数据集"
              : acting
                ? `正在${actionLabel} ${acted}/${batchTotal}`
                : `已选 ${pickedCount}${datasetName ? ` · ${datasetName}` : ""}`}
          </span>
          <button
            type="button"
            className="quiet"
            aria-pressed
            disabled={acting !== null || datasetBusy}
            onClick={onTogglePicking}
          >
            退出多选
          </button>
          <button
            type="button"
            className="quiet"
            disabled={acting !== null || datasetBusy || orderedCount === 0}
            onClick={onSelectVisible}
          >
            {visibleAllPicked ? "取消全选" : "全选"}
          </button>
          {onDatasetAdd && onDatasetRemove ? (
            <>
              <button
                type="button"
                className="quiet"
                disabled={acting !== null || datasetBusy || !datasetName || pickedCount === 0}
                title={datasetName ? `加入「${datasetName}」` : "先在左侧选择数据集"}
                onClick={onDatasetAdd}
              >
                加入
              </button>
              <button
                type="button"
                className="quiet"
                disabled={acting !== null || datasetBusy || !datasetName || pickedCount === 0}
                title={datasetName ? `移出「${datasetName}」` : "先在左侧选择数据集"}
                onClick={onDatasetRemove}
              >
                移出
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="quiet"
            disabled={acting !== null || datasetBusy || pickedCount === 0}
            onClick={onApprove}
          >
            通过
          </button>
          <button
            type="button"
            className="quiet"
            disabled={acting !== null || datasetBusy || pickedCount === 0}
            onClick={onReject}
          >
            拒绝
          </button>
          <button
            type="button"
            className="quiet"
            disabled={acting !== null || datasetBusy || pickedCount === 0}
            onClick={onDelete}
          >
            删除
          </button>
        </>
      )}
    </div>
  );
}

function tileAtClientPoint(body: HTMLElement, clientX: number, clientY: number) {
  const node = document.elementFromPoint(clientX, clientY);
  const tile = node?.closest<HTMLElement>("[data-asset-id]");
  if (!tile || !body.contains(tile)) return null;
  return tile.dataset.assetId ?? null;
}

function contentPoint(body: HTMLElement, clientX: number, clientY: number) {
  const rect = body.getBoundingClientRect();
  return {
    x: clientX - rect.left + body.scrollLeft,
    y: clientY - rect.top + body.scrollTop,
  };
}

function tilesInContentBox(
  body: HTMLElement,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  const origin = body.getBoundingClientRect();
  const hits: string[] = [];
  for (const node of body.querySelectorAll<HTMLElement>("[data-asset-id]")) {
    const id = node.dataset.assetId;
    if (!id) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const tileLeft = rect.left - origin.left + body.scrollLeft;
    const tileTop = rect.top - origin.top + body.scrollTop;
    const tileRight = tileLeft + rect.width;
    const tileBottom = tileTop + rect.height;
    if (tileRight < left || tileLeft > right || tileBottom < top || tileTop > bottom) {
      continue;
    }
    hits.push(id);
  }
  return hits;
}

type Marquee = { left: number; top: number; width: number; height: number };

type MarqueeDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  contentX: number;
  contentY: number;
  additive: boolean;
  base: Set<string>;
  moved: boolean;
  frame: number;
};

function centersOf(groups: Array<{ ids: string[] }>): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    if (group.ids.length === 0) continue;
    ids.push(group.ids[Math.floor((group.ids.length - 1) / 2)] as string);
  }
  return ids;
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
  id,
  active,
  picked = false,
  mark = false,
  inSet = false,
  label,
  root,
  src,
  status,
  onSelect,
}: {
  id?: string;
  active: boolean;
  picked?: boolean;
  mark?: boolean;
  inSet?: boolean;
  label: string;
  root: HTMLElement | null;
  src: string | null;
  status: ImageStatus;
  onSelect: (shift: boolean) => void;
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
      className={
        "capture-tile" + (active ? " active" : "") + (picked ? " picked" : "")
      }
      data-asset-id={id}
      aria-label={label}
      aria-pressed={mark ? picked : undefined}
      onClick={(event) => onSelect(event.shiftKey)}
    >
      {mark ? (
        <span className={picked ? "capture-tile-check on" : "capture-tile-check"}>
          {picked ? "✓" : ""}
        </span>
      ) : null}
      {inSet ? (
        <span className="capture-tile-member" title="在当前数据集">
          集
        </span>
      ) : null}
      {src && near ? (
        <img src={src} alt="" decoding="async" draggable={false} />
      ) : src ? (
        <span className="capture-tile-pending" />
      ) : (
        <span className="capture-tile-missing">{statusLabel(status)}</span>
      )}
      <span className={`capture-badge ${status}`}>{statusLabel(status)}</span>
    </button>
  );
}
