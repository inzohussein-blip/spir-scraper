import type { NextConfig } from "next";

const config: NextConfig = {
  // Database drivers and the queue run on Node and are not bundled.
  serverExternalPackages: ["pg-boss", "postgres", "google-auth-library"],
  poweredByHeader: false,
  experimental: {
    // Pages visited in the last 30 seconds come back instantly from the browser's
    // router cache; any change (a server action) refreshes them.
    staleTimes: { dynamic: 30, static: 300 },
  },
  // Clients may ask for path-suffixed metadata (RFC 9728 / RFC 8414), e.g. /.well-known/oauth-protected-resource/api/mcp.
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/.well-known/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/.well-known/oauth-authorization-server",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
        ],
      },
    ];
  },
};

export default config;
