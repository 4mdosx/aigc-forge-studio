import { redirect } from 'next/navigation'

import { verifySession } from '@/lib/auth'
import { isPinConfigured } from '@/lib/auth-store'

import { PinAccessForm } from './pin-access-form'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'PIN · GOF',
}

export default async function LoginPage() {
  const configured = isPinConfigured()
  const session = await verifySession()
  if (configured && session.isAuth) redirect('/')

  return <PinAccessForm mode={configured ? 'unlock' : 'setup'} />
}
