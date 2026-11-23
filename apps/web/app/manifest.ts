import type { MetadataRoute } from "next";

/** Lets the dashboard be installed on a phone's home screen, like the Spir bot panel. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Scrapers",
    short_name: "Scrapers",
    description: "عملاء محتملون من البيانات العامة على إنستقرام",
    start_url: "/",
    display: "standalone",
    dir: "rtl",
    lang: "ar",
    background_color: "#f6f7fb",
    theme_color: "#5b5bf7",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    // Android: "Share" from any app (Instagram, TikTok, YouTube, a browser) lists Scrapers.
    share_target: {
      action: "/share",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  } as MetadataRoute.Manifest;
}
