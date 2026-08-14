# 進捗台帳

自動開発サイクル間で状態を引き継ぐための台帳。**このファイルが進捗の正。**
各サイクルは「実装 → `npm run check` → テスト緑 → commit → push → 次サイクル予約」で閉じる。

計画: `/root/.claude/plans/5-graceful-marshmallow.md`（承認済み）
ブランチ: `claude/edinet-db-service-analysis-41enkl` / PR #21

---

## マイルストーン

- [x] **M0** CI解放 + 足場
- [x] **M1** `schema.sql` + `store/db.mjs` + `store/facts.mjs` — バイテンポラルの核
- [x] **M2** 正規化2層（mapping / fallback / context / units）
- [x] **M3** `edinet/client.mjs`（transport注入）+ `edinet/codelist.mjs` + `edinet/csv.mjs`
- [x] **M4** `query/financials.mjs` — **仮説の証明 → 達成**
- [x] **M5** `mcp/server.mjs`
- [x] **M6** `gbiz/client.mjs` updateInfo差分 + 法人番号結合
- [x] **M7a** エンドツーエンド取り込み経路（追加）
- [x] **M7** 仕上げ・要約

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

### M2 — 正規化2層

- `normalize/mapping.json`: Layer1。15指標 × 3会計基準の既知要素ID。
  **リスト順が優先度**（`NetSales` > `OperatingRevenue1`）。
  `{ elementId, negate: true }` 形式で符号反転を表現（損失系要素は正で報告される）
- `normalize/fallback.mjs`: Layer2。要素IDのローカル名に対する**狭く固定した**正規表現。
  複数パターンが該当したら null を返す（恣意的に選ぶより欠損のほうが気づける）
- `normalize/context.mjs`: 当期/前期/前々期、連結/個別を判定。
  **Member軸を含むcontextID（セグメント）と Forecast は拒否**。
  未知のラベルは「当期と仮定」せず拒否する
- `normalize/units.mjs`: 円/千円/百万円/十億円 → **すべて円に正規化**（精度を落とさない）。
  株/人/％/件は素通し。未知の単位は例外を投げる
- `normalize/index.mjs`: 2層を統合。`normalizeFiling()` は facts と **skipped レポート**を返す
- `test/normalize.test.mjs` を追加し、合計41件緑

**設計の要点**

- **Layer1 は常に Layer2 に勝つ。** 正規表現が本物の要素IDを上書きしたら、
  正しいデータと見分けがつかなくなる
- **`mapping_layer` を facts テーブルに追加。** 既知IDによる解決（layer1）か
  名前形状からの推測（layer2）かを区別できないと、値をどれだけ信用してよいか
  判断できず、カバレッジ指標も意味を失う
- **未知の単位・未知の期間ラベルは推測せず拒否する。** 静かに桁を間違えた数値は、
  欠損よりはるかに悪い
- `skipped` レポート（context / unmapped / unit）は装飾ではない。
  タクソノミ年次改訂は「skipped の急増」として現れる。これが無いと毎年静かに
  取得量が減っていくだけになる
- **欠損と0を絶対に混同しない。** 空欄・`-`・`－` は null

### M4 — 仮説の証明（達成）★

**M3より先に実施した。** M4はM1+M2だけで組めてM3に依存せず、
核心の結果を早く確保するほうが安全と判断した。

- `query/financials.mjs`: `getFinancials()` / `getRestatements()` / `toDelimited()`
- `query/demo.mjs`: フィクスチャを読み込んで仮説を実演するCLI
- `fixtures/edinet/filings.json`: 原本(2024-06-20) → 訂正(2024-11-05) → 翌期(2025-06-24)
- `test/financials.test.mjs` を追加し、合計57件緑

**実行結果（`node prototype/edinet-pit/src/query/demo.mjs`）**

```
# FY2023 net_sales as of 2024-08-01Z
E99999,2023,net_sales,45000000000,jp_gaap,1,S100ORIG   ← 当時知り得た値。later_restated=1
# FY2023 net_sales as of 2025-01-01Z
E99999,2023,net_sales,44100000000,jp_gaap,0,S100AMND   ← 訂正後

# restatement events
  2024-11-05Z FY2023 net_sales:   45000000000 -> 44100000000 (-900000000 JPY) S100ORIG -> S100AMND
  2024-11-05Z FY2023 total_assets: 80000000000 -> 79200000000 (-800000000 JPY) S100ORIG -> S100AMND
```

