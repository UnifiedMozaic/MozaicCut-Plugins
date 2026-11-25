#!/usr/bin/env node
// MozaicCut 独立プラグイン（.mzplug）のビルド・パッケージツール。
// Win / Mac 共通で動く wasm32 + WGSL 同梱の .mzplug を生成する（MozaicCut 本体の再ビルド不要）。
//
// 使い方:
//   node tools/build.mjs                     全プラグインを差分ビルド → dist/plugins/*.mzplug
//   node tools/build.mjs <名前>              指定した 1 つだけビルド（例: glow / dissolve）
//   node tools/build.mjs --force             キャッシュを無視して全ビルド
//   node tools/build.mjs --zip               dist/mozaiccut-plugins.zip + manifest.json + SHA256SUMS.txt を作成
//   node tools/build.mjs --sync-mozcut       ビルド後に隣の ../MozaicCut/build/plugins/ へ反映（即［再読込］可能）
//   node tools/build.mjs --out <dir>         出力先フォルダを指定
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX_PARAMS = 8;
const COPY_DIR = 'fx';
const MANIFEST_SECTION = 'mozaiccut.manifest';
const WGSL_SECTION = 'mozaiccut.wgsl';
const PLUGIN_ABI = 1;
const GPU_ABI = 1;
const META_ABI = 1;
const WASM_ENTRY = 'mzfx_apply';
const WASM_TRANS_ENTRY = 'mztr_apply';

const NAME = '[a-z0-9_]+';
const NUM = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const STR = '"([^"\\\\]*)"';
const RE_EFFECT = new RegExp(`^@effect\\s+(${NAME})\\s+${STR}\\s*$`);
const RE_PARAM = new RegExp(`^@param\\s+(${NAME})\\s+(${NUM})\\s+(${NUM})\\.\\.(${NUM})\\s+${STR}\\s*$`);
const RE_ALIAS = new RegExp(`^@alias\\s+(${NAME})\\s*$`);
const RE_REACH = new RegExp(`^@reach\\s+(${NAME})(?:\\s+(${NUM}))?(\\s+round)?(?:\\s+max\\s+(\\d+))?\\s*$`);
const RE_WHOLE = /^@whole\s*$/;
const RE_GPU = /^@gpu\s+([1-8])\s*$/;
const RE_LABEL = new RegExp(`^@label\\s+${STR}\\s*$`);
const RE_CATEGORY = /^@category\s+(color|blur|key|style|other)\s*$/;
const RE_INIT = new RegExp(`^@init\\s+(${NUM})\\s*$`);
const RE_THUMB_PAIR = new RegExp(`^([0-7])=(${NUM})$`);

function die(msg) {
  console.error(`mozaiccut-plugins: ${msg}`);
  process.exit(1);
}

function umHome() {
  const cands = [process.env.UM_HOME, path.join(ROOT, '..', 'UnifiedMozaic')].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'src', 'cli.ts'))) return c;
  }
  die('UnifiedMozaic コンパイラが見つかりません。環境変数 UM_HOME を設定するか、隣に UnifiedMozaic を配置してください');
}

