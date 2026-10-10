import type { NextConfig } from "next";

// The API runs separately (apps/api). Proxying through the web origin keeps
// auth cookies first-party and avoids CORS.
const apiUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Shared zod contracts are published as TypeScript source.
  transpilePackages: ["@cybercheck/contracts"],
  partialPrefetching: true,
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiUrl}/api/auth/:path*` },
      { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        // Only our own stylesheets: 'foreign' covers node_modules and Next.js
        // internals such as next/font's generated CSS, which the Tailwind
        // loader would otherwise rewrite and break.
        condition: { not: "foreign" },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
