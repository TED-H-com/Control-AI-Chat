> **Notice.** This index and the linked guides provide general information as of 2026-09-28, not legal advice. They do not create a lawyer-client relationship. Laws and official guidance change. Consult a qualified lawyer in each relevant jurisdiction.

# Compliance guides

These guides help an organization evaluate its own use of Control AI Chat. They do not state that the software, a feature, or a configuration makes an operator compliant. The operator remains responsible for its legal analysis, organizational measures, technical controls, provider arrangements, and actual practices.

Templates are starting points that must be adapted to the operator's facts and reviewed by counsel before use.

## Guides by jurisdiction

| Jurisdiction | Primary-language guide | Translations | Templates |
| --- | --- | --- | --- |
| Taiwan | [繁體中文（台灣）](tw/guide.zh-TW.md) | — | [templates](tw/templates/) |
| Japan | [日本語](jp/guide.ja.md) | — | [templates](jp/templates/) |
| United States | [English](us/guide.en.md) | — | [templates](us/templates/) |

The primary-language version of each jurisdiction's guide prevails if a translation differs.

## Choosing guides

Start with every country in which the organization is established, employs or monitors people, offers services, stores or accesses data, or sends data to a recipient. Also consider the locations of users, affected individuals, servers, administrators, group companies, AI providers, and other processors. More than one guide may apply to the same deployment, and these three guides may not cover every applicable law. Cross-border activity can also trigger sector-specific, employment, secrecy, records, consumer, procurement, export-control, or contractual requirements.

Map the facts before choosing controls. A qualified lawyer should resolve conflicts and determine which rules apply; do not assume that following the guide for the server's location is enough.

## Reporting errors

Report a documentation error through the issue tracker at <https://github.com/TED-H-com/Control-AI-Chat>. Identify the file, section, statement, as-of date, and primary official source supporting the correction. Do not put confidential information, personal data, or security vulnerabilities in a public issue. Report vulnerabilities under [`SECURITY.md`](../../SECURITY.md).

## Terminology glossary

Use these terms consistently in guides, templates, interface text, and translations. An action label describes software behavior, not a legal conclusion.

| Code | English | 繁體中文（台灣） | 日本語 |
| --- | --- | --- | --- |
| — | send-time check | 傳送時檢查 | 送信時チェック |
| — | detector | 偵測器 | 検出器 |
| — | action | 處置 | 処理 |
| `allow` | Allow | 允許 | 許可 |
| `flag` | Flag | 標記 | フラグ |
| `redact` | Redact | 遮蔽 | マスキング |
| `mask` | Substitute | 替換 | 置換 |
| `warn` | Warn | 警告 | 警告 |
| `block` | Block | 阻擋 | ブロック |
| `require_approval` | Require approval | 需經核准 | 承認が必要 |
| — | Protected terms | 受保護詞彙 | 保護対象語 |
| — | audit log | 稽核紀錄 | 監査ログ |
| — | hash chain | 雜湊鏈 | ハッシュチェーン |
| — | retention period | 保存期間 | 保存期間 |
| — | legal hold | 法律保存 | リーガルホールド |
| — | operator | 營運者 | 運用者 |
| — | AI provider | AI 供應商 | AI プロバイダー |
| — | self-hosted model | 自架模型 | セルフホスト型モデル |
| — | personal data | 個人資料（個資） | 個人データ |
| — | special categories | 特種個資 | 要配慮個人情報 |
| — | entrusted party | 受託者 | 委託先 |
| — | cross-border transfer | 國際傳輸 | 外国にある第三者への提供 |
| — | breach | 個資事故 | 漏えい等 |
