import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
}

export default nextConfig
