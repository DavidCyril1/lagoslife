/**
 * Cloudflare Worker — serves the Lagos Life Gift static site.
 */
export default {
  async fetch(request, env) {
    // Serve static assets (index.html, etc.)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Assets binding missing. Redeploy with wrangler.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
