import { WorkflowDetail } from '@/components/workflow-detail'

export default async function Page({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const { name } = await params
  return <WorkflowDetail name={decodeURIComponent(name)} />
}