同じクエリが時点によって違う値を返し、訂正差分が出る。**目的達成。**
再提出されただけの `operating_income` はイベントを生まない。
翌期の比較年度（訂正後と同値）も追加イベントにならない。

**`later_restated` フラグ**: 過去時点の値を返すとき「これは後に訂正された」を
明示する。バックテストで無効化された数値を黙って渡さないため。
PITストアの存在理由そのものなので、値と同格の一級情報として返す。

**デモ実行で見つかった実バグ（重要）**

`S100ORIG` が5行中3ファクトしか生成せず、**個別（単体）の行が全て落ちていた**。
実データのEDINET CSVは個別値のcontextIDに `NonConsolidatedMember` を含むが、
Member軸判定がこれをセグメントとして捨てていた。M2のテストは
プレーンなcontextIDで書いていたため検出できなかった。
→ 連結軸のMember（`NonConsolidatedMember` / `ConsolidatedMember`）を除去した後に
残るMemberだけをセグメントと判定するよう修正。回帰テスト2件追加。
`NonConsolidatedMember_AutoMember` のような重ね合わせは引き続き拒否する。

**教訓**: 合成フィクスチャでも「実データの形」に寄せないと、
テストが通っているのに実データで壊れる。M3のフィクスチャは実CSV形式で作る。

### M3 — EDINETクライアントとパーサ

- `edinet/client.mjs`: API v2 クライアント。**transport注入**でネットワーク無しに検証可能。
  日付走査は generator（10年分は数十万書類。全部メモリに載せない・途中で止められる）
- `edinet/codelist.mjs`: コードリストのパース、検査用数字、充足率集計。
  **node:sqlite に依存しない**ので任意のNodeバージョンで動く
- `edinet/csv.mjs`: type=5 文書CSV（UTF-16LE・タブ区切り）の読み取り
- `docs/research/scripts/edinet-corporate-number-coverage.mjs` を
  `codelist.mjs` を使う形にリファクタ。**重複実装を削除**。
  既存フィクスチャで出力が完全一致することを確認済み
- `test/edinet-client.test.mjs` + `test/edinet-parsers.test.mjs`、合計98件緑

**設計の要点**

- **4xxはリトライしない。** サーバが「リクエストが不正」と判断したものを繰り返しても
  同じ結果で、公的インフラに無駄な負荷をかけるだけ。429と5xxと通信エラーのみ再試行
- **リクエスト間隔とバックオフを注入可能に。** テストが実際に待たないので高速に検証できる
- **会計年度は期末から逆算**。1〜3月期末は前年度（日本の会計年度は開始年で呼ぶ）。
  ここを1年ずらすと3月決算企業＝市場の大半が全部ずれる
- **提出時刻はJST→UTC変換**。`known_from` の元になるため、ずれると訂正の
  タイムライン順序が壊れる。夕方のJST提出がUTCで前日になるケースをテストで固定

**M3で見つかった実バグ**

BOMなしUTF-16LEの判定を「2バイト目がNUL」で書いていたが、
**実データの見出しは `要素ID` = 非ASCIIで始まる**ため成立しない（`要` は 0x81 0x89）。
つまりUTF-16が必要なファイルに限ってUTF-8と誤判定する。
→ 必要な見出し文字列が実際に現れるデコードを選ぶ方式に変更。
どちらでも現れなければUTF-8を返し、パーサ側が明確なエラーを出す。

**教訓（M4と同じ）**: 実データの形に寄せたテストでないと、通っているのに壊れる。

### M5 — MCPサーバ

- `mcp/server.mjs`: 既存 `src/lib/server.js` と同じ `McpServer` + `registerTool` + Zod。
  **新規依存ゼロ**（MCP SDK と zod はリポジトリの既存依存）
- ツールは**4本だけ**: `list_fields` / `get_financials` / `get_restatements` / `get_fact_history`
- `test/mcp.test.mjs` 17件。合計115件緑
- DB選択: `EDINET_PIT_DB` があればそれ、無ければフィクスチャからメモリ内に構築

**設計の要点**

- **少数・バッチ型。** 10社×5指標×5期を1コールで返す。ツール定義はクライアント側の
  コンテキストを消費し、コールはレート制限を消費する。単値ゲッターを大量に並べる形は
  その両方で高くつく
- **単位・連結区分・会計基準・as_of をレスポンスに明示。** LLMが裸の数値を読むと
  異なる単位を比較したり連結と単体を混ぜたりして、自信満々に無意味な比率を出す。
  それを防ぐのはサーバ側の責務
