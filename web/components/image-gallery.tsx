"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";

import {
  RATINGS,
  STATUSES,
  assetSearchParams,
  fetchAssetsByIds,
  ratingLabel,
  statusLabel,
  type AssetPageQuery,
  type ImageAsset,
  type ImageRating,
  type ImageStatus,
} from "@/components/image-assets";
import { SafetySwitch } from "@/components/safety-switch";
import { api, fileHref } from "@/lib/api";
import { ZoomImage } from "@/components/zoom-image";
import { fail, messageOf, notify } from "@/lib/notify";
import { isSafetyHiddenRating } from "@/lib/safety-mode";

/** 非虚拟列表（分组 / 相似度）与布局未就绪时用来取第一页的页大小。 */
const DEFAULT_PAGE = 60;
/** 分组裁剪的上下预渲染余量（像素），半屏左右。 */
const GROUP_OVERSCAN = 600;
/** 「未分组」那一栏的折叠 key，不跟任何真实组冲突。 */
const SKIPPED_GROUP_KEY = "skipped";

/**
 * 组的稳定标识：只看张数和首尾 id，O(1)。
 * 组内容一变（重排、重建）签名就变，折叠状态跟着失效，不会张冠李戴。
 */
function groupSignature(ids: string[] | undefined, index: number) {
  if (!ids || ids.length === 0) return `empty:${index}`;
  return `${ids.length}:${ids[0]}:${ids[ids.length - 1]}`;
}

