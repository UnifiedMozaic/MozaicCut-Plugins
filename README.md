# MozaicCut-Plugins

[MozaicCut](https://github.com/UnifiedMozaic/MozaicCut) の映像効果・トランジションプラグイン（`.mzplug`）専用リポジトリです。

`.mzplug` は **WebAssembly（CPU フォールバック）＋ WGSL シェーダ（GPU 実行）＋ UI メタデータ（日本語表示名・カテゴリ・初期値・サムネイル設定）** を 1 ファイルに同梱した OS 非依存フォーマットのため、**1 回のビルドで Windows / macOS の両方でそのまま動作し、MozaicCut 本体の再ビルドは一切不要**です。

## 構成

- `plugins/*.um` — 映像効果プラグイン（42 個）
- `plugins/transitions/*.um` — トランジションプラグイン（16 個）
- `tools/build.mjs` — 差分ビルド・ZIP パッケージ・MozaicCut 同期スクリプト
- `.github/workflows/release.yml` — `v*` タグの push で `mozaiccut-plugins.zip` を自動リリース（Ubuntu 1 台で約 1 分）

## 新しいプラグインの追加・更新（MozaicCut 本体の再ビルド不要）

1. `plugins/<名前>.um`（または `plugins/transitions/<名前>.um`）を作成・編集します。
   先頭コメントで UI 表示情報まで完結して宣言できます：

```um
// @effect myfx "説明文"
// @label "日本語表示名"
// @category style
// @init 0.6
// @thumb 0=3
// @param amount 0.5 0..1 "強さ"
// @gpu 1
```

   - `@category`: `color` / `blur` / `key` / `style` / `other`
   - `@init`: 効果パネルから適用したときの初期値（省略時は第 1 引数の既定値）
   - `@thumb`: 効果パネルの小さな見本サムネイル用の上書き引数（例: `0=3 1=14`）

2. 変更したプラグインだけを約 1 秒でビルドし、隣の `MozaicCut` へ同期します：

```bash
node tools/build.mjs myfx --sync-mozcut
```

3. 起動中の MozaicCut の「効果」パネルの **［再読込］** を押すと、本体の再ビルドなしで即反映されます。

## 全プラグインのビルド・配布パッケージ作成

```bash
# 全プラグインを差分ビルド（変更なしなら数ミリ秒）
node tools/build.mjs

# 配布用 mozaiccut-plugins.zip + manifest.json + SHA256SUMS.txt を生成
node tools/build.mjs --zip
```

## リリース手順

```bash
git tag v0.1.0
git push origin main --tags
```

GitHub Actions が自動で `mozaiccut-plugins.zip` をビルドして Release に公開します。
MozaicCut 側からは `node tools/mozcut.mjs plugin fetch`（または `MOZCUT_PLUGINS_PREBUILT=1`）でビルド済みプラグイン一式を約 1 秒で取得できます。