function writeIfChanged(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { old = null; }
  if (old === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

function parsePlugin(file, text) {
  const base = path.basename(file, '.um');
  if (!new RegExp(`^${NAME}$`).test(base)) throw new Error(`${file}: ファイル名は英小文字・数字・_ だけにしてください`);
  const lines = text.split(/\r?\n/);
  const fx = {
    file, name: '', doc: '', label: '', category: '', init: null, thumb: [],
    line: 0, params: [], aliases: [], reach: null, whole: null, gpuPasses: 0,
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    if (!raw.startsWith('//')) break;
    const body = raw.slice(2).trim();
    if (!body.startsWith('@')) continue;
    const ln = i + 1;
    let m;
    if (body.startsWith('@effect')) {
      m = RE_EFFECT.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @effect の書き方が違います`);
      if (m[1] !== base) throw new Error(`${file}:${ln}: 効果名 '${m[1]}' がファイル名 '${base}' と違います`);
      fx.name = m[1];
      fx.doc = m[2];
      fx.line = ln;
    } else if (body.startsWith('@param')) {
      m = RE_PARAM.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @param の書き方が違います`);
      const [, name, d, lo, hi, doc] = m;
      const p = { name, def: Number(d), min: Number(lo), max: Number(hi), doc };
      if (!(p.min <= p.max) || p.def < p.min || p.def > p.max) throw new Error(`${file}:${ln}: @param の範囲が不正です`);
      if (fx.params.length >= FX_PARAMS) throw new Error(`${file}:${ln}: 引数は ${FX_PARAMS} 個までです`);
      fx.params.push(p);
    } else if (body.startsWith('@alias')) {
      m = RE_ALIAS.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @alias の書き方が違います`);
      fx.aliases.push({ name: m[1] });
    } else if (body.startsWith('@reach')) {
      m = RE_REACH.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @reach の書き方が違います`);
      fx.reach = { param: m[1], factor: m[2] === undefined ? 1 : Number(m[2]), round: !!m[3], max: m[4] === undefined ? null : Number(m[4]) };
    } else if (body.startsWith('@whole')) {
      if (!RE_WHOLE.test(body)) throw new Error(`${file}:${ln}: @whole の書き方が違います`);
      fx.whole = true;
    } else if (body.startsWith('@gpu')) {
      m = RE_GPU.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @gpu の書き方が違います`);
      fx.gpuPasses = Number(m[1]);
    } else if (body.startsWith('@label')) {
      m = RE_LABEL.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @label の書き方が違います`);
      fx.label = m[1];
    } else if (body.startsWith('@category')) {
      m = RE_CATEGORY.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @category は color / blur / key / style / other のどれかです`);
      fx.category = m[1];
    } else if (body.startsWith('@init')) {
      m = RE_INIT.exec(body);
      if (!m) throw new Error(`${file}:${ln}: @init の書き方が違います`);
      fx.init = Number(m[1]);
    } else if (body.startsWith('@thumb')) {
      const toks = body.slice('@thumb'.length).trim().split(/\s+/).filter(Boolean);
      if (toks.length === 0) throw new Error(`${file}:${ln}: @thumb の書き方が違います`);
      for (const tok of toks) {
        const pm = RE_THUMB_PAIR.exec(tok);
        if (!pm) throw new Error(`${file}:${ln}: @thumb '${tok}' の書き方が違います`);
        fx.thumb.push([Number(pm[1]), Number(pm[2])]);
      }
    } else {
      throw new Error(`${file}:${ln}: 知らない宣言 '${body.split(/\s/)[0]}' です`);
    }
  }
  if (!fx.name) throw new Error(`${file}: // @effect ${base} "<説明>" がありません`);
  if (fx.params.length === 0) throw new Error(`${file}: @param が 1 つ以上必要です`);
  return fx;
}

function parseTransition(file, text) {
  const lines = String(text).split(/\r?\n/);
  let name = '';
  let doc = '';
  let label = '';
  for (const line of lines) {
    const raw = line.trim();
    if (raw === '') continue;
    if (!raw.startsWith('//')) break;
    const body = raw.slice(2).trim();
    if (!body.startsWith('@')) continue;
    const mt = /^@transition\s+([a-z][a-z0-9_]*)\s+"([^"]*)"\s*$/.exec(body);
    if (mt) { name = mt[1]; doc = mt[2]; continue; }
    const ml = RE_LABEL.exec(body);
    if (ml) label = ml[1];
  }
  if (!name) throw new Error(`${file}:1: // @transition <名前> "<説明>" がありません`);
  return { file, name, doc, label, kind: 'transition' };
}

