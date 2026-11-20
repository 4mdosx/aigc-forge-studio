import { PinSettings } from '@/components/pin-settings'
import { SettingsBoard } from '@/components/settings-board'
import { getPinStatus } from '@/lib/auth-store'

function formatPinUpdated(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export default function Page() {
  const pin = getPinStatus()
  return (
    <>
      <PinSettings updatedLabel={formatPinUpdated(pin.updatedAt)} />
      <SettingsBoard />
    </>
  )
}
