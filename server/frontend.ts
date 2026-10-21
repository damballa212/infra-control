import express from 'express';
import { basename, extname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
/** Mount only after API/health routes, including the API 404 handler. */
export function mountFrontend(app: express.Express, directory: string) {
  const root = resolve(directory);
  if (!existsSync(resolve(root, 'index.html'))) throw new Error('Frontend build missing');
  app.use(express.static(root, {
    index: false, dotfiles: 'deny', redirect: false,
    setHeaders(res, file) {
      const name = basename(file);
      const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2|svg|png)$/.test(name);
      res.setHeader('Cache-Control', name === 'index.html' ? 'no-store' : hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.get('/{*path}', (req, res, next) => {
    const pathname = decodeURIComponent(req.path);
    if (pathname.split('/').some(segment => segment.startsWith('.')) || pathname.startsWith('/assets/') || pathname.startsWith('/health/') || extname(pathname) || !req.accepts('html')) return next();
    res.set('Cache-Control', 'no-store');
    res.sendFile(resolve(root, 'index.html'));
  });
}
