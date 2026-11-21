import type { NextConfig } from "next";

const config: NextConfig = {
  // Database drivers and the queue run on Node and are not bundled.
  serverExternalPackages: ["pg-boss", "postgres", "exceljs", "google-auth-library"],
  poweredByHeader: false,
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
        ],
      },
    ];
  },
};

export default config;