function leb128(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function readLeb(bytes, at) {
  let v = 0, shift = 0;
  for (;;) {
    if (at >= bytes.length || shift > 28) return null;
    const b = bytes[at++];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { v: v >>> 0, at };
    shift += 7;
  }
}

function sections(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
  const out = [];
  let at = 8;
  while (at < bytes.length) {
    const start = at;
    const id = bytes[at++];
    const size = readLeb(bytes, at);
    if (!size) return null;
    const end = size.at + size.v;
    if (end > bytes.length) return null;
    const s = { id, start, end };
    if (id === 0) {
      const nl = readLeb(bytes, size.at);
      if (!nl || nl.at + nl.v > end) return null;
      s.name = Buffer.from(bytes.subarray(nl.at, nl.at + nl.v)).toString('utf8');
      s.payloadStart = nl.at + nl.v;
    }
    out.push(s);
    at = end;
  }
  return out;
}

function setCustomSection(wasm, name, payload) {
  const bytes = Buffer.from(wasm);
  const secs = sections(bytes) || [];
  const keep = [bytes.subarray(0, 8)];
  for (const s of secs) if (!(s.id === 0 && s.name === name)) keep.push(bytes.subarray(s.start, s.end));
  const base = Buffer.concat(keep);
  const nameBytes = Buffer.from(name, 'utf8');
  const body = Buffer.concat([Buffer.from(leb128(nameBytes.length)), nameBytes, Buffer.from(payload)]);
  return Buffer.concat([base, Buffer.from([0]), Buffer.from(leb128(body.length)), body]);
}

function readCustomSection(bytes, name) {
  const secs = sections(bytes);
  if (!secs) return null;
  const s = secs.find((x) => x.id === 0 && x.name === name);
  return s ? Buffer.from(bytes.subarray(s.payloadStart, s.end)) : null;
}

function pluginUpToDate(src, outFile) {
  if (!fs.existsSync(outFile)) return false;
  try {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(src, 'utf8')).digest('hex');
    const sec = readCustomSection(fs.readFileSync(outFile), MANIFEST_SECTION);
    if (!sec) return false;
    const m = JSON.parse(sec.toString('utf8'));
    return m.abi === PLUGIN_ABI && m.gpuAbi === GPU_ABI && m.metaAbi === META_ABI && m.sourceSha256 === sha;
  } catch {
    return false;
  }
}