- **`as_of` に日付だけを渡したら「その日の0時」**として扱う。当日の遅い時刻の提出が
  それより前の as_of に漏れないようにするため
- 既存 `test/mcp-client.mjs` に `serverPath` 引数（既定値付き）を1つ足して再利用。
  190行のクライアントを複製しない。既定構築の後方互換を確認済み

**M5で踏んだ罠**

テストが `client.close()` を呼んでいたが、実際のメソッド名は **`stop()`**。
存在しないメソッド呼び出しでサーバプロセスが殺されず、テストランナーが終了せずハングした。
`listTools()` は配列を直接返す（`{result:{tools}}` ではない）、
`callTool()` は result オブジェクトを直接返す、という戻り値形状も取り違えていた。
→ 既存のテストユーティリティを使うときは、型注釈が無い以上まず実装を読むべきだった。

### M6 — gBizINFO 差分取り込みと法人番号結合

- `http/paced-requester.mjs`: EDINET と gBizINFO で**共通化**したペーシング/リトライ。
  ほぼ同一のリトライループを2つ持たない。既存20件のテストが移行の正しさを検証
- `gbiz/client.mjs`: v2クライアント。`updateInfo` 差分方式の `syncCategory()`
- `store/gbiz.mjs`: `company_group`（期間付き）、`gbiz_facts`、
  グループ横断集計、官需エクスポージャー推定
- `test/gbiz.test.mjs` 22件。合計137件緑

**設計の要点**

- **差分方式が桁を変える。** 全対象法人×9カテゴリのポーリングは3万社×9で日次27万回。
  updateInfo で変更法人番号を取り→自社の対象集合と交差→交差分のみ詳細取得なら
  **9回＋変更分**。テストで「対象外の変更は取りに行かない」「同一法人番号が
  フィードに2回出ても1回だけ取る」を固定
- **`getGroupCorporateNumbers` は必ず重複排除。** 同じ法人番号が複数のrelationで、
  あるいは親としても子としても到達しうる。下流は全てこの一覧を合計するので、
  重複は**本物の数値に見える二重計上**になる
- **`fetched_at` は必須。** 行政データはバージョンを持たずその場で改訂されるため、
  取得時刻が無いと時間的な出所が一切なくなる
- **`asOf` はイベント日で絞る。** 読者が知り得なかった採択を合計に含めるのは
  財務側と同じ look-ahead リーク
- **応答エンベロープが未知の形なら例外。** 空配列を返すと
  「補助金ゼロの企業」と見分けがつかない
- Swagger掲載の動作確認用トークンはコード・テストに一切入れていない

**未検証（要一次確認）**: v2の応答エンベロープのキー名（v1は `hojin-infos`）と
各カテゴリの実フィールド名。`extractRecords` は候補を複数受け付ける形にしてある。

### M7a — エンドツーエンド取り込み経路（計画外の追加）

デモは事前パース済みJSONを使っており、**CSVバイト列から取り込む経路が繋がっていなかった**。
実データが最初に壊れるのは各段の継ぎ目なので、通しで動かす層を追加した。

- `normalize/index.mjs` に `detectAccountingBasis()`: 要素IDの名前空間の**多数決**で判定。
  会計基準はどこにも読める形で書かれていないが、使ったタクソノミが物語る。
  IFRS企業も一部 `jppfs_cor` を含むため先着一致では誤判定する
- `src/ingest.mjs`: 一覧 → バイト列 → デコード → パース → 基準判定 → 正規化 → 記録。
  `ingestRange()` は generator で、1書類の失敗が1日分を捨てないよう書類単位で報告して継続
- `summarizeIngest()`: 未マップ要素の頻出順を出す。**それが次にマッピングへ追加すべき要素**
- `test/ingest.test.mjs` 11件。合計148件緑

**M7aで見つかった実バグ（設計上の欠陥）**

`ingestDocument` が `recordDocument` + `recordFacts` をトランザクションで包んだところ、
**`recordFacts` 自身もトランザクションを開いていて入れ子になり失敗**した
（`cannot start a transaction within a transaction`）。
`recordFacts` が自前でトランザクションを持つ設計は合成できない。
→ `db.transaction()` を**再入可能**にした（深さを数え、最外周のみ BEGIN/COMMIT）。
原子性が必要な単位は本質的に入れ子になる（書類のファクト群 ⊂ 書類全体）ので、
呼び出し側に「今トランザクション中か」を意識させないのが正しい。

