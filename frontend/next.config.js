/** @type {import('next').NextConfig} */
const nextConfig = {
  // Remove static export - use Cloudflare Pages built-in Next.js support
  images: {
    unoptimized: true,
  },
}

module.exports = nextConfig
