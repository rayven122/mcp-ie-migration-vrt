# EDINET PIT プロトタイプ

有価証券報告書の財務データを **ポイントインタイム（PIT）** で返せるかを検証したプロトタイプ。

## 何を証明しようとしたか

既存のEDINETデータサービスは「現在の最新値」を返す。しかし訂正報告書で数値は後から変わる。
過去のある時点を分析するとき、**その時点では知り得なかった訂正後の数値**を使うと、
未来情報の混入（look-ahead bias）になる。クオンツのバックテストや学術研究では、
これがあるとデータそのものが使えない。

証明したい挙動は一点だった。

```
as_of('2024-06-01') → FY2023の売上高 = 訂正前の値（当時知り得た値）
as_of('2025-01-01') → FY2023の売上高 = 訂正後の値
                    + いつ・どの指標が・いくらから いくらへ訂正されたかの差分
```

## 結果：証明できた

```
$ node prototype/edinet-pit/src/cli.mjs demo

# FY2023 net_sales as of 2024-08-01Z
E99999,2023,net_sales,45000000000,jp_gaap,1,S100ORIG   ← 当時の値。later_restated=1
# FY2023 net_sales as of 2025-01-01Z
E99999,2023,net_sales,44100000000,jp_gaap,0,S100AMND   ← 訂正後

# restatement events
  2024-11-05Z FY2023 net_sales:   45000000000 -> 44100000000 (-900000000 JPY)
  2024-11-05Z FY2023 total_assets: 80000000000 -> 79200000000 (-800000000 JPY)
```

同じクエリが時点によって違う値を返し、訂正差分が出る。
再提出されただけの `operating_income` はイベントを生まない。

UTF-16LEのCSVバイト列から取り込む**通しの経路**でも同じ結果になることを確認済み
（`test/ingest.test.mjs`）。

背景と競合分析は
[`docs/research/edinet-db-service-analysis.md`](../../docs/research/edinet-db-service-analysis.md)。
進捗と設計判断の記録は [`LEDGER.md`](./LEDGER.md)。

## 設計の核 — バイテンポラル

`facts` は値の「会計期間」とは別に **「いつ知り得たか」** を持つ。

| 列 | 意味 |
|---|---|
| `known_from` | この値が公表された時刻（書類の提出日時、JST→UTC変換済み） |
| `known_until` | 後続の訂正で置き換わった時刻。`NULL` なら現行値 |

- 訂正は**上書きせず追加**し、先行行の `known_until` を閉じる
- `as_of(T)` = `known_from <= T AND (known_until IS NULL OR known_until > T)`
- 同一 `(company, year, field)` に複数行が並ぶのが正常。それが訂正履歴そのもの

取り込みは**順序非依存かつ冪等**。各ファクトは `known_from` だけ付けて挿入し、
その後シリーズ全体を再封（reseal）する。reseal は「今ある行の純関数」なので、
バックフィルが提出順に来なくても同じタイムラインに収束する。

あわせて全ファクトが `source_doc_id` / `source_element_id` / `mapping_layer` を持つ。
どの書類のどの要素から来た値か、既知IDの解決か名前からの推測かを常に辿れる。

## 構成

```
schema.sql              バイテンポラルスキーマ
src/ingest.mjs          通しの取り込み（一覧→バイト列→パース→正規化→記録）
src/cli.mjs             backfill / report / demo
src/store/              node:sqlite ラッパ（再入可能トランザクション）、PITクエリ、gBizINFO側
src/normalize/          2層名寄せ、コンテキスト選別、単位・符号、会計基準判定
src/edinet/             API v2 クライアント、コードリスト、文書CSV(UTF-16LE)
src/gbiz/               gBizINFO v2（updateInfo差分方式）
src/query/              as_of 付き取得、訂正差分、デモ
src/mcp/                MCPサーバ（4ツール・バッチ型）
src/http/               EDINET/gBizINFO共通のペーシングとリトライ
fixtures/               合成データ
test/                   148件
```

## 実行

**Node 22以降が必要**（ストアが `node:sqlite` を使う）。
パッケージ本体は Node 18 以降を対象にしているため、`npm test` は
Node 22 未満ではプロトタイプのテストをスキップする。

```bash
# 仮説の実演（ネットワーク不要）
node prototype/edinet-pit/src/cli.mjs demo

# テスト（ブラウザ・ネットワーク不要）
node --test prototype/edinet-pit/test/*.test.mjs

# リポジトリ全体（プロトタイプのテストも含む）
npm test
```

### 実データを入れる

```bash
# まず1日だけで応答形状の想定を確認する
EDINET_API_KEY=xxxx node prototype/edinet-pit/src/cli.mjs \
    backfill --from=2024-06-20 --to=2024-06-20 --db=pit.db

# 取り込んだ企業を見る
node prototype/edinet-pit/src/cli.mjs report --db=pit.db --company=E02144 --field=net_sales
```

`backfill` は最後に**未マップ要素の頻出順**を出す。それが次にマッピングへ追加すべき要素。

### MCPで接続する

```json
{
  "mcpServers": {
    "edinet-pit": {
      "command": "node",
      "args": ["<repo>/prototype/edinet-pit/src/mcp/server.mjs"],
      "env": { "EDINET_PIT_DB": "<repo>/pit.db" }
    }
  }
}
```

`EDINET_PIT_DB` を省略するとフィクスチャからメモリ内に構築するので、そのまま試せる。
ツールは4本のみ（`list_fields` / `get_financials` / `get_restatements` / `get_fact_history`）で、
いずれも複数社・複数指標・複数期をまとめて受ける。

## 前提と制約

- **新規依存ゼロ。** ストアは Node 22 標準の `node:sqlite`、MCPサーバは
  リポジトリ既存の `@modelcontextprotocol/sdk` + `zod`、テストは `node:test`
- SQLは将来の Postgres 移行を見据えて書いている（`rowid` 等のSQLite固有要素を避ける）
- **実データでの検証は未実施。** 開発環境のegressポリシーが
  `disclosure2dl.edinet-fsa.go.jp` / `api.info.gbiz.go.jp` を拒否するため、
  検証はすべて合成フィクスチャに対して行っている。ロジックの正しさは担保しているが、
  **API応答の実形状・実カバレッジは未確認**。特に gBizINFO v2 の
  応答エンベロープのキー名は候補を複数受け付ける形にしてある
- 本リポジトリ（IEモード移行VRT）とは別プロダクト。`package.json` の `files` は
  許可リスト方式なのでnpmパッケージには同梱されない。将来は独立リポジトリへ抽出する前提
