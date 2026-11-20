import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ['127.0.0.1', 'localhost', '192.168.8.226'],
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
}

export default nextConfig