function buildOne(src, outFile, umCli) {
  const text = fs.readFileSync(src, 'utf8');
  const label = path.relative(ROOT, src).replace(/\\/g, '/');
  const isTrans = /^\s*\/\/\s*@transition\s+/m.test(text);
  const fx = isTrans ? parseTransition(label, text) : parsePlugin(label, text);
  const workName = isTrans ? `tr_${fx.name}` : fx.name;
  const work = path.join(ROOT, 'build', 'plugin', workName);
  const copy = path.join(work, COPY_DIR, `${fx.name}.um`);
  const entry = path.join(work, 'main.um');
  writeIfChanged(copy, text);
  const entryText = isTrans
    ? `import { tr_${fx.name} } from "./${COPY_DIR}/${fx.name}.um";\nexport function ${WASM_TRANS_ENTRY}(a: mut Buffer<vec4<f32>>, b: Buffer<vec4<f32>>, w: u32, h: u32, progress: f32, angle: f32, soft: f32, param: f32): void {\n  tr_${fx.name}(mut a, b, w, h, progress, angle, soft, param);\n}\n`
    : `import { fx_${fx.name} } from "./${COPY_DIR}/${fx.name}.um";\nexport function ${WASM_ENTRY}(layer: mut Buffer<vec4<f32>>, tmp: mut Buffer<vec4<f32>>, w: u32, h: u32, p0: f32, p1: f32, p2: f32, p3: f32, p4: f32, p5: f32, p6: f32, p7: f32): void {\n  const p: f32[8] = [p0, p1, p2, p3, p4, p5, p6, p7];\n  fx_${fx.name}(mut layer, mut tmp, w, h, p);\n}\n`;
  writeIfChanged(entry, entryText);
  const wasmPath = path.join(work, `${workName}.wasm`);
  const r = spawnSync(process.execPath, [umCli, 'build', entry, '--target', 'wasm32-plugin', '--emit-wgsl', '-o', wasmPath], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 26,
  });
  if (r.error) die(`コンパイラを起動できません: ${r.error.message}`);
  if (r.status !== 0) die(`${label} のビルドに失敗しました:\n${r.stdout || ''}${r.stderr || ''}`);
  const wasm = fs.readFileSync(wasmPath);
  const wgslKernelName = isTrans ? `tr_gpu_${fx.name}` : `fx_gpu_${fx.name}`;
  const wgslPath = `${wasmPath}.${wgslKernelName}.wgsl`;
  const wgslText = fs.existsSync(wgslPath) ? fs.readFileSync(wgslPath, 'utf8') : '';
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const manifest = isTrans
    ? {
      abi: PLUGIN_ABI, metaAbi: META_ABI, gpuAbi: GPU_ABI, gpuPasses: wgslText ? 1 : 0, kind: 'transition',
      name: fx.name, doc: fx.doc, ...(fx.label ? { label: fx.label } : {}),
      entry: WASM_TRANS_ENTRY, layer: 'rgba-f32-straight', source: path.basename(src), sourceSha256: sha,
    }
    : {
      abi: PLUGIN_ABI, metaAbi: META_ABI, gpuAbi: GPU_ABI,
      name: fx.name, doc: fx.doc,
      ...(fx.label ? { label: fx.label } : {}),
      ...(fx.category ? { category: fx.category } : {}),
      ...(fx.init !== null ? { init: fx.init } : {}),
      ...(fx.thumb.length > 0 ? { thumb: fx.thumb } : {}),
      entry: WASM_ENTRY,
      params: fx.params.map((p) => ({ name: p.name, default: p.def, min: p.min, max: p.max, doc: p.doc })),
      aliases: fx.aliases.map((a) => a.name),
      reach: fx.reach ? { param: fx.reach.param, factor: fx.reach.factor, round: fx.reach.round, max: fx.reach.max } : null,
      whole: !!fx.whole,
      gpuPasses: wgslText ? (fx.gpuPasses || 1) : 0,
      layer: 'rgba-f32-straight',
      source: path.basename(src),
      sourceSha256: sha,
    };
  let bytes = setCustomSection(wasm, MANIFEST_SECTION, Buffer.from(JSON.stringify(manifest), 'utf8'));
  if (wgslText) bytes = setCustomSection(bytes, WGSL_SECTION, Buffer.from(wgslText, 'utf8'));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bytes);
  return { name: fx.name, fileName: path.basename(outFile), isTrans, hasGpu: !!wgslText, bytes: bytes.length, manifest };
}

function listSources() {
  const out = [];
  const pdir = path.join(ROOT, 'plugins');
  if (fs.existsSync(pdir)) {
    for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.um')).sort()) {
      const name = f.slice(0, -3);
      out.push({ src: path.join(pdir, f), fileName: `${name}.mzplug`, isTrans: false, name });
    }
    const tdir = path.join(pdir, 'transitions');
    if (fs.existsSync(tdir)) {
      for (const f of fs.readdirSync(tdir).filter((n) => n.endsWith('.um')).sort()) {
        const name = f.slice(0, -3);
        out.push({ src: path.join(tdir, f), fileName: `tr_${name}.mzplug`, isTrans: true, name });
      }
    }
  }
  return out;
}

