> **Notice.** This document provides general information as of 2026-09-28, not legal advice. It does not create a lawyer-client relationship. Export-control and sanctions rules change. Consult qualified counsel for the relevant jurisdictions, items, destinations, end users, and end uses.

# Export-control note

## What is published

The Control AI Chat source code is published and publicly available under the MIT License. In this release (v0.1.x), the application calls standard cryptographic functions supplied by Node.js, its dependencies, and the runtime's TLS/OpenSSL stack, including AES-256-GCM, SHA-256, bcrypt password hashing, and TLS. The review found calls to those standard primitives; it did not identify a proprietary or unpublished encryption algorithm.

That description is not an Export Control Classification Number (ECCN), commodity-jurisdiction decision, or determination that an item is or is not subject to a particular control regime.

## United States Export Administration Regulations

**Status as of 2026-09-28:** 15 C.F.R. parts 734 and 742 are in force. The eCFR pages consulted on 2026-09-28 displayed Title 15 as updated through 2026-09-24.

The Export Administration Regulations (EAR) exclude information and “software” that are published as described in [15 C.F.R. § 734.7](https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.7), subject to encryption-specific qualifications in [§ 734.3(b)(3)](https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.3). Section 734.7(a)(4) includes unrestricted public dissemination by posting on a publicly available internet site. Section 734.7(b), however, says that published 5D002 encryption software remains subject to the EAR unless the rule for publicly available encryption source code in § 742.15(b) is met.

Under [15 C.F.R. § 742.15(b)(1)](https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-742/section-742.15), publicly available encryption source code classified under ECCN 5D002 is not subject to the EAR, subject to paragraph (b)(2). Paragraph (b)(2) requires notice to BIS and the ENC Encryption Request Coordinator only when that source code provides or performs “non-standard cryptography.” BIS's official summary of its 2021 amendment confirms that the general notification requirement for publicly available encryption source code was removed, while notification remained for non-standard cryptography ([BIS, non-binding explanatory table](https://www.bis.gov/media/documents/table-changes-enc-wa2019-rule-final-version.pdf)).

Accordingly, § 742.15(b)(2) does not impose a general email notification merely because public source code uses standard cryptography. On the inspected facts—calls to the standard primitives listed above and no identified proprietary or unpublished algorithm—the project does not appear to trigger the paragraph (b)(2) notification condition. This is a limited reading of that notification provision, not a classification determination. A cryptographic change, an incomplete source release, or a different item could change the analysis.

Binaries, executable packages, and container images distributed separately must be evaluated as the items actually distributed. Section 734.7(b) addresses corresponding publicly available object code, but a binary or image may bundle additional components or differ from the published source. Public availability of one component does not decide the treatment of the whole item.

EAR treatment also does not displace U.S. economic sanctions. OFAC administers changing comprehensive and selective sanctions, including blocking and trade restrictions ([OFAC sanctions programs](https://ofac.treasury.gov/sanctions-programs-and-country-information); official information page, non-binding). Publishers, users, and redistributors must assess applicable destinations, persons, ownership, end users, end uses, and authorizations.

## Taiwan

**Status as of 2026-09-28:** Taiwan's [貿易法 (Foreign Trade Act)](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0090004) is in force. Article 13 provides that strategic high-tech commodities may not be exported without authorization and assigns the competent authority to announce the covered categories and controlled regions. The International Trade Administration explains that listed goods, software, or technology can be strategic high-tech commodities when the published specifications are met ([official SHTC FAQ](https://www.trade.gov.tw/FAQ/Detail.aspx?nodeid=5135); non-binding administrative guidance).

Taiwan's classification lists, end-use and end-user rules, destination controls, and permit requirements may therefore apply to particular source, binaries, images, users, or redistribution. Publication under an open-source license does not by itself resolve that analysis.

## Japan

**Status as of 2026-09-28:** Japan's 外国為替及び外国貿易法 (Foreign Exchange and Foreign Trade Act, FEFTA) and its implementing orders are in force. The Ministry of Economy, Trade and Industry states that Japan conducts security export control under FEFTA and that listed technology under the Foreign Exchange Order requires advance permission regardless of destination; FEFTA Article 25 addresses controlled technology transactions, and Article 48 addresses controlled goods exports ([METI overview](https://www.meti.go.jp/policy/anpo/gaiyou.html), [METI list-control page](https://www.meti.go.jp/policy/anpo/anpo02.html), both non-binding administrative guidance; [official statute](https://elaws.e-gov.go.jp/document?lawid=324AC0000000228)).

Source publication, downloads, binaries, container images, technical assistance, end users, end uses, and destinations may require separate analysis under those rules. An open-source license is not an export authorization.

## No classification on another person's behalf

The maintainers make no EAR, Taiwan, Japan, sanctions, customs, or other export-control classification or authorization determination for any user, operator, contributor, packager, mirror, or redistributor. Each person must assess the item and transaction they actually make available, export, reexport, transfer, import, download, or use, and obtain professional advice or government guidance where appropriate.
