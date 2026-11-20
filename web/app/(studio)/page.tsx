import { HomeBoard } from '@/components/home-board'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ work?: string | string[] }>
}) {
  const query = await searchParams
  const work = Array.isArray(query.work) ? query.work[0] : query.work
  return <HomeBoard initialWork={work || null} />
}
