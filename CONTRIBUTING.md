# Contributing to Control AI Chat

Thank you for helping improve Control AI Chat. You can contribute code, tests, documentation, translations, accessibility improvements, reproducible bug reports, and focused feature proposals. Ask usage and development questions in the discussion area at <https://github.com/TED-H-com/Control-AI-Chat>; use the issue tracker for confirmed bugs and scoped proposals.

Never report a security issue in a public issue, discussion, or pull request. Follow [`SECURITY.md`](SECURITY.md) instead.

By participating, you agree to follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Development

You need Node.js 24 and npm. The server (`server/`) and the web app (`web/`) are separate packages.

1. Install the dependencies:

   ```bash
   (cd server && npm ci)
   (cd web && npm ci)
   ```

2. Create `server/.env` with two development secrets. Git ignores this file.

   ```bash
   printf 'JWT_SECRET=%s\nAUDIT_KEY=%s\n' "$(openssl rand -hex 48)" "$(openssl rand -hex 32)" > server/.env
   ```

3. Create the database and the first workspace:

   ```bash
   cd server
   npm run migrate
   npm run build
   npm run bootstrap -- --workspace-name 'Development' --admin-email you@example.com
   ```

   The last command prints a generated password for that address. It is shown once.

4. Start the server on port 3010. Then, in a second terminal, start the web app on port 5173:

   ```bash
   (cd server && npm run dev)
   (cd web && npm run dev)
   ```

   Open http://localhost:5173 and sign in. The web app forwards `/api` to the server.

Before you open a pull request, run the checks:

```bash
(cd server && npm test)
(cd web && npm test && npm run build && npm run i18n:check)
```

If you change the interface, also run the visual audit. It serves the built web app, takes a
screenshot of every screen in all three languages at 390, 768 and 1440 pixels, and checks each one.
It mocks the API, so the server does not have to run. Set `CHROMIUM_PATH` to a Chromium or Chrome
executable; the audit stops without it. If you have none, run `npx playwright-core install chromium`
in `web/`; `npx playwright-core install --dry-run chromium` prints the folder it downloads to.

```bash
cd web
npm run build
npm run preview -- --port 4177 --strictPort &
CHROMIUM_PATH=/path/to/chrome npm run visual:audit
```

The screenshots go to `web/visual-audit-output/`.

Every new interface string needs all three languages: English, Traditional Chinese (Taiwan) and
Japanese. `npm run i18n:check` fails when one is missing.


## Developer Certificate of Origin

Every commit must include a `Signed-off-by:` line. Create it with:

```text
git commit -s
```

Signing off certifies the statements in the [Developer Certificate of Origin 1.1](DCO), including that you have the right to submit the contribution and that its public record may be maintained and redistributed. Do not sign off for someone else unless the DCO permits it.

The project follows “inbound = outbound”: unless a file clearly states otherwise, contributions are submitted under the same [MIT License](LICENSE) that covers the project.

## Provenance and independent development

Contribute only:

* your own original work; or
* material available under an MIT-compatible open-source license, where you have preserved all required copyright, attribution, license, and notice files.

Do not contribute code, text, user-interface designs, layouts, screenshots, prompts, data, or documentation copied from or derived from:

* a proprietary product;
* confidential information; or
* a service available to you only under terms that restrict copying, reverse engineering, benchmarking, or building other products.

This rule applies even if you legitimately access that material as a customer or employee. Do not describe or reference another vendor's product in an issue or pull request as a specification to replicate. Describe the user need and the independently developed behavior instead.

When provenance or license compatibility is uncertain, ask the maintainers before contributing. Maintainers may decline or remove a contribution whose provenance is unclear.

## AI-assisted contributions

AI assistance is allowed. You remain responsible for every line you submit. You must review and understand the contribution, verify that you have the right to submit it, and check it for correctness, security, license issues, personal data, and secrets. Disclose substantial AI assistance in the pull request description.

## Translations

Every user-facing string must exist in English, Traditional Chinese (Taiwan), and Japanese. Prefer review by a native speaker. Keep terminology consistent with the [compliance documentation glossary](docs/compliance/README.md#terminology-glossary).

## Legal and compliance documentation

Use primary official sources for legal statements. Give the instrument's status and an “as of” date. Do not state or imply that using or configuring Control AI Chat makes an operator compliant with any law, standard, or certification.

## Pull request checklist

Before opening or updating a pull request, confirm that:

- [ ] Relevant tests and the build pass.
- [ ] English, Traditional Chinese (Taiwan), and Japanese user-facing strings are complete.
- [ ] Every commit has the required `Signed-off-by:` line.
- [ ] The contribution contains no credentials, tokens, keys, or other secrets.
- [ ] Fixtures, logs, and screenshots contain no real personal data.
- [ ] Third-party material has a compatible license and all required notices are preserved.
- [ ] Substantial AI assistance is disclosed in the pull request description.
