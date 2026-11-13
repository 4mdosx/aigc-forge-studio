import { toast } from 'sonner'

export function notify(message: string) {
  toast.success(message)
}

export function tell(message: string) {
  toast(message)
}

export function fail(message: string) {
  toast.error(message, { duration: 6400 })
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
