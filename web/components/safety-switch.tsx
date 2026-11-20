'use client'

export function SafetySwitch({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      className="safety-switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
    >
      <span className="safety-switch-track" aria-hidden="true">
        <span className="safety-switch-knob" />
      </span>
      安全模式
    </button>
  )
}
