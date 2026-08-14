# 進捗台帳

自動開発サイクル間で状態を引き継ぐための台帳。**このファイルが進捗の正。**
各サイクルは「実装 → `npm run check` → テスト緑 → commit → push → 次サイクル予約」で閉じる。

計画: `/root/.claude/plans/5-graceful-marshmallow.md`（承認済み）
ブランチ: `claude/edinet-db-service-analysis-41enkl` / PR #21

---

## マイルストーン

- [x] **M0** CI解放 + 足場
- [x] **M1** `schema.sql` + `store/db.mjs` + `store/facts.mjs` — バイテンポラルの核
- [ ] **M2** 正規化2層（mapping / fallback / context / units）
- [ ] **M3** `edinet/client.mjs`（transport注入）+ `edinet/codelist.mjs`
- [ ] **M4** `query/financials.mjs` — **仮説の証明**（ここまで到達すれば目的達成）
- [ ] **M5** `mcp/server.mjs`（余力分）
- [ ] **M6** `gbiz/client.mjs` updateInfo差分（余力分）
- [ ] **M7** 仕上げ・要約

---

## 完了記録

### M0 — CI解放 + 足場

- `npm audit fix --omit=dev` で `package-lock.json` のみ更新（18行）。
  `fast-uri` 3.1.4→3.1.5 / `hono` 4.12.27→4.13.2 / `ip-address` 10.2.0→10.5.0。
  **`package.json` は無変更。** `npm audit` が 0 vulnerabilities になり、
  `quality` ジョブが green に。これで `needs: quality` の `test` / `coverage` が走り出す
- `prototype/edinet-pit/` に README と本台帳を配置
- `scripts/run-tests.js` を拡張し、`prototype/*/test/*.test.mjs` も `npm test` の対象に。
  プロトタイプのテストがCIで実際に走るようにするため。`test/` 側の探索挙動は変えていない
- `test/environment.test.mjs` で `node:sqlite` の実挙動を固定（3件緑）

**この段階で分かった実装上の注意**

- `node --test <dir>` はディレクトリを解決しない（`MODULE_NOT_FOUND`）。
  glob 指定が必要: `node --test prototype/edinet-pit/test/*.test.mjs`。
  `run-tests.js` はファイル単位で渡しているため影響なし
- **`node:sqlite` が返す行は null プロトタイプ。** 素の `assert.deepEqual` が通らず、
  `Object.prototype` 由来のメソッドを前提にしたコードも壊れる。
  → M1 のストア層で必ず通常のオブジェクトへ正規化する（`{ ...row }`）
- SQLite の三値論理は期待どおりで、`known_until IS NULL` を開区間として扱えることを確認。
  訂正の境界時刻は半開区間 `[known_from, known_until)` で新しい行に切り替わる

**M0の結果（CI実測）**: `quality` は green になり `coverage` も走った
（Lines 82.06% / Branches 71.36% / Functions 89.58%）。既存 `test/` 配下は
Node 18/20 でも通っており、問題なかった。

### M1 — バイテンポラルの核

- `schema.sql`: `companies` / `documents` / `facts` / `company_group` / `gbiz_facts`。
  Postgres移行を見据え `rowid`・`AUTOINCREMENT` 等のSQLite固有要素を使わない
- `store/db.mjs`: スキーマ適用、行を通常オブジェクトへ正規化、トランザクション
- `store/facts.mjs`: `recordDocument` / `recordFacts` / `getFactsAsOf` / `getFactHistory`
- `test/facts.test.mjs` 15件緑

**設計の要点 — reseal 方式**

各ファクトは `known_from` のみ付けて挿入し、その後シリーズ全体を
`resealSeries()` で再封する（`known_until` = 次行の `known_from`、最終行は NULL）。
reseal は「今ある行の純関数」なので、

- **取り込み順に依存しない** — バックフィルは提出順に来ない。2015年の書類が
  2024年の後に届いても同じタイムラインに収束する
- **冪等** — 同じ書類を再投入しても結果が変わらない

連続する同一値（value・unit・accounting_basis が一致）は最古の行に畳む。
訂正報告書は一部だけを訂正し残りは同じ値で再提出するため、畳まないと
**存在しない訂正イベントを捏造してしまう**。畳んだ結果残る `known_from` が
「その値が最初に知り得た時刻」になる。

**M0で入れた回帰とその修正（重要）**

`run-tests.js` に `prototype/*/test` を足したことで **Node 18/20 の `test` ジョブを
壊した**。`node:sqlite` は Node 22 以降にしか存在せず（Node 20 実機で
`ERR_UNKNOWN_BUILTIN_MODULE` を確認）、パッケージは `engines: node >=18` で
CIは18/20/22のマトリクスを回す。
→ `run-tests.js` に Node major >= 22 のゲートを追加し、それ未満ではスキップ。
既存 `test/` 配下の探索挙動は変えていない。

---

## 設計上の決定

| 決定 | 理由 |
|---|---|
| ストアは `node:sqlite` | 新規依存ゼロで実SQLエンジン。SQLはPostgres移行を見据えて書く |
| `known_from` / `known_until` のバイテンポラル | 訂正を上書きせず追加。`as_of` で時点復元。これがPITの核 |
| 全ファクトに `source_doc_id` + `source_element_id` | 監査可能性を不変条件にする。後付けは不可能 |
| プロトタイプは `prototype/edinet-pit/` に隔離 | 本リポジトリはIEモード移行VRTツールで別プロダクト。`package.json` の `files` は許可リスト方式なのでnpmには同梱されない。将来は独立リポジトリへ抽出 |
| `scripts/run-tests.js` を拡張 | プロトタイプのテストをCIで走らせる唯一の手段。`ci.yml` は触らない |
| マッピング表はJSON | YAMLパーサ依存を避ける |

---

## 自動運転の制約（越えないこと）

- 新規リポジトリを作らない
- `main` に push しない。`claude/edinet-db-service-analysis-41enkl` のみ
- PRをマージしない
- `npm audit fix` 以外の依存追加をしない
- gBizINFO の動作確認用トークンをコード・テストに埋め込まない
- 判断が分かれる設計変更は、勝手に決めず下記「論点」に記録し、実装は保守的な側を選ぶ

---

## 論点（起床後に判断が必要なもの）

- なし（M0時点）

---

## 実データ未検証の項目

開発環境のegressポリシーにより以下は**未実行**。ネットワークのある環境で確認が必要。

- `EdinetcodeDlInfo.csv` の法人番号充足率（`docs/research/scripts/edinet-corporate-number-coverage.mjs --fetch`）
- EDINET API v2 の実応答形状（フィクスチャは仕様書ベースの合成データ）
- gBizINFO v2 の実応答形状・リクエスト上限
