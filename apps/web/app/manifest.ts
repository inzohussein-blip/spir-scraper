import type { MetadataRoute } from "next";

/** Lets the dashboard be installed on a phone's home screen and open like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Scrapers",
    short_name: "Scrapers",
    description: "عملاء محتملون من البيانات العامة على إنستقرام",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    dir: "rtl",
    lang: "ar",
    background_color: "#f6f7fb",
    theme_color: "#5b5bf7",
    // PNG for Android's install prompt (192 and 512), a maskable one for its
    // adaptive icons, and the SVG for desktops. iOS uses apple-touch-icon.png.
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    // Long-press the app icon (Android) to jump straight to these.
    shortcuts: [
      {
        name: "تشغيل أداة",
        short_name: "المتجر",
        url: "/store",
        icons: [{ src: "/icon-192.png", sizes: "192x192" }],
      },
      { name: "التشغيلات", url: "/runs", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
      { name: "العملاء", url: "/leads", icons: [{ src: "/icon-192.png", sizes: "192x192" }] },
    ],
    // Android: "Share" from any app (Instagram, TikTok, YouTube, a browser) lists Scrapers.
    share_target: {
      action: "/share",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  } as MetadataRoute.Manifest;
}
