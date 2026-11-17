import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DiceBoard } from '@/components/dice-board'

export default function DicePage() {
  const role = JSON.parse(
    readFileSync(join(process.cwd(), '..', 'data', 'role.json'), 'utf8'),
  ) as unknown
  return <DiceBoard role={role} />
}
