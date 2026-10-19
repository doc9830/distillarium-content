#!/usr/bin/env node
// Локальный сервер редактора контента.
//
// Запуск:  npm run editor
//          node tools/editor/server.mjs --port 4173
//
// Слушает только 127.0.0.1: это инструмент автора, а не сетевая админка.
// Публикация выполняется обычным git push из рабочей копии репозитория.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, ContentStore, DEFAULT_ROOT } from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, status, data) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, "слишком большой запрос"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new ApiError(400, `некорректный JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function assertLocalRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    throw new ApiError(403, "редактор принимает запросы только с localhost");
  }
}

function apiArticleId(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/articles/(.+)/${suffix}$`)
    : /^\/api\/articles\/(.+)$/;
  const match = pattern.exec(pathname);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ApiError(400, "некорректный id статьи в адресе");
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return sendText(res, 400, "некорректный путь");
  }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return sendText(res, 403, "forbidden");
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendText(res, 404, "not found");
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

export function createHandler(store, publicDir = PUBLIC_DIR) {
  return async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;
    try {
      if (pathname.startsWith("/api/")) assertLocalRequest(req);

      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, root: store.root });
      }
      if (req.method === "GET" && pathname === "/api/state") {
        return sendJson(res, 200, store.state());
      }
      if (req.method === "POST" && pathname === "/api/check") {
        return sendJson(res, 200, { validation: store.validation() });
      }
      if (req.method === "POST" && pathname === "/api/build") {
        return sendJson(res, 200, store.build());
      }
      if (req.method === "POST" && pathname === "/api/publish") {
        const body = await readBody(req);
        return sendJson(res, 200, store.publish(body));
      }
      if (req.method === "POST" && pathname === "/api/media") {
        const body = await readBody(req, 12 * 1024 * 1024);
        return sendJson(res, 201, store.saveMedia(body));
      }
      if (req.method === "POST" && pathname === "/api/articles") {
        const body = await readBody(req);
        return sendJson(res, 201, store.createArticle(body));
      }

      const renameId = apiArticleId(pathname, "rename");
      if (req.method === "POST" && renameId) {
        const body = await readBody(req);
        return sendJson(res, 200, store.renameArticle(renameId, body.newId));
      }

      const articleId = apiArticleId(pathname);
      if (articleId && req.method === "GET") {
        return sendJson(res, 200, store.readArticle(articleId));
      }
      if (articleId && req.method === "PUT") {
        const body = await readBody(req);
        return sendJson(res, 200, store.updateArticle(articleId, body));
      }
      if (articleId && req.method === "DELETE") {
        const redirect = url.searchParams.get("redirect") ?? "";
        return sendJson(res, 200, store.deleteArticle(articleId, redirect));
      }

      const dataMatch = /^\/api\/data\/(reference|recipes)\/([^/]+)$/.exec(pathname);
      if (dataMatch && req.method === "PUT") {
        const body = await readBody(req);
        const id = decodeURIComponent(dataMatch[2]);
        const validation =
          dataMatch[1] === "reference"
            ? store.saveReference(id, body.data)
            : store.saveRecipe(id, body.data);
        return sendJson(res, 200, { validation });
      }
      if (req.method === "PUT" && pathname === "/api/tree") {
        const body = await readBody(req);
        return sendJson(res, 200, store.saveTree(body.tree ?? body));
      }
      if (req.method === "PUT" && pathname === "/api/data/calculators") {
        const body = await readBody(req);
        return sendJson(res, 200, { validation: store.saveCalculators(body.data) });
      }
      if (req.method === "PUT" && pathname === "/api/data/redirects") {
        const body = await readBody(req);
        return sendJson(res, 200, { validation: store.saveRedirects(body.data) });
      }
      if (req.method === "PUT" && pathname === "/api/data/version") {
        const body = await readBody(req);
        return sendJson(res, 200, { validation: store.saveVersion(body.data) });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, pathname);
      }
      return sendJson(res, 404, { error: "неизвестный маршрут API" });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status >= 500) console.error(error);
      return sendJson(res, status, {
        error: error.message,
        details: error instanceof ApiError ? error.details : undefined,
      });
    }
  };
}


export function startServer({
  root = DEFAULT_ROOT,
  port = Number(process.env.PORT) || 4173,
  host = "127.0.0.1",
} = {}) {
  const store = new ContentStore(root);
  const server = http.createServer(createHandler(store));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({ server, store, url: `http://${host}:${address.port}` });
    });
  });
}

function parseArgs(argv) {
  const options = { port: undefined, root: undefined, host: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--root") options.root = path.resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Локальный редактор контента Distillarium");
      console.log("  --port <число>   порт (по умолчанию 4173)");
      console.log("  --host <адрес>   адрес (по умолчанию 127.0.0.1)");
      console.log("  --root <путь>    корень репозитория distillarium-content");
      process.exit(0);
    }
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  startServer(args)
    .then(({ url, store }) => {
      console.log(`Редактор: ${url}`);
      console.log(`Репозиторий: ${store.root}`);
      if (!store.gitState().userName) {
        console.warn("Внимание: не настроен git user.name — публикация будет недоступна.");
      }
    })
    .catch((error) => {
      console.error(`Не удалось запустить редактор: ${error.message}`);
      process.exit(1);
    });
}

