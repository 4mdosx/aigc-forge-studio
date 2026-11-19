"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
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

export function useImageAssets() {
  const [items, setItems] = useState<ImageAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const knownIds = useRef<Set<string> | null>(null);
  const selectedRef = useRef(selectedId);
  const itemsRef = useRef<ImageAsset[]>([]);
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

  useEffect(() => {
    if (!items.some((item) => item.status === "collected")) return;
    const timer = setInterval(() => void loadItems(), 2500);
    return () => clearInterval(timer);
  }, [items, loadItems]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  return {
    items,
    loaded,
    selected,
    selectedId,
    itemsRef,
    selectedRef,
    loadItems,
    select,
  };
}