function createZip(pluginsDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  if (process.platform === 'win32') {
    const ps = `Compress-Archive -Path '${path.join(pluginsDir, '*.mzplug').replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    if (r.status !== 0) die(`zip の作成に失敗しました: ${r.stderr || r.stdout}`);
  } else {
    const r = spawnSync('zip', ['-9', '-j', '-q', zipPath, ...fs.readdirSync(pluginsDir).filter((n) => n.endsWith('.mzplug')).map((n) => path.join(pluginsDir, n))], { encoding: 'utf8' });
    if (r.status !== 0) die(`zip の作成に失敗しました: ${r.stderr || r.stdout}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  let force = false;
  let makeZip = false;
  let syncMozcut = false;
  let outDir = path.join(ROOT, 'dist', 'plugins');
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') force = true;
    else if (a === '--zip') makeZip = true;
    else if (a === '--sync-mozcut') syncMozcut = true;
    else if (a === '--out' || a === '-o') outDir = path.resolve(args[++i]);
    else targets.push(a);
  }
  const umCli = path.join(umHome(), 'src', 'cli.ts');
  const all = listSources();
  const items = targets.length > 0
    ? all.filter((it) => targets.includes(it.name) || targets.includes(it.fileName.replace(/\.mzplug$/, '')))
    : all;
  if (items.length === 0) die(`対象のプラグインが見つかりません: ${targets.join(', ')}`);

  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  let built = 0;
  let skipped = 0;
  for (const it of items) {
    const outFile = path.join(outDir, it.fileName);
    if (!force && pluginUpToDate(it.src, outFile)) {
      skipped++;
      continue;
    }
    const r = buildOne(it.src, outFile, umCli);
    console.error(`  built ${r.fileName} (${r.hasGpu ? 'GPU+CPU' : 'CPU'}, ${r.bytes} bytes)`);
    built++;
  }
  const ms = Date.now() - t0;
  console.error(`mozaiccut-plugins: ${items.length} 個（ビルド ${built}・最新スキップ ${skipped}、${ms} ms）→ ${path.relative(ROOT, outDir) || outDir}`);

  // manifest.json（全 .mzplug のカタログ）
  const catalog = [];
  for (const f of fs.readdirSync(outDir).filter((n) => n.endsWith('.mzplug')).sort()) {
    const full = path.join(outDir, f);
    const bytes = fs.readFileSync(full);
    const sec = readCustomSection(bytes, MANIFEST_SECTION);
    const m = sec ? JSON.parse(sec.toString('utf8')) : {};
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    catalog.push({
      file: f,
      name: m.name,
      kind: m.kind || 'effect',
      label: m.label || '',
      category: m.category || '',
      doc: m.doc || '',
      gpuPasses: m.gpuPasses || 0,
      bytes: bytes.length,
      sha256,
    });
  }
  const distDir = path.dirname(outDir);
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify({ abi: PLUGIN_ABI, metaAbi: META_ABI, count: catalog.length, plugins: catalog }, null, 2) + '\n', 'utf8');

  if (makeZip) {
    const zipPath = path.join(distDir, 'mozaiccut-plugins.zip');
    createZip(outDir, zipPath);
    const zipSha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    const manSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(distDir, 'manifest.json'))).digest('hex');
    fs.writeFileSync(path.join(distDir, 'SHA256SUMS.txt'), `${zipSha}  mozaiccut-plugins.zip\n${manSha}  manifest.json\n`, 'utf8');
    console.error(`mozaiccut-plugins: ${path.relative(ROOT, zipPath)} を作成しました（${fs.statSync(zipPath).size} bytes）`);
  }

  if (syncMozcut) {
    const mozcutRoot = path.resolve(ROOT, '..', 'MozaicCut');
    const dests = [
      path.join(mozcutRoot, 'build', 'plugins'),
      path.join(mozcutRoot, 'dist', 'MozaicCut', 'plugins'),
    ].filter((d) => fs.existsSync(path.dirname(d)));
    for (const d of dests) {
      fs.mkdirSync(d, { recursive: true });
      for (const it of items) {
        const srcPlug = path.join(outDir, it.fileName);
        if (fs.existsSync(srcPlug)) fs.copyFileSync(srcPlug, path.join(d, it.fileName));
      }
      console.error(`mozaiccut-plugins: ${items.length} 個を ${d} へ同期しました（MozaicCut の［再読込］で即反映）`);
    }
  }
}

main();
