/**
 * Cloudflare Worker — serves the Lagos Life Gift static site
 * and proxies API if needed (CORS is already enabled on the API).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve index.html for all routes (SPA-style)
    if (url.pathname === '/' || url.pathname === '/index.html' || !url.pathname.includes('.')) {
      // Try assets binding first (Workers Assets)
      if (env.ASSETS) {
        try {
          const asset = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
          if (asset.ok) return asset;
        } catch (_) {}
      }

      // Fallback: inline HTML is not ideal for large pages;
      // when deploying with `wrangler deploy`, assets are bound.
      return new Response('Deploy with: npx wrangler deploy\n(assets directory must include index.html)', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
