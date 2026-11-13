import { WorkDetail } from '@/components/work-detail'

export default async function Page({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const { name } = await params
  return <WorkDetail name={decodeURIComponent(name)} />
}