**通し確認できたこと**: UTF-16LEのCSVバイト列から取り込んで、
`as_of` 2024-08-01 と 2025-01-01 で異なる値が返り、訂正イベントが
`2024-11-05T01:00:00Z`（JST 10:00 → UTC）で出る。再取り込みで結果が変わらない。

### M7 — 仕上げ

- `src/cli.mjs`: `backfill` / `report` / `demo`。起床後に実データを入れる入口。
  `backfill` は最後に**未マップ要素の頻出順**を出す（＝次にマッピングへ追加すべき要素）
- README を現状に更新（実行方法、MCP接続設定、未検証事項）
- 3サブコマンドの動作を確認（ディスク上のSQLiteでの `report` を含む）

**最終状態**: テスト148件緑、`npm run check` / `audit` / `pack:dry-run` 通過。
M0〜M7 完了 + 計画外の M7a（通しの取り込み経路）。

### 増分1 — 中核2ファイルをレビュー可能にした

`facts.mjs` と `normalize/index.mjs` が**git にバイナリ扱いされ、PRで
`Binary files differ` としか表示されていなかった**。原因は破損ではなく、
複合マップキーの区切りにNULを使い、それを**エスケープではなく生バイトで書いていた**こと。

- 4箇所（`facts.mjs` の `seriesId`、`index.mjs` の索引キー2箇所と `best` マップキー）を
  `KEY_SEPARATOR = '\u0000'` に置換。**実行時の値は不変**なので挙動は完全に同一
- 区切りをNULにする理由（EDINETコード・項目名・年度に絶対現れないので衝突しない）を
  コメントで明記。空白に戻して壊されるのを防ぐ
- `test/source-hygiene.test.mjs` を追加。制御バイトの走査と、区切りがエスケープの
  ままであることを検査

**効果（実測）**: `git diff main...HEAD --numstat` が `- -` から
`194行 / 260行` に変わり、PRで差分が読める状態になった。

**この欠陥の質**: 構文エラーにならず、lintも通り、grepにも出ない。
「テストが全部緑なのにレビュー不能」という状態が成立してしまう。
コミットメッセージに同じNULを書いてツールに拒否されたのが発見の決め手だった。

### 増分2 — 生データレイク

設計文書が「非交渉」としながら実装に無かった要件。正規化ルールは必ず何度も変わり、
その度に公的APIから10年分を取り直すのは非現実的かつ不作法。

- `store/raw.mjs`: SHA-256のコンテンツアドレスで保存（`node:crypto` + `node:fs` のみ）。
  同一内容は同一キーなので**再取得してもレイクは太らない**。
  `verify()` で自己検証可能（唯一の原本なので腐敗検知が必要）
- `ingest.mjs`: **パース前に生バイトを保存**し `documents.raw_object_key` に記録。
  正規化が例外を投げても書類は残る
- `renormalize(db, rawStore, ...)`: **client を受け取らない設計**。
  意図的にネットワークへ到達できない
- `applyDocument()` を切り出し、取り込みと再正規化が書類解釈で乖離しないようにした
- `rawStore` は任意。渡さなければ従来どおり動く
- CLI に `renormalize` サブコマンド
- `test/raw-store.test.mjs` 14件。**再正規化中の transport 呼び出し回数が0**であることを
  assert（これがレイクを持つ理由そのもの）。合計164件緑

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

- **`capital_expenditure` の符号**: キャッシュフロー計算書の
  `PurchaseOfPropertyPlantAndEquipment` は支出なので負で報告される。これを
  `negate: true` で正に反転して「設備投資額」としている。
  「CF項目は報告どおりの符号を保つ」という方針もありうる。要判断
- **`PERCENT` を比率に変換していない**（8.5% は 8.5 のまま）。
  変換したほうが計算は安全だが、見えない変換を増やしたくなかったため素通しにした
- **層2の畳み込み**: 現在は同一 field に複数の layer2 候補があると
  priority が同じ（MAX_SAFE_INTEGER）ため先着が残る。実データで衝突頻度を見て
  決めるべき。層1が存在する限り実害は小さい

---

## 実データ未検証の項目

開発環境のegressポリシーにより以下は**未実行**。ネットワークのある環境で確認が必要。

- `EdinetcodeDlInfo.csv` の法人番号充足率（`docs/research/scripts/edinet-corporate-number-coverage.mjs --fetch`）
- EDINET API v2 の実応答形状（フィクスチャは仕様書ベースの合成データ）
- gBizINFO v2 の実応答形状・リクエスト上限
