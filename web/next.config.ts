import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ['192.168.8.226'],
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
}

export default nextConfig
