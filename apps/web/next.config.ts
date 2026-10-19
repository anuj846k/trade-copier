import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed as TypeScript source (no build step needed).
  transpilePackages: ['@trade-copier/contracts'],
  experimental: {
    // Server Actions handle the BFF mutations; keep the body limit modest.
    serverActions: { bodySizeLimit: '1mb' },
  },
  /**
   * The internal packages are ESM written for Node: relative imports carry a
   * `.js` extension (`./platform.js`) even though the file on disk is
   * `platform.ts`. Node and `tsc` resolve that natively; webpack does not, so
   * teach it to look at the TypeScript file first. Without this the dashboard
   * cannot import any shared contract.
   */
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
