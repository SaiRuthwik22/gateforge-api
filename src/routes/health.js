// ─── Health Route ───────────────────────────────────────────────────────────

export default async function healthRoutes(app) {
  app.get('/health', async () => {
    return { status: 'ok', service: 'gateforge-api', timestamp: new Date().toISOString() };
  });
}
