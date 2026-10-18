#!/usr/bin/env node
// Проверка готового пакета контента:
//   node tools/validate-content.mjs [путь к распакованному пакету]
//
// По умолчанию проверяется dist/content. Проверяются манифест, размеры и sha256
// каждого файла, обязательные поля, уникальность id, все ссылки [[…]],
// редиректы, медиа и индекс поиска. Любая ошибка — код возврата 1.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBytes, sha256 } from "./lib/content.mjs";
import { validatePackage } from "./lib/package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "dist", "content");

if (!fs.existsSync(target)) {
  console.error(`Пакет не найден: ${target}`);
  console.error("Сначала соберите его: node tools/build-content.mjs");
  process.exit(1);
}

console.log(`Проверка пакета: ${path.relative(process.cwd(), target) || "."}`);
const result = validatePackage(target);

// Если рядом лежит релизный манифест, сверяем и сам архив.
const releaseManifestPath = path.join(path.dirname(target), "manifest.json");
const packPath = path.join(path.dirname(target), "content-pack.zip");
if (fs.existsSync(releaseManifestPath) && fs.existsSync(packPath)) {
  try {
    const release = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
    const data = fs.readFileSync(packPath);
    if (data.length !== release.packSize) {
      result.errors.push(
        `content-pack.zip: размер ${data.length}, в манифесте ${release.packSize}`,
      );
    }
    if (sha256(data) !== release.packSha256) {
      result.errors.push("content-pack.zip: sha256 не совпадает с manifest.json");
    }
  } catch (error) {
    result.errors.push(`manifest.json релиза: ${error.message}`);
  }
}

const { stats } = result;
console.log(
  `  Статей: ${stats.total} (импортированных ${stats.imported}, ручных ${stats.manual}, прочих ${stats.other})`,
);
console.log(`  Файлов в манифесте: ${stats.files}`);
console.log(`  Ссылок проверено: ${stats.links}`);
console.log(`  Справочных таблиц: ${stats.tables}`);
console.log(`  Редиректов: ${stats.redirects}`);
console.log(`  Статей без источников: ${stats.withoutSources.length}`);
console.log(`  Размер распакованного пакета: ${formatBytes(measureDir(target))}`);

if (result.warnings.length) {
  console.log(`Предупреждений: ${result.warnings.length}`);
  for (const warning of result.warnings) console.log(`  ! ${warning}`);
}

if (result.errors.length) {
  console.error(`Ошибок: ${result.errors.length}`);
  for (const error of result.errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}

console.log("Пакет валиден: битых ссылок, дублей id и расхождений sha256 нет.");

function measureDir(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += measureDir(full);
    else total += fs.statSync(full).size;
  }
  return total;
}
