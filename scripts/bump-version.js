#!/usr/bin/env node

/**
 * バージョン管理スクリプト
 * package.jsonのバージョンをsemverに従ってインクリメントします
 *
 * 使用方法:
 *   node scripts/bump-version.js major  # 1.0.0 → 2.0.0
 *   node scripts/bump-version.js minor  # 0.1.0 → 0.2.0
 *   node scripts/bump-version.js patch  # 0.1.0 → 0.1.1
 */

const fs = require('fs');
const path = require('path');

const releaseType = process.argv[2];

if (!['major', 'minor', 'patch'].includes(releaseType)) {
  console.error('エラー: リリースタイプは major, minor, patch のいずれかである必要があります');
  console.error('使用方法: node scripts/bump-version.js [major|minor|patch]');
  process.exit(1);
}

const packagePath = path.join(__dirname, '../package.json');

if (!fs.existsSync(packagePath)) {
  console.error('エラー: package.json が見つかりません');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const currentVersion = pkg.version;

if (!currentVersion) {
  console.error('エラー: package.json に version フィールドがありません');
  process.exit(1);
}

// バージョンをパース
const versionMatch = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!versionMatch) {
  console.error(`エラー: 無効なバージョン形式です: ${currentVersion}`);
  process.exit(1);
}

const [, major, minor, patch] = versionMatch.map(Number);

// 新しいバージョンを計算
let newVersion;
switch (releaseType) {
  case 'major':
    newVersion = `${major + 1}.0.0`;
    break;
  case 'minor':
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case 'patch':
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
}

// package.jsonを更新
pkg.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

console.log(`バージョンを更新しました: ${currentVersion} → ${newVersion}`);
console.log(newVersion); // GitHub Actionsで出力を取得するため
