'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '@/lib/api'
import { fail, messageOf } from '@/lib/notify'

export interface Dataset {
  id: string
  name: string
  count: number
  createdAt: number
  updatedAt: number
  assetIds: string[]
}

export function useDatasets() {
  const [items, setItems] = useState<Dataset[]>([])
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(0)
  const tail = useRef(Promise.resolve())

  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const run = tail.current.then(work, work)
    tail.current = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }, [])

  const reload = useCallback(async () => {
    await enqueue(async () => {
      setPending((count) => count + 1)
      try {
        const body = await api<{ datasets: Dataset[] }>('datasets')
        setItems(body.datasets)
      } finally {
        setLoaded(true)
        setPending((count) => count - 1)
      }
    })
  }, [enqueue])

  useEffect(() => {
    void reload().catch((err: unknown) => fail(messageOf(err)))
  }, [reload])

  const create = useCallback(
    async (name: string) => {
      return enqueue(async () => {
        setPending((count) => count + 1)
        try {
          const dataset = await api<Dataset>('datasets', {
            method: 'POST',
            body: JSON.stringify({ name }),
          })
          put(setItems, dataset)
          return dataset
        } finally {
          setPending((count) => count - 1)
        }
      })
    },
    [enqueue],
  )

  const rename = useCallback(
    async (id: string, name: string) => {
      return enqueue(async () => {
        setPending((count) => count + 1)
        try {
          const dataset = await api<Dataset>(`datasets/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name }),
          })
          put(setItems, dataset)
          return dataset
        } finally {
          setPending((count) => count - 1)
        }
      })
    },
    [enqueue],
  )

  const remove = useCallback(
    async (id: string) => {
      await enqueue(async () => {
        setPending((count) => count + 1)
        try {
          await api(`datasets/${encodeURIComponent(id)}`, { method: 'DELETE' })
          setItems((current) => current.filter((item) => item.id !== id))
        } finally {
          setPending((count) => count - 1)
        }
      })
    },
    [enqueue],
  )

  const addAssets = useCallback(
    async (id: string, assetIds: string[]) => {
      return enqueue(async () => {
        setPending((count) => count + 1)
        try {
          const dataset = await api<Dataset & { added: number }>(
            `datasets/${encodeURIComponent(id)}/assets`,
            { method: 'POST', body: JSON.stringify({ ids: assetIds }) },
          )
          put(setItems, dataset)
          return dataset
        } finally {
          setPending((count) => count - 1)
        }
      })
    },
    [enqueue],
  )

  const removeAssets = useCallback(
    async (id: string, assetIds: string[]) => {
      return enqueue(async () => {
        setPending((count) => count + 1)
        try {
          const dataset = await api<Dataset & { removed: number }>(
            `datasets/${encodeURIComponent(id)}/assets`,
            { method: 'DELETE', body: JSON.stringify({ ids: assetIds }) },
          )
          put(setItems, dataset)
          return dataset
        } finally {
          setPending((count) => count - 1)
        }
      })
    },
    [enqueue],
  )

  return {
    items,
    loaded,
    busy: pending > 0,
    reload,
    create,
    rename,
    remove,
    addAssets,
    removeAssets,
  }
}

function put(setItems: (update: (current: Dataset[]) => Dataset[]) => void, dataset: Dataset) {
  const next = stored(dataset)
  setItems((current) => {
    const rest = current.filter((item) => item.id !== next.id)
    rest.push(next)
    rest.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    return rest
  })
}

function stored(dataset: Dataset): Dataset {
  return {
    id: dataset.id,
    name: dataset.name,
    count: dataset.count,
    createdAt: dataset.createdAt,
    updatedAt: dataset.updatedAt,
    assetIds: dataset.assetIds,
  }
}
