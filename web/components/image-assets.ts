"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { fail, messageOf } from "@/lib/notify";

export type ImageStatus = "collected" | "processed" | "approved" | "rejected";

export interface ImageAsset {
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
  rating?: string;
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

export type SlideKey = "raw" | "image" | "nobg";
export type FinalVersion = "raw" | "processed" | "nobg";

export const STATUSES: ImageStatus[] = [
  "collected",
  "processed",
  "approved",
  "rejected",
];

export const RATINGS = [
  "general",
  "sensitive",
  "questionable",
  "explicit",
] as const;

export type ImageRating = (typeof RATINGS)[number];

export function ratingLabel(rating: string | undefined): string {
  if (rating === "general") return "general · 普通";
  if (rating === "sensitive") return "sensitive · 敏感";
  if (rating === "questionable") return "questionable · 可疑";
  if (rating === "explicit") return "explicit · 露骨";
  return "未分级";
}

export function statusLabel(status: string): string {
  if (status === "collected") return "已采集";
  if (status === "processed") return "已处理";
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已拒绝";
  return status;
}

export function sizeText(item: ImageAsset): string {
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

export type AssetPageQuery = {
  offset: number;
  size: number;
  statuses: ImageStatus[];
  ratings: string[];
  tags: string[];
  safe: boolean;
  datasetId: string | null;
};

export type AssetPage = {
  total: number;
  offset: number;
  size: number;
  done: number;
  processing: number;
  unsafe: number;
  items: ImageAsset[];
};

export function assetSearchParams(
  query: Partial<AssetPageQuery> & { view?: "ids" },
): string {
  const params = new URLSearchParams();
  if (query.view) params.set("view", query.view);
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  if (query.size !== undefined) params.set("size", String(query.size));
  if (query.statuses && query.statuses.length > 0) {
    params.set("status", query.statuses.join(","));
  }
  if (query.ratings && query.ratings.length > 0) {
    params.set("rating", query.ratings.join(","));
  }
  for (const tag of query.tags ?? []) params.append("tag", tag);
  if (query.safe) params.set("safe", "1");
  if (query.datasetId) params.set("dataset", query.datasetId);
  return params.toString();
}

export async function fetchAssetsByIds(ids: string[]): Promise<ImageAsset[]> {
  const items: ImageAsset[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    const body = await api<{ items: ImageAsset[] }>("capture/assets/lookup", {
      method: "POST",
      body: JSON.stringify({ ids: ids.slice(index, index + 200) }),
    });
    items.push(...body.items);
  }
  return items;
}

export function useImageAssets() {
  const [page, setPage] = useState<AssetPage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [full, setFull] = useState<ImageAsset | null>(null);
  const [revision, setRevision] = useState(0);
  const queryRef = useRef<AssetPageQuery | null>(null);
  const pageRef = useRef<AssetPage | null>(null);
  const keyRef = useRef("");
  const genRef = useRef(0);
  const filterRef = useRef("");
  const headSeen = useRef(false);
  const headRef = useRef<string | null>(null);
  const selectedRef = useRef(selectedId);
  const fullRef = useRef(full);
  const itemsRef = useRef<ImageAsset[]>([]);
  const items = page?.items ?? [];
  selectedRef.current = selectedId;
  fullRef.current = full;
  itemsRef.current = items;
  pageRef.current = page;

  const applyHead = useCallback((head: string | null) => {
    if (!headSeen.current) {
      headSeen.current = true;
      headRef.current = head;
      if (head && !selectedRef.current) setSelectedId(head);
      return;
    }
    if (head && head !== headRef.current) setSelectedId(head);
    headRef.current = head;
  }, []);

  const loadPage = useCallback(
    async (query: AssetPageQuery, force = false) => {
      const filterKey = assetSearchParams({
        ...query,
        offset: undefined,
        size: undefined,
      });
      if (filterKey !== filterRef.current) {
        filterRef.current = filterKey;
        headSeen.current = false;
      }
      const key = assetSearchParams(query);
      if (!force && key === keyRef.current && pageRef.current) return;
      keyRef.current = key;
      queryRef.current = query;
      const gen = genRef.current + 1;
      genRef.current = gen;
      try {
        const body = await api<AssetPage>(`capture/assets?${key}`);
        if (gen !== genRef.current) return;
        pageRef.current = body;
        setPage(body);
        if (query.offset === 0) applyHead(body.items[0]?.id ?? null);
      } catch (err) {
        if (gen !== genRef.current) return;
        fail(messageOf(err));
      } finally {
        if (gen === genRef.current) setLoaded(true);
      }
    },
    [applyHead],
  );

  const refreshFull = useCallback(async (id: string) => {
    try {
      const asset = await api<ImageAsset>(
        `capture/assets/${encodeURIComponent(id)}`,
      );
      if (selectedRef.current === id) setFull(asset);
    } catch (err) {
      if (selectedRef.current !== id) return;
      setFull(null);
      if (err instanceof ApiError && err.status === 404) return;
      fail(messageOf(err));
    }
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setFull(null);
      return;
    }
    let stop = false;
    void api<ImageAsset>(`capture/assets/${encodeURIComponent(selectedId)}`)
      .then((asset) => {
        if (!stop) setFull(asset);
      })
      .catch((err: unknown) => {
        if (stop) return;
        setFull(null);
        if (err instanceof ApiError && err.status === 404) return;
        fail(messageOf(err));
      });
    return () => {
      stop = true;
    };
  }, [selectedId]);

  const loadItems = useCallback(async () => {
    const query = queryRef.current;
    if (query) await loadPage(query, true);
    const id = selectedRef.current;
    if (id) await refreshFull(id);
    setRevision((value) => value + 1);
  }, [loadPage, refreshFull]);

  useEffect(() => {
    if ((page?.processing ?? 0) <= 0) return;
    const timer = window.setInterval(() => {
      const query = queryRef.current;
      if (!query) return;
      void (async () => {
        await loadPage(query, true);
        if (query.offset > 0) {
          try {
            const head = await api<AssetPage>(
              `capture/assets?${assetSearchParams({ ...query, offset: 0, size: 1 })}`,
            );
            applyHead(head.items[0]?.id ?? null);
          } catch (err) {
            fail(messageOf(err));
          }
        }
        const id = selectedRef.current;
        const current = fullRef.current;
        if (id && current?.id === id && current.status === "collected") {
          await refreshFull(id);
        }
        setRevision((value) => value + 1);
      })();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [page?.processing, loadPage, applyHead, refreshFull]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const selected =
    full && full.id === selectedId
      ? full
      : (items.find((item) => item.id === selectedId) ?? null);

  return {
    items,
    total: page?.total ?? 0,
    pageOffset: page?.offset ?? 0,
    done: page?.done ?? 0,
    processing: page?.processing ?? 0,
    unsafe: page?.unsafe ?? 0,
    loaded,
    selected,
    selectedId,
    itemsRef,
    selectedRef,
    revision,
    loadPage,
    loadItems,
    select,
  };
}
