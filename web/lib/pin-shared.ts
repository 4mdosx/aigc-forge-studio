export const PIN_LENGTH = 4

const pinPattern = new RegExp(`^\\d{${PIN_LENGTH}}$`)

export type PinFieldErrors = Record<string, string[] | undefined>

export function isPin(value: unknown): value is string {
  return typeof value === 'string' && pinPattern.test(value)
}

export function pinLengthMessage(): string {
  return `PIN 需为 ${PIN_LENGTH} 位数字`
}
