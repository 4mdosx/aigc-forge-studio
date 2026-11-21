import { LibraryBoard } from '@/components/library-board'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ work?: string | string[] }>
}) {
  const query = await searchParams
  const work = Array.isArray(query.work) ? query.work[0] : query.work
  return <LibraryBoard initialWork={work || null} />
}
