import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import chalk from 'chalk';
import type { VitalsDB } from '../db/database';
import { RegressionDetector } from '../regression/detector';

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveHtmlPath(): string {
  // First try next to the compiled JS (dist/dashboard/dashboard.html)
  const nextToCompiled = path.join(__dirname, 'dashboard.html');
  if (fs.existsSync(nextToCompiled)) return nextToCompiled;

  // Fallback: source tree (../../src/dashboard/dashboard.html from dist/dashboard/)
  const inSourceTree = path.join(__dirname, '..', '..', 'src', 'dashboard', 'dashboard.html');
  if (fs.existsSync(inSourceTree)) return inSourceTree;

  throw new Error(`Cannot find dashboard.html. Looked at:\n  ${nextToCompiled}\n  ${inSourceTree}`);
}

export function serveDashboard(db: VitalsDB, port: number) {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';

    try {
      if (url === '/' || url === '/index.html') {
        const htmlPath = resolveHtmlPath();
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (url === '/api/metrics') {
        const metrics = db.getAllDailyMetricsForDashboard(90);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics));
        return;
      }

      if (url === '/api/changes') {
        const changes = db.getAllChanges();
        const changesWithImpact = changes.map((change) => ({
          ...change,
          impacts: db.getImpactResults(change.id),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(changesWithImpact));
        return;
      }

      if (url === '/api/health') {
        const detector = new RegressionDetector(db);
        const health = detector.getHealthStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
      }

      if (url === '/api/sessions') {
        const data = {
          count: db.getSessionCount(),
          toolCalls: db.getToolCallCount(),
          dateRange: db.getDateRange(),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      // 404 for anything else
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      console.error(chalk.red('Dashboard server error:'), message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.bold.cyan(`\n  Dashboard running at ${url}\n`));

    // Try to open in default browser
    (async () => {
      try {
        const open = (await import('open')).default;
        await open(url);
      } catch {
        // open package may not be installed — ignore silently
      }
    })();
  });

  return server;
}