export function ImageGallery({
  items,
  total,
  pageOffset,
  done,
  processing,
  unsafe,
  loaded,
  selectedId,
  onSelect,
  onPage,
  revision = 0,
  query = false,
  tagSeed = null,
  onVisible,
  onReload,
  advanceProcessed = false,
  selectable = false,
  datasetFocus = null,
  datasetOnly = false,
  onDatasetBatch,
  safety = false,
  safetyReady = true,
  onSafety,
}: {
  items: ImageAsset[];
  total: number;
  pageOffset: number;
  done: number;
  processing: number;
  unsafe: number;
  loaded: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPage: (query: AssetPageQuery) => void;
  revision?: number;
  query?: boolean;
  tagSeed?: { tag: string; nonce: number } | null;
  onVisible?: (ids: string[]) => void;
  onReload?: () => Promise<void>;
  advanceProcessed?: boolean;
  selectable?: boolean;
  datasetFocus?: { id: string; name: string; members: ReadonlySet<string> } | null;
  datasetOnly?: boolean;
  onDatasetBatch?: (action: "add" | "remove", ids: string[]) => Promise<void>;
  safety?: boolean;
  safetyReady?: boolean;
  onSafety?: (enabled: boolean) => void;
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
    stale: string[];
    /** 从服务端读回来的全局分组：不跟当前筛选绑定。 */
    global: boolean;
  } | null>(null);
  /** 折叠的组。key 按组内容算，换了分组方案就自然失效、回到展开。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
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
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const [tagCounts, setTagCounts] = useState<Map<string, number>>(new Map());
  const [pool, setPool] = useState<Map<string, ImageAsset>>(new Map());
  const [range, setRange] = useState({
    offset: 0,
    size: 0,
    cols: 1,
    row: 104,
  });
  /** 分组视图不是虚拟列表，视窗与分组几何要自己算。 */
  const [view, setView] = useState({ top: 0, height: 0, width: 0 });
  const groupRefs = useRef<Array<HTMLElement | null>>([]);
  /** 只存不会随裁剪变化的量：列数、行高、标题高、组间距。位置由它们解析推算。 */
  const groupGeo = useRef({ cols: 0, rowH: 0, rowGap: 0, headerH: 0, groupGap: 0 });
  const [, setGeoSeen] = useState(0);
  const datasetId = datasetOnly && datasetFocus ? datasetFocus.id : null;
  const filterQuery = useMemo<Omit<AssetPageQuery, "offset" | "size">>(
    () => ({
      statuses: statusFilter,
      ratings: query ? ratingFilter : [],
      tags: query ? tagFilter : [],
      safe: safety,
      datasetId,
    }),
    [datasetId, query, ratingFilter, safety, statusFilter, tagFilter],
  );
  const filterKey = `${safety ? "safe" : "open"}\n${statusFilter.join("\n")}\n${ratingFilter.join("\n")}\n${tagFilter.join("\n")}`;
  const scopeKey = datasetId ?? "";
  const orderKey = orderIds.join("\n");
  const nearOn = query && near !== null && orderIds.includes(near.anchor);
  const diverseOn = query && diverse !== null && !nearOn;
  const groupedOn =
    query && grouped !== null && (grouped.global || grouped.key === orderKey);
  const orderSet = useMemo(() => new Set(orderIds), [orderKey]);
  const browseIds = groupedOn
    ? [
        ...(grouped?.groups.flat() ?? []),
        ...(grouped?.skipped ?? []),
      ].filter((id) => orderSet.has(id))
    : nearOn && near
      ? near.ids
      : diverseOn && diverse
        ? diverse.ids
        : orderIds;
  const browseKey = browseIds.join("\n");
  const sections = groupedOn
    ? (grouped?.groups ?? []).map((ids) =>
        ids.flatMap((id) => {
          const item = pool.get(id);
          return item ? [item] : [];
        }),
      )
    : null;
  const skipped =
    sections && grouped
      ? grouped.skipped.flatMap((id) => {
          const item = pool.get(id);
          return item ? [item] : [];
        })
      : [];
  // 组 + 「未分组」一栏的折叠 key / 展开状态，裁剪与渲染共用同一份。
  const groupKeys = sections
    ? [
        ...sections.map((_, index) => groupSignature(grouped?.groups[index], index)),
        SKIPPED_GROUP_KEY,
      ]
    : [];
  const openGroups = groupKeys.map((key) => !collapsed.has(key));
  const flat = nearOn && near
    ? near.ids.flatMap((id) => {
        const item = pool.get(id);
        return item ? [item] : [];
      })
    : diverseOn && diverse
      ? diverse.ids.flatMap((id) => {
          const item = pool.get(id);
          return item ? [item] : [];
        })
      : null;
  const virtual = sections === null && flat === null;
  const firstRow = range.cols > 0 ? Math.floor(pageOffset / range.cols) : 0;
  const shownRows = range.cols > 0 ? Math.ceil(items.length / range.cols) : 0;
  const totalRows = range.cols > 0 ? Math.ceil(total / range.cols) : 0;
  const padTop = virtual ? firstRow * range.row : 0;
  const padBottom = virtual
    ? Math.max(0, (totalRows - firstRow - shownRows) * range.row)
    : 0;

  useEffect(() => {
    if (!safetyReady) return;
    onVisible?.(browseKey === "" ? [] : browseKey.split("\n"));
  }, [browseKey, onVisible, safetyReady]);

  // 分组结果落在服务端，刷新页面还能接着上次的整理。
  const loadSavedGroups = useCallback(async () => {
    const saved = await api<{
      groups: Array<{ ids: string[]; centerId: string | null }> | null;
      ungrouped?: string[];
    }>("capture/groups");
    if (!saved.groups) return null;
    const next = {
      key: "",
      groups: saved.groups.map((group) => group.ids),
      skipped: saved.ungrouped ?? [],
      stale: [],
      global: true,
    };
    setGrouped(next);
    return next;
  }, []);

  useEffect(() => {
    if (!query) {
      setGrouped(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (cancelled) return;
        await loadSavedGroups();
      } catch {
        // 还没有保存过分组是正常状态
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, loadSavedGroups]);

  useEffect(() => {
    if (!safety) return;
    setRatingFilter((cur) => {
      const next = cur.filter((rating) => !isSafetyHiddenRating(rating));
      return next.length === cur.length ? cur : next;
    });
  }, [safety]);

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
    const body = galleryBodyRef.current;
    if (body) body.scrollTop = 0;
    setRange((cur) => (cur.offset === 0 ? cur : { ...cur, offset: 0 }));
  }, [filterKey, scopeKey]);

  useEffect(() => {
    if (!safetyReady) return;
    // 分组 / 相似度视图不是虚拟列表，range 从来算不出来；高度还没撑开时也一样。
    // 两种情况下都得先按默认页大小取一页，否则 loaded 永远为 false，界面卡在「加载中」。
    const sized = range.size > 0;
    onPage({
      ...filterQuery,
      offset: sized ? range.offset : 0,
      size: sized ? range.size : DEFAULT_PAGE,
    });
  }, [filterQuery, onPage, range.offset, range.size, safetyReady]);

  useEffect(() => {
    const body = galleryBody;
    if (!body || !safetyReady || !virtual) return;
    const apply = () => {
      // 高度为 0 时也要算出窗口：否则 size 永远是 0，下面的取页 effect 不会触发，
      // 图库就永久停在「加载中」。布局撑开之后 ResizeObserver 会再校正一次。
      const next = galleryWindow(body, total);
      setRange((cur) =>
        cur.offset === next.offset &&
        cur.size === next.size &&
        cur.cols === next.cols &&
        cur.row === next.row
          ? cur
          : next,
      );
    };
    apply();
    body.addEventListener("scroll", apply, { passive: true });
    const observer = new ResizeObserver(apply);
    observer.observe(body);
    return () => {
      body.removeEventListener("scroll", apply);
      observer.disconnect();
    };
  }, [galleryBody, safetyReady, total, virtual]);

  // 分组视图：滚动位置与视口尺寸，裁剪要用。rAF 合帧，避免每像素一渲染。
  const sectionsOn = sections !== null;
  useEffect(() => {
    const body = galleryBody;
    if (!body || !sectionsOn) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setView((cur) =>
        cur.top === body.scrollTop &&
        cur.height === body.clientHeight &&
        cur.width === body.clientWidth
          ? cur
          : { top: body.scrollTop, height: body.clientHeight, width: body.clientWidth },
      );
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    read();
    body.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(body);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      body.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [galleryBody, sectionsOn]);

  // 量一次格子几何就够：列数、行高、标题高、组间距都是布局常量，
  // 不算总高度，所以裁剪不会反过来影响测量，也就不会抖动。
  const countsKey = sections ? sections.map((group) => group.length).join(",") : "";
  useEffect(() => {
    const body = galleryBody;
    if (!body || sections === null) return;
    const node = groupRefs.current.find(
      (item) => item !== null && item.querySelector(".capture-tile"),
    );
    if (!node) return;
    const style = getComputedStyle(node);
    const gap = Number.parseFloat(style.rowGap) || 0;
    const cols = style.gridTemplateColumns.split(" ").filter(Boolean).length;
    const tile = node.querySelector<HTMLElement>(".capture-tile");
    const title = node.querySelector("h3");
    const rowH = tile ? tile.getBoundingClientRect().height + gap : 0;
    const headerH = title
      ? title.getBoundingClientRect().bottom - node.getBoundingClientRect().top + gap
      : 0;
    const groupGap = Number.parseFloat(getComputedStyle(body).rowGap) || 0;
    if (cols === 0 || rowH === 0) return;
    const prev = groupGeo.current;
    if (
      prev.cols === cols &&
      Math.abs(prev.rowH - rowH) < 0.5 &&
      Math.abs(prev.rowGap - gap) < 0.5 &&
      Math.abs(prev.headerH - headerH) < 0.5 &&
      Math.abs(prev.groupGap - groupGap) < 0.5
    ) {
      return;
    }
    groupGeo.current = { cols, rowH, rowGap: gap, headerH, groupGap };
    setGeoSeen((value) => value + 1);
  }, [galleryBody, sectionsOn, countsKey, view.width]);

  useEffect(() => {
    if (!safetyReady) return;
    const controller = new AbortController();
    const qs = assetSearchParams({ ...filterQuery, view: "ids" });
    void api<{ ids: string[] }>(`capture/assets?${qs}`, {
      signal: controller.signal,
    })
      .then((body) => {
        if (!controller.signal.aborted) setOrderIds(body.ids);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        fail(messageOf(err));
      });
    return () => controller.abort();
  }, [filterQuery, revision, safetyReady]);

  useEffect(() => {
    if (!query || !safetyReady) return;
    const controller = new AbortController();
    const qs = assetSearchParams({
      statuses: filterQuery.statuses,
      ratings: filterQuery.ratings,
      safe: filterQuery.safe,
      datasetId: filterQuery.datasetId,
    });
    void api<{ tags: Array<{ tag: string; count: number }> }>(
      `capture/assets/tags?${qs}`,
      { signal: controller.signal },
    )
      .then((body) => {
        if (controller.signal.aborted) return;
        setTagCounts(
          new Map(body.tags.map((item) => [item.tag, item.count])),
        );
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        fail(messageOf(err));
      });
    return () => controller.abort();
  }, [filterQuery, query, revision, safetyReady]);

  useEffect(() => {
    if (virtual) return;
    const ids = browseKey === "" ? [] : browseKey.split("\n");
    let stop = false;
    void fetchAssetsByIds(ids)
      .then((list) => {
        if (!stop) setPool(new Map(list.map((item) => [item.id, item])));
      })
      .catch((err: unknown) => {
        if (!stop) fail(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, [browseKey, virtual]);

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
    if (!orderIds.includes(selectedId)) {
      setNearError("当前图片不在筛选结果里");
      return;
    }
    const count = Number(topN);
    if (!Number.isInteger(count) || count < 1) {
      setNearError("N 必须是正整数");
      return;
    }
    if (orderIds.length < 2) {
      setNearError("筛选结果里没有其它图片");
      return;
    }
    setNearBusy(true);
    setNearError(null);
    try {
      const params = new URLSearchParams({
        k: String(count),
        order,
      });
      const scope = assetSearchParams(filterQuery);
      const qs = scope === "" ? params.toString() : `${params}&${scope}`;
      const result = await api<{ neighbors: Array<{ id: string }> }>(
        `capture/assets/${encodeURIComponent(selectedId)}/nearest?${qs}`,
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
    const ids = orderIds;
    if (ids.length === 0) {
      setGroupError("没有可分组的图片");
      return;
    }
    setGroupBusy(true);
    setGroupError(null);
    try {
      const result = await api<{
        groups: Array<{ ids: string[]; centerId?: string | null }>;
        skipped: string[];
        stale?: string[];
      }>("capture/assets/groups", {
        method: "POST",
        body: JSON.stringify({ ids, groups: count }),
      });
      // 分组落库：聚类是全局依赖的，每次重算边界都会变，人整理过的组号必须留住。
      await api("capture/groups", {
        method: "PUT",
        body: JSON.stringify({
          groups: result.groups.map((group) => ({
            ids: group.ids,
            centerId: group.centerId ?? null,
          })),
        }),
      });
      setGrouped({
        key: "",
        groups: result.groups.map((group) => group.ids),
        skipped: result.skipped,
        stale: result.stale ?? [],
        global: true,
      });
      setDiverse(null);
      setDiverseError(null);
    } catch (err) {
      setGroupError(messageOf(err));
    } finally {
      setGroupBusy(false);
    }
  }

  async function rebuildVectors() {
    setGroupBusy(true);
    setGroupError(null);
    try {
      const result = await api<{ queued: number }>(
        "capture/embeddings/rebuild",
        { method: "POST" },
      );
      setGroupError(
        result.queued === 0
          ? "没有需要重建的向量"
          : `已排入 ${result.queued} 张图的向量重建，跑完再分组`,
      );
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
    const ids = orderIds;
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
        groups: Array<{ ids: string[]; centerId?: string | null }>;
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
    // 分组是存下来的资产，重置视图时一起清掉，否则刷新又回来了。
    void api<{ ok: boolean }>("capture/groups", { method: "DELETE" }).catch(
      () => undefined,
    );
  }

  async function attachNew() {
    setGroupBusy(true);
    setGroupError(null);
    try {
      const result = await api<{ assigned: number }>("capture/groups/assign", {
        method: "POST",
      });
      await loadSavedGroups();
      setGroupError(
        result.assigned > 0 ? `已挂靠 ${result.assigned} 张新图` : "没有待挂靠的图",
      );
    } catch (err) {
      setGroupError(messageOf(err));
    } finally {
      setGroupBusy(false);
    }
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

  /**
   * 分组视图的视窗裁剪：位置全部由「列数 / 行高 / 标题高 / 组间距」推算，
   * 不量任何被裁剪影响的高度，所以反复渲染不会累积误差也不会抖。
   * 整组在视窗外就留一块等高空白，在视窗内就按行切一段。
   */
  function clipGroups(lists: ImageAsset[][], open: boolean[]) {
    const { cols, rowH, rowGap, headerH, groupGap } = groupGeo.current;
    // 折叠后组里只剩标题：高度就是 h3 本身，不含标题与格子之间的行间距。
    const headH = Math.max(0, headerH - rowGap);
    const plain = lists.map((list) => ({
      start: 0,
      end: list.length,
      padTop: 0,
      padBottom: 0,
    }));
    if (cols === 0 || rowH === 0) return plain;
    const from = view.top - GROUP_OVERSCAN;
    const to = view.top + view.height + GROUP_OVERSCAN;
    let top = 0;
    return lists.map((list, index) => {
      const count = list.length;
      const rows = Math.ceil(count / cols);
      const folded = open[index] === false;
      // 网格最后一行后面没有行间距，所以整组高度扣掉一个 rowGap。
      const height = folded || count === 0 ? headH : headerH + rows * rowH - rowGap;
      const current = top;
      top += height + groupGap;
      if (folded || count === 0) {
        return { start: 0, end: 0, padTop: 0, padBottom: 0 };
      }
      if (current + height <= from || current >= to) {
        // 标题本来就在，占位只需补上标题之外的剩余高度。
        return { start: 0, end: 0, padTop: 0, padBottom: Math.max(0, height - headerH) };
      }
      const startRow = Math.max(0, Math.floor((from - current - headerH) / rowH) - 1);
      const endRow = Math.min(rows, Math.ceil((to - current - headerH) / rowH) + 1);
      const start = Math.min(count, startRow * cols);
      const end = Math.min(count, endRow * cols);
      if (start === 0 && end === count) return plain[index] as (typeof plain)[number];
      const tail = rows - endRow;
      // 占位自己是一行，会各带一个行间距；从占位高度里扣回来，整组高度才和未裁剪时一致。
      if (tail === 0) {
        return {
          start,
          end,
          padTop: Math.max(0, startRow * rowH - rowGap),
          padBottom: 0,
        };
      }
      return {
        start,
        end,
        padTop: startRow * rowH,
        padBottom: Math.max(0, tail * rowH - rowGap * (startRow > 0 ? 2 : 1)),
      };
    });
  }

  function toggleGroup(key: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
  // 组 + 「未分组」一起排队算位置，裁剪区间按同一个坐标系给。
  const clips = sections ? clipGroups([...sections, skipped], openGroups) : [];

  return (
    <section className={"panel capture-gallery" + (query ? " gallery-has-arrange" : "")}>
      <div className="column-head">
        <h2>图库</h2>
        <div className="gallery-head-actions">
          <span className="muted">
            {datasetOnly && datasetFocus ? `「${datasetFocus.name}」 · ` : ""}
            {query ? `显示 ${virtual ? total : browseIds.length} · ` : ""}
            完成 {done}
            {processing > 0 ? ` · 处理中 ${processing}` : ""}
          </span>
          {onSafety ? (
            <SafetySwitch
              enabled={safety}
              disabled={!safetyReady}
              onChange={onSafety}
            />
          ) : null}
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
              {RATINGS.filter((rating) => !safety || !isSafetyHiddenRating(rating)).map((rating) => {
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
        {!loaded || !safetyReady ? (
          <p className="muted">加载中…</p>
        ) : virtual && total === 0 ? (
          <p className="muted">
            {datasetOnly && datasetFocus && datasetFocus.members.size === 0
              ? `「${datasetFocus.name}」里还没有图片。`
              : safety &&
                  statusFilter.length === 0 &&
                  ratingFilter.length === 0 &&
                  tagFilter.length === 0 &&
                  unsafe > 0
                ? "安全模式已隐藏标记为可疑和露骨的图片。"
                : statusFilter.length === 0 &&
                    ratingFilter.length === 0 &&
                    tagFilter.length === 0 &&
                    !datasetOnly
                  ? "还没有图片。"
                  : "没有符合筛选的图片。"}
          </p>
        ) : sections ? (
          <>
            {sections.map((group, index) => {
              const clip = clips[index];
              const open = openGroups[index] !== false;
              const groupKey = groupKeys[index];
              return (
                <section
                  key={grouped?.groups[index]?.join(",") || index}
                  className="gallery-group"
                  ref={(node) => {
                    groupRefs.current[index] = node;
                  }}
                >
                  <h3>
                    <button
                      type="button"
                      className="gallery-group-head"
                      aria-expanded={open}
                      title={open ? "折叠这一组" : "展开这一组"}
                      onClick={() => toggleGroup(groupKey)}
                    >
                      <span className="gallery-group-caret" aria-hidden="true">
                        ▾
                      </span>
                      <span>
                        组 {index + 1} · {grouped?.groups[index]?.length ?? group.length}
                      </span>
                    </button>
                  </h3>
                  {open ? (
                    <>
                      {clip && clip.padTop > 0 ? (
                        <div className="gallery-group-pad" style={{ height: clip.padTop }} />
                      ) : null}
                      {renderTiles(clip ? group.slice(clip.start, clip.end) : group)}
                      {clip && clip.padBottom > 0 ? (
                        <div className="gallery-group-pad" style={{ height: clip.padBottom }} />
                      ) : null}
                    </>
                  ) : null}
                </section>
              );
            })}
            {grouped && grouped.skipped.length > 0
              ? (() => {
                  const clip = clips[sections.length];
                  const open = openGroups[sections.length] !== false;
                  return (
                    <section
                      className="gallery-group"
                      ref={(node) => {
                        groupRefs.current[sections.length] = node;
                      }}
                    >
                      <h3>
                        <button
                          type="button"
                          className="gallery-group-head"
                          aria-expanded={open}
                          title={open ? "折叠这一组" : "展开这一组"}
                          onClick={() => toggleGroup(SKIPPED_GROUP_KEY)}
                        >
                          <span className="gallery-group-caret" aria-hidden="true">
                            ▾
                          </span>
                          <span>未分组 · {grouped.skipped.length}</span>
                        </button>
                      </h3>
                      {open ? (
                        <>
                          {clip && clip.padTop > 0 ? (
                            <div className="gallery-group-pad" style={{ height: clip.padTop }} />
                          ) : null}
                          {renderTiles(clip ? skipped.slice(clip.start, clip.end) : skipped)}
                          {clip && clip.padBottom > 0 ? (
                            <div className="gallery-group-pad" style={{ height: clip.padBottom }} />
                          ) : null}
                        </>
                      ) : null}
                    </section>
                  );
                })()
              : null}
            {grouped && grouped.stale.length > 0 ? (
              <p className="gallery-query-error">
                {grouped.stale.length} 张图的向量来自旧模型，已跳过。
                <button
                  type="button"
                  className="quiet"
                  disabled={groupBusy}
                  onClick={() => void rebuildVectors()}
                >
                  重建向量
                </button>
              </p>
            ) : null}
          </>
        ) : flat ? (
          renderTiles(flat)
        ) : (
          <>
            {padTop > 0 ? (
              <div className="capture-gallery-pad" style={{ height: padTop }} />
            ) : null}
            {renderTiles(items)}
            {padBottom > 0 ? (
              <div className="capture-gallery-pad" style={{ height: padBottom }} />
            ) : null}
          </>
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
            disabled={sampleBusy || orderIds.length === 0}
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
            disabled={groupBusy || orderIds.length === 0}
            onClick={() => void runGroups()}
          >
            {groupBusy ? "分组中…" : "分组"}
          </button>
          {grouped?.global ? (
            <button
              type="button"
              className="quiet"
              disabled={groupBusy}
              title="把上次分组之后新加的图挂到最接近的组"
              onClick={() => void attachNew()}
            >
              挂靠新图
            </button>
          ) : null}
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

function galleryWindow(body: HTMLElement, total: number) {
  const style = getComputedStyle(body);
  const gap = Number.parseFloat(style.rowGap) || Number.parseFloat(style.gap) || 7;
  const pad =
    (Number.parseFloat(style.paddingLeft) || 0) +
    (Number.parseFloat(style.paddingRight) || 0);
  const width = Math.max(1, body.clientWidth - pad);
  const min = 92;
  const cols = Math.max(1, Math.floor((width + gap) / (min + gap)));
  const tile = (width - gap * (cols - 1)) / cols;
  const row = Math.max(48, tile - 4) + 4 + gap;
  const overscan = 2;
  // 容器还没拿到高度时按一屏 720px 估，先取到第一页再说。
  const viewport = body.clientHeight > 0 ? body.clientHeight : 720;
  const firstRow = Math.max(0, Math.floor(body.scrollTop / row) - overscan);
  const lastRow = Math.ceil((body.scrollTop + viewport) / row) + overscan;
  const offset = firstRow * cols;
  const end = total > 0 ? Math.min(total, Math.max(offset + cols, lastRow * cols)) : lastRow * cols;
  const size = Math.min(200, Math.max(cols, end - offset));
  return { offset, size, cols, row };
}

function centersOf(
  groups: Array<{ ids: string[]; centerId?: string | null }>,
): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    if (group.ids.length === 0) continue;
    // 优先用后端给的 medoid（组内平均相似度最高的那张），没有才退回中间元素。
    if (group.centerId && group.ids.includes(group.centerId)) {
      ids.push(group.centerId);
      continue;
    }
    ids.push(group.ids[Math.floor((group.ids.length - 1) / 2)] as string);
  }
  return ids;
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
        <ZoomImage src={src} alt={label} zoomOn="double" draggable={false} />
      ) : src ? (
        <span className="capture-tile-pending" />
      ) : (
        <span className="capture-tile-missing">{statusLabel(status)}</span>
      )}
      <span className={`capture-badge ${status}`}>{statusLabel(status)}</span>
    </button>
  );
}
