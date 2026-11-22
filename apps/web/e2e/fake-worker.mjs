// Stands in for services/ig-worker in end-to-end tests: deterministic public profiles, no Instagram.
import http from "node:http";

const secret = process.env.WORKER_SHARED_SECRET ?? "e2e";
const port = Number(process.env.FAKE_WORKER_PORT ?? 8765);

http
  .createServer((req, res) => {
    if (req.headers["x-worker-secret"] !== secret) return res.writeHead(401).end();
    const u = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    if (u === "ghost") return res.writeHead(404).end("not found");
    const n = Number(u.replace(/\D/g, "")) || 0;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        igUserId: String(1000 + n),
        username: u,
        isBusiness: n % 2 === 0,
        isVerified: false,
        followers: 500 + n,
        city: n % 2 === 0 ? "القاهرة" : null,
        bio: n % 2 === 0 ? `مدرب تداول. للتواصل ٠١٠٠${String(1000000 + n).slice(-7)}` : "hi",
        recentPosts: Array.from({ length: 6 }, () => ({ likes: 20, comments: 1 })),
      }),
    );
  })
  .listen(port, () => console.log(`fake worker on ${port}`));
