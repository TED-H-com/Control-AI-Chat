# Sources

Accessed 2026-09-28 unless stated otherwise. Legal status descriptions are as of 2026-09-28. Official statutes, regulators, and project publishers are used as primary sources.

## MIT License

* https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt — SPDX's MIT license text copied into `LICENSE`, with only the requested copyright line substituted.

## Developer Certificate of Origin 1.1

* https://developercertificate.org/ — official DCO 1.1 text, including its copyright and verbatim-copy permission lines, copied into `DCO`.

## Contributor Covenant 2.1

* https://www.contributor-covenant.org/version/2/1/code_of_conduct.html — official English version 2.1 and the version named in the attribution section.
* https://raw.githubusercontent.com/ContributorCovenant/contributor_covenant/release/content/version/2/1/code_of_conduct.md — official Markdown source used for `CODE_OF_CONDUCT.md`.
* https://raw.githubusercontent.com/ContributorCovenant/contributor_covenant/release/content/version/2/1/code_of_conduct.ja.md — official Japanese 2.1 Markdown source used for `CODE_OF_CONDUCT.ja.md`.
* https://raw.githubusercontent.com/ContributorCovenant/contributor_covenant/release/content/version/2/1/code-of-conduct.zh-tw.md — official Traditional Chinese 2.1 Markdown source used verbatim for `CODE_OF_CONDUCT.zh-TW.md`, except for the required contact placeholder.
* https://www.contributor-covenant.org/translations — official translation catalog.
* https://www.contributor-covenant.org — homepage retained by the official attribution section.
* https://www.contributor-covenant.org/faq — FAQ retained by the official attribution section.
* https://github.com/mozilla/diversity — source linked by the official attribution section for the enforcement ladder inspiration.

## Source-hosting platform privacy

* https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement — platform privacy statement linked from the English project privacy notice.
* https://docs.github.com/zh-tw/site-policy/privacy-policies/github-general-privacy-statement — localized platform privacy statement linked from the Taiwan Traditional Chinese notice.
* https://docs.github.com/ja/site-policy/privacy-policies/github-general-privacy-statement — localized platform privacy statement linked from the Japanese notice.

## United States Export Administration Regulations

**Status:** 15 C.F.R. parts 734 and 742 were in force. On access, the eCFR displayed Title 15 as updated through 2026-09-24.

* https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.3 — § 734.3(b)(3), the published-information exclusion, and the encryption-source/object-code note.
* https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.7 — § 734.7(a)'s publication rule and § 734.7(b)'s special rule for 5D002 encryption software.
* https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-742/section-742.15 — § 742.15(b)(1) and (2), including the notification condition for non-standard cryptography.
* https://www.bis.gov/regulations/ear/734 — current BIS reproduction of EAR part 734; corroborates the operative § 734.7 text.
* https://www.bis.gov/regulations/ear/742 — current BIS reproduction of EAR part 742; corroborates the operative § 742.15 text.
* https://www.bis.gov/media/documents/table-changes-enc-wa2019-rule-final-version.pdf — BIS's non-binding explanatory table for the 2021 final rule; confirms removal of the general email-notification requirement except for non-standard cryptography.

## United States sanctions

**Status:** OFAC sanctions programs and their underlying authorities were in force; program scope changes over time. The linked index is a non-binding official information page.

* https://ofac.treasury.gov/sanctions-programs-and-country-information — official OFAC program index; supports the statement that sanctions may be comprehensive or selective and use blocking and trade restrictions.

## Taiwan export controls

**Status:** The 貿易法 was in force; the official database showed a last amendment date of 2019-12-25. Current control lists and administrative materials remain separately changeable. The regulator's explanatory and FAQ pages are non-binding administrative guidance.

* https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0090004 — official current Chinese text of 貿易法, especially Articles 2 and 13.
* https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0090004 — official English translation of the Foreign Trade Act used as a cross-check; the Chinese text controls.
* https://www.trade.gov.tw/Pages/detail.aspx?did=59006&nodeid=4433&pid=725764 — International Trade Administration's official SHTC explanation and description of current list categories, including software and technology.
* https://www.trade.gov.tw/FAQ/Detail.aspx?nodeid=5135 — official SHTC FAQ; expressly describes listed goods, software, or technology as SHTC when specifications are met.
* https://www.trade.gov.tw/English/Pages/detail.aspx?did=126203&nodeID=298&pid=687872 — official current export-control-list page.

## Japan export controls

**Status:** 外国為替及び外国貿易法 and its implementing orders were in force. The METI overview, list-control, and compliance-program pages are non-binding administrative guidance.

* https://elaws.e-gov.go.jp/document?lawid=324AC0000000228 — official current statute text for 外国為替及び外国貿易法.
* https://www.meti.go.jp/policy/anpo/gaiyou.html — METI's official security-export-control overview, updated 2026-05-20; supports FEFTA's role and current administration.
* https://www.meti.go.jp/policy/anpo/anpo02.html — METI's official list-control page; supports advance-permission statements for listed goods and technology.
* https://www.meti.go.jp/policy/anpo/compliance_programs.html — METI's official compliance-program page; identifies FEFTA Articles 25 and 48 as permission provisions.

## Product source verification

The guides' statements about the software were checked against these source files for this release (v0.1.x):

* [`server/src/lib/net/safe-fetch.ts`](../../server/src/lib/net/safe-fetch.ts) — configured model endpoints and guarded administrator-requested URL fetching.
* [`server/src/app/admin/index.ts`](../../server/src/app/admin/index.ts) — configured SMTP mail send for an administrator-issued credential link.
* [`server/src/lib/email/credential-mail.ts`](../../server/src/lib/email/credential-mail.ts) — workspace name, one-time link and localized expiry fields in credential mail.
* [`server/src/shared/permissions.ts`](../../server/src/shared/permissions.ts) — seeded permissions and roles.
* [`server/src/lib/gate/default-policy.ts`](../../server/src/lib/gate/default-policy.ts) — new-organization default policy.
* [`server/src/lib/gate/vault.ts`](../../server/src/lib/gate/vault.ts) — stateless redaction that retains no original or per-token state.
* [`server/src/scripts/bootstrap-core.ts`](../../server/src/scripts/bootstrap-core.ts) — first-owner bootstrap.
