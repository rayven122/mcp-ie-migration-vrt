# EDINET PIT プロトタイプ

有価証券報告書の財務データを **ポイントインタイム（PIT）** で返せるかを検証するプロトタイプ。

## 何を証明しようとしているか

既存のEDINETデータサービスは「現在の最新値」を返す。しかし訂正報告書で数値は後から変わる。
過去のある時点を分析するとき、**その時点では知り得なかった訂正後の数値**を使うと、
未来情報の混入（look-ahead bias）になる。クオンツのバックテストや学術研究では、
これがあるとデータそのものが使えない。

証明したい挙動は一点。

```
as_of('2024-06-01') → FY2023の売上高 = 訂正前の値（当時知り得た値）
as_of('2025-01-01') → FY2023の売上高 = 訂正後の値
                    + いつ・どの指標が・いくらから いくらへ訂正されたかの差分
```

背景と競合分析は [`docs/research/edinet-db-service-analysis.md`](../../docs/research/edinet-db-service-analysis.md) を参照。

## 設計の核 — バイテンポラル

`facts` テーブルは値の「会計期間」とは別に **「いつ知り得たか」** を持つ。

| 列 | 意味 |
|---|---|
| `known_from` | この値が公表された時刻（書類の提出日時） |
| `known_until` | 後続の訂正で置き換わった時刻。`NULL` なら現行値 |

- 訂正は**上書きせず追加**し、先行行の `known_until` を閉じる
- `as_of(T)` = `known_from <= T AND (known_until IS NULL OR known_until > T)`
- 同一 `(company, year, field)` に複数行が並ぶのが正常。それが訂正履歴そのもの

あわせて全ファクトが `source_doc_id` と `source_element_id` を持つ。
どの書類のどの要素から来た値かを常に辿れる状態を、最初から不変条件にしている。

## 現状

進捗と設計上の決定は [`LEDGER.md`](./LEDGER.md) が正。

## 前提と制約

- **新規依存ゼロ。** ストアは Node 22 標準の `node:sqlite`、MCPサーバは
  リポジトリ既存の `@modelcontextprotocol/sdk` + `zod`、テストは `node:test`
- SQLは将来の Postgres 移行を見据えて書く（SQLite固有構文を避ける）
- **実データでの検証は未実施。** 開発環境のegressポリシーが
  `disclosure2dl.edinet-fsa.go.jp` / `api.info.gbiz.go.jp` を拒否するため、
  検証はすべて `fixtures/` の合成データに対して行っている。
  ロジックの正しさは担保しているが、実データでの動作確認は別途必要

## 実行

**Node 22以降が必要**（ストアが `node:sqlite` を使う）。
パッケージ本体は Node 18 以降を対象にしているため、`npm test` は
Node 22 未満ではプロトタイプのテストをスキップする。

```bash
# テスト（ブラウザ・ネットワーク不要）
node --test prototype/edinet-pit/test/*.test.mjs

# リポジトリ全体（プロトタイプのテストも含む）
npm test
```

## 構成

```
schema.sql              バイテンポラルスキーマ
src/store/              node:sqlite ラッパとPITクエリ
src/normalize/          XBRL要素IDの2層名寄せ、コンテキスト選別、単位・符号正規化
src/edinet/             EDINET API v2 クライアント、EDINETコード一覧パーサ
src/gbiz/               gBizINFO v2 クライアント（updateInfo差分方式）
src/query/              as_of 付き取得と訂正差分
src/mcp/                MCPサーバ（バッチ型・少数ツール）
fixtures/               合成データ（原本・訂正・翌期、3会計基準、企業独自拡張ID）
test/                   node:test
```
