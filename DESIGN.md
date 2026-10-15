# Design

This file describes how the web app looks and why. `README.md` and `CONTRIBUTING.md` say how to
build it; this says how it should look. When a case is not covered here, follow the principle nearest to
it rather than inventing a new style.

## 1. Visual theme: the checkpoint ledger

The app is a working surface for conversations that pass through a checkpoint. Each exchange is
written down like an entry in a register: numbered, timed, separated by hairline rules, and
stamped with what the checkpoint did before the message left the organization. The mood is quiet
paper and ink. Colour is scarce, so the places where it appears carry meaning: an indigo action
colour, status inks on the stamps, and one vermilion seal for the brand mark.

Recognisable details, in order of importance:
1. The **checkpoint stamp** on every checked message: a small double-ruled rectangle
   (`Cleared`, `Redacted 2`, `Blocked` …).
2. The **ledger thread**: no bubbles and no avatars; numbered entries in a monospace gutter.
3. The **declaration-style composer**: the routing fields sit above the text like the header of a
   form, and the send button is a labelled rectangle.
4. The **seal**: a vermilion square carrying a white double-ruled frame, the same double rule as
   the stamp. It is used once per screen.

The interface is dense and orderly and is designed for Traditional Chinese and Japanese first:
labels are short, line lengths are set in `em` for CJK text, and nothing depends on uppercase or
italics to carry meaning.

## 2. Colour

Tokens live in `web/src/styles/tokens.css` as custom properties on `:root`, switched by
`[data-mode='light'|'dark']`. Components use tokens only; no raw colour values outside that file.
All text pairs below meet WCAG AA (4.5:1) and are listed with their measured ratio.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--bg` | page canvas | `#F5F7F9` | `#0F1217` |
| `--panel` | header, register, composer, dialogs | `#FFFFFF` | `#161A20` |
| `--panel-2` | hover rows, table heads, receipts, code | `#EDF0F4` | `#1E2229` |
| `--line` | hairline rules and borders | `#DADEE3` | `#2F333B` |
| `--line-strong` | input borders, stamp-free outlines | `#B9BEC6` | `#484D57` |
| `--text` | primary text | `#191F2B` (15.4 on bg) | `#E5E8ED` (15.3) |
| `--text-2` | secondary text | `#424853` (8.6) | `#B9BEC6` (10.1) |
| `--muted` | meta, gutters, placeholders | `#5D646F` (5.6; 5.2 on panel-2) | `#999FA8` (7.0; 6.0 on panel-2) |
| `--primary` | the one action colour, links, focus | `#264A8E` (8.0) | `#7FA4EA` (7.5) |
| `--primary-hover` | pressed/hover action | `#17397B` | `#94B8F8` |
| `--on-primary` | text on primary | `#FFFFFF` (8.6) | `#0F1217` (7.5) |
| `--primary-soft` | selected row, active nav | `#E2ECFD` (primary on it 7.2) | `#1E293D` (5.8) |
| `--seal` | brand seal fill only | `#C73E1A` (white on it 5.1) | `#C73E1A` |
| `--on-seal` | glyph on the seal | `#FFFFFF` | `#FFFFFF` |
| `--amber` / `--amber-soft` | warned, held for approval | `#915C08` / `#FDF1D8` (5.0) | `#E6B55D` / `#36250D` (7.8) |
| `--crimson` / `--crimson-soft` | blocked, destructive, errors | `#B02A2D` / `#FFEDEB` (5.8) | `#F47B74` / `#3D1B18` (5.8) |
| `--green` / `--green-soft` | success confirmations only | `#2A7449` / `#E3F8E9` (5.1) | `#74C692` / `#152C1E` (7.3) |
| `--focus` | focus ring | `= --primary` | `= --primary` |
| `--scrim` | page veil behind drawers and dialogs | `rgb(15 18 23 / .32)` | `rgb(0 0 0 / .56)` |
| `--select-chevron` | theme-matched 14px stroked select chevron | `--text-2` stroke | `--text-2` stroke |

Code blocks use `--panel-2` with a `--line` border in both modes. Syntax colours: keyword
`--primary`, string `--green`, number `--amber`, comment `--muted`, function `--text-2` at weight 500.
No other hues.

Status inks (the stamp and receipt colour for each gate outcome) are fixed:

| Outcome | Ink | Why |
|---|---|---|
| cleared (`allow`, `flag`) | `--text-2` | nothing happened that needs attention |
| changed (`redact`, `mask`) | `--primary` | the message went out, altered on purpose |
| warned (`warn`) | `--amber` | the user was told and chose to continue |
| held (`require_approval`) | `--amber` | waiting on a person |
| blocked (`block`) | `--crimson` | nothing was sent |
| withheld (response check stopped the response) | `--crimson` | the response was not shown |
| checking (in progress) | `--muted`, dashed border | not decided yet |

Vermilion (`--seal`) is never a status colour and never a button colour.

## 3. Typography

Fonts are bundled, never fetched from a third party (the CSP is `font-src 'self'`). Latin text uses
IBM Plex Sans (variable) and IBM Plex Mono, shipped unmodified from IBM's release as the `split`
WOFF2 files with IBM's `unicode-range` declarations, so a page only downloads the subsets it uses.
Their SIL Open Font License travels with them in `web/public/fonts/LICENSE.txt`. CJK text uses the
reader's system fonts: bundling CJK faces would cost megabytes per weight.

Stacks (Latin first, so Latin letters and digits keep Plex and CJK falls through):

```css
--font-sans: 'IBM Plex Sans Var', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
:lang(zh-TW) { --font-sans: 'IBM Plex Sans Var', 'PingFang TC', 'Noto Sans TC', 'Noto Sans CJK TC',
  'Microsoft JhengHei UI', 'Microsoft JhengHei', sans-serif; }
:lang(ja) { --font-sans: 'IBM Plex Sans Var', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN',
  'Noto Sans JP', 'Noto Sans CJK JP', 'Yu Gothic UI', 'Meiryo', sans-serif; }
```

The mono stack appends the same CJK families after `monospace` fallbacks for each locale, so
Chinese or Japanese inside code does not fall back to a serif.

Scale (no other sizes):

| Token | Size / line height | Use |
|---|---|---|
| `--fs-meta` | 12px / 1.4 | gutters, timestamps, stamps, table captions, hints |
| `--fs-ui` | 13px / 1.45 | navigation, buttons, inputs, table cells, labels |
| `--fs-body` | 15px / 1.65 (Latin), 16px / 1.8 (`:lang(zh-TW)`, `:lang(ja)`) | message text, form help |
| `--fs-section` | 18px / 1.35 | section titles, dialog titles |
| `--fs-title` | 22px / 1.3 | page titles and the empty-conversation title; nothing larger |

Weights: 400 body, 500 labels and buttons, 600 titles and the active row. No 700+.
Numbers that line up (gutters, dates, counts, money, token totals) use
`font-variant-numeric: tabular-nums` and usually `--font-mono`.

CJK rules:
- `<html lang>` always matches the active locale (`en`, `zh-TW`, `ja`); styles key off `:lang()`.
- A name inserted into zh-TW or ja text sits in `「」` with no surrounding spaces; counts, dates,
  and amounts keep a space next to CJK text.
- All zh-TW and ja text uses `line-break: strict`; message text and long help also use
  `word-break: normal; overflow-wrap: anywhere;` (`anywhere` keeps long URLs and identifiers
  from overflowing). Running text uses `text-wrap: pretty`.
- `font-synthesis-style: none` under `:lang(zh-TW)` and `:lang(ja)`: CJK never gets faux italics.
  Emphasis (`em`) renders at weight 600 in those locales.
- No `text-transform: uppercase` and no letter-spacing on CJK text. The only uppercase in the app
  is the stamp label under `:lang(en)`.
- Reading measure: `max-width: 68ch` for English message text, `max-width: 38em` for
  `:lang(zh-TW)` and `:lang(ja)`.

## 4. Components

### Buttons
All buttons are rectangles with `--radius-2` (4px). Heights: 32px desktop, 40px below 768px; icon
buttons are 28px (row actions) or 32px (toolbars) square with a hit area extended to 44px on touch
(`@media (pointer: coarse)`), never by growing the visible box.

| Variant | Look | Use |
|---|---|---|
| primary | `--primary` fill, `--on-primary` text, 500 weight | one per view: Send, Save, Sign in |
| secondary | `--panel` fill, `--line-strong` border, `--text` | New conversation, Cancel, Export |
| ghost | transparent, `--text-2`, hover `--panel-2` | row actions, menus, toolbars |
| danger | `--crimson` text and border; filled only inside a confirm dialog | delete, revoke |

Buttons never stretch to the container width on desktop. Labels are sentence case. Loading keeps
the width and shows a 14px spinner in place of the icon.

### Inputs and selects
32px high (40px and 16px text below 768px), `--panel` fill, `--line-strong` border, `--radius-2`.
Focus: `outline: 2px solid var(--focus); outline-offset: 1px`. Invalid: `--crimson` border plus a
12px message below; never colour alone. Native `<select>` with `appearance: none` and one 14px
stroked chevron from `--select-chevron`. A form field stacks its 12px/600 `--text-2` label, control,
and optional 12px `--muted` hint with 4px internal gaps and 16px between fields; text controls fill
the form width, while a checkbox keeps its natural size beside its left-aligned label. Form actions
are right-aligned, secondary before the single primary, and drawer footers stick to the bottom.
Compact field selects in the composer are 28px high with a visible text label before them. A control
inside a table row has no visible label of its own. The column header labels it visually, and an
`aria-label` names the row.

### Checkpoint stamp (the signature element)
- Inline, `height: 22px`, `padding: 0 6px`, `border: 3px double currentColor`, `--radius-1` (2px),
  transparent background, `--font-mono` 12px weight 500, tabular numbers.
- `:lang(en)`: `text-transform: uppercase; letter-spacing: .06em`. CJK: neither.
- Colour from the status-ink table. The checking state uses a 1px dashed border instead.
- Labels (i18n keys under `chat.stamp.*`; `{count}` is the matched-item count):

| Outcome | en | zh-TW | ja |
|---|---|---|---|
| cleared | Cleared | 已通過 | 通過 |
| redact | Redacted {count} | 已遮蔽 {count} | マスキング {count} |
| mask | Substituted {count} | 已替換 {count} | 置換 {count} |
| warn | Warning noted | 已警示 | 警告あり |
| require_approval | Approval required | 需經核准 | 承認が必要 |
| block | Blocked | 已阻擋 | ブロック |
| withheld | Withheld | 未顯示 | 非表示 |
| checking | Checking… | 檢查中… | 確認中… |

- `{count}` is the number of items the gate replaced. When that count is unknown, the label has no
  number. On a response, `warn`, `require_approval` and `block` all show `withheld`.
- A user message with a gate summary always shows its stamp. A model response shows a stamp only
  when the response check changed something (`redact`, `mask`, `warn`, `require_approval`, `block`). No gate summary,
  no stamp.
- A stamp with something to explain is a `<button aria-expanded>` that toggles the receipt directly
  below the message header, above the message text. `Cleared` is plain text.
- When a stamp first appears after checking, it plays a 160ms press (scale .96→1, opacity .6→1).
  This is the one animated flourish in the app; it is removed under `prefers-reduced-motion`.

### Receipt
The explanation directly below a stamped message header: `--panel-2` fill, 1px `--line` border, `--radius-2`,
padding 12px 16px. Title 13px/600 in the status ink, body 13px `--text-2`. It reuses the existing
gate notice texts (`chat.gate.*`). Blocked and held entries show their receipt open by default and
it cannot be collapsed; redacted, substituted and warned receipts start collapsed.

### Ledger thread (conversation)
- Each entry is one exchange: the prompt, then the response, separated by a dotted `--line` rule;
  entries are separated by a solid `--line` rule.
- A 56px gutter on the left holds the entry number (`01`, `02`, … three digits past 99) and the
  send time in 24-hour `HH:MM` in every locale, `--font-mono` 12px `--muted`. The full
  locale-formatted date and time is in the entry's accessible name and the `<time>` title.
- The prompt row: author label (`You` / `你` / `あなた`, 13px/600) and the stamp on the same
  baseline, then the text. The response row: the model's display name (13px/600) and the provider
  name (12px `--muted`), then the text. No logos, avatars or sparkle glyphs.
- When the date changes between entries, a date rule appears: the locale-formatted date in 12px
  mono `--muted` followed by a hairline.
- Row actions (copy, edit, regenerate) are 28px ghost icon buttons with `aria-label` and a tooltip,
  shown on hover and `:focus-within` on desktop and always on touch.
- Token and cost details, when the user enables them, are one 12px mono line under the response.
- Attachments are listed as rows: file icon 16px, name, size in mono `--muted`.

### Register (conversation navigation)
280px column on `--panel` with a right hairline. Top: a secondary `New conversation` button
(32px, left-aligned) followed by rows for Search, Projects and Skills. Section headings 12px
`--muted`. Conversation rows are 32px: title 13px with ellipsis, date 12px mono `--muted`
right-aligned, a 28px kebab for actions. The active row uses `--primary-soft` and weight 600; no
side bars; the date keeps weight 400. Footer: Archived and Settings rows, then the workspace name
in 12px `--muted`.

### Seal
A `--seal` square (28px in the top bar, 40px on sign-in, `--radius-1` scaled to 3px) with a white
double-ruled frame drawn as two concentric square outlines (outer 16/24 of the size, inner 9/24,
stroke 1.6/24; the 16px favicon uses stroke 2.2/24 so it stays crisp). A workspace that uploads its
own icon shows that icon instead. Never add letters or other symbols inside the seal.

### Top bar
52px, `--panel`, bottom hairline, full width above the register and thread. Left: the seal
(28px) and the product or workspace brand name (13px/600); on desktop a vertical hairline and the
current conversation title (13px, ellipsis). Right: the language select (compact, native names:
English / 繁體中文 / 日本語) and, for administrators, the Admin console link (icon + label at
≥1280px, icon only below).

### Composer (declaration form)
A `--panel` block with a 1px `--line-strong` border, `--radius-3` (6px) and the popover shadow,
aligned to the thread column.
1. **Fields row** (28px selects, each preceded by a 12px `--muted` label): `To` (Auto, pinnable
   providers, multi-model, assistants), `Effort`, `Role`, `Tone`. Below 768px only `To` stays inline;
   `Effort`, `Role`, `Tone`, and the checkpoint hint move into an `Options` disclosure.
2. **Text area**: 15px (16px below 768px), grows from 2 lines to 40vh. Its placeholder is an
   invitation to write a message and never includes the product name.
3. **Footer**: attach (32px ghost icon), the hint `Checked before sending` / `送出前會先檢查` /
   `送信前に確認されます` (12px `--muted`, 14px shield icon; below 768px the hint moves into the
   `Options` disclosure, never an icon on its own), then on the right the primary
   `Send` / `送出` / `送信` button with a 16px arrow icon; while streaming it becomes a secondary
   `Stop` / `停止` / `停止` button.
Upload chips sit above the text area as rows, not pills.
The composer card carries the 2px `--focus` outline while its text area is focused.

### Empty conversation
Left-aligned in the thread column: title 22px (`New conversation` / `新對話` / `新しい会話`), one
13px `--muted` line (`Messages are checked against your organization's rules before they are
sent.` / `訊息送出前，會先依組織規則檢查。` / `メッセージは送信前に組織のルールで確認されます。`),
then suggested prompts as numbered ghost rows (`01`–`04` in the mono gutter), not cards.

### Menus, popovers, dialogs, toasts
Menus and popovers: `--panel`, 1px `--line`, `--radius-4` (8px), popover shadow, 32px items.
Dialogs: max-width 480px, title 18px, actions right-aligned (secondary, then primary), Escape
closes, focus is trapped and returned. Inline notices use the receipt style; toasts are not used.

### Admin console
- The admin console uses the same shared top bar as chat; a 232px navigation column has grouped
  sections (group label 12px `--muted`,
  items 32px, active item `--primary-soft`):
  Overview · Protection (Policies, Protected terms, Rule map, Detectors) · Review (Violations) ·
  Records (Audit log, Usage, Projects and skills) · Organization (Users, Groups, Roles) ·
  AI services (Models, Assistants, Providers, Budgets) · Settings (Retention, Workspace settings).
- Page head: title 22px, one 13px `--muted` description line, actions on the right.
- Tables: 13px cells, 36px rows (32px compact), 12px `--text-2` 600 header on `--panel-2`, hairline
  row separators, no zebra striping, sticky header, numbers right-aligned in tabular mono.
  Status cells use a small stamp-free text label with a 6px square in the status ink. Neutral
  outcomes (including allow, flag and cleared) use `--text-2`; redact, substitute and related
  in-progress states use `--primary`; warn, approval-required and pending states use `--amber`;
  block, rejected, suspended, expired, disabled and failed states use `--crimson`. Not covered uses
  `--muted` with a dashed square outline.
- Overview figures are a ledger row: label 12px `--muted` above, value 22px mono tabular, figures
  separated by vertical hairlines. No metric cards, no icons per figure.
- Detail drawers: 480px from the right on desktop, full screen below 768px.
- Detail drawers and the responsive navigation drawer sit above the shared `--scrim`.

### Sign-in
A single 400px column centred on `--bg`: the seal (40px) and product name (22px), a 13px `--muted`
line, then the form on a `--panel` block with a hairline border and 24px padding. The language
select sits at the top right of the page. No split hero, no illustration.

## 5. Layout

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 48 (`--space-1` … `--space-8`). Related items sit closer
  than unrelated ones; sibling gaps are equal.
- Radius: `--radius-1` 2px (stamps, chips), `--radius-2` 4px (buttons, inputs, receipts),
  `--radius-3` 6px (composer, panels), `--radius-4` 8px (menus, dialogs). Nothing rounder.
- Chat grid: top bar 52px; register 280px (248px at 1024–1279px); thread column = 56px gutter +
  text measure from section 3, centred in the remaining space with at least 24px side padding.
- Admin grid: 232px navigation + content up to 1200px wide; tables may use the full content width.
- Density preference (Settings → Appearance): `comfortable` (default) or `compact`, applied as
  `data-density` on the app root. Compact reduces entry padding from 20px to 12px, rows from 32px
  to 28px (36px to 32px in tables) and message text to 14px/1.55 (15px/1.7 CJK). Touch devices keep
  44px hit areas in both.

## 6. Depth

The app is flat; hairlines separate regions. Two shadows exist:
- `--shadow-pop`: `0 1px 2px rgb(15 18 23 / .06), 0 4px 16px rgb(15 18 23 / .08)` — composer,
  menus, popovers.
- `--shadow-dialog`: `0 16px 40px rgb(15 18 23 / .16)` — dialogs and drawers.
Dark mode uses the same geometry at higher opacity (.35 / .45 / .55).
Drawers, dialogs, and responsive navigation use `--scrim` to preserve page context behind them.

## 7. Do and don't

Do:
- Let hairlines, numbering and alignment create structure.
- Keep one primary button per view and one seal per screen.
- Reserve the double-ruled stamp for gate outcomes, so it keeps its meaning.
- Put every user-visible string in the three catalogues; check the longest (usually English) fits.

Don't:
- Chat bubbles, avatars, model or vendor logos, sparkle/gem glyphs for "AI".
- Gradients, glows, glass effects, emoji as icons, decorative illustrations.
- Rounded cards with a coloured left border, metric cards with icons, pill-shaped composers or
  buttons, full-width primary buttons on desktop.
- Inter, Roboto or any font fetched from a CDN; uppercase or italic CJK.
- New colours, sizes, radii or shadows outside the tokens above.

## 8. Responsive behaviour

| Width | Chat | Admin |
|---|---|---|
| ≥1280px | top bar, register 280px, thread | nav 232px, content |
| 1024–1279px | register 248px | same |
| 768–1023px | register becomes a drawer opened from the top bar | nav becomes a drawer |
| <768px | top bar 48px shows seal + conversation title; entry number and time move into a meta line above the author label; composer options collapse; row actions always visible; controls 40px, inputs 16px | tables scroll inside their container with the first column sticky; drawers are full screen |

Nothing may scroll the page horizontally at 390px. Test at 390×844, 768×1024 and 1440×900 in
all three locales, light and dark.

## 9. States and accessibility

- Every interactive element has hover, `:focus-visible`, active and disabled states; focus is
  always the 2px `--focus` outline.
- Status is never colour alone: stamps and status cells always carry a text label.
- Loading: skeleton rows in `--panel-2` for lists; a 14px spinner inside buttons. Empty states say
  what the list is for and offer the one relevant action. Errors say what failed and what to do.
- Drawers and dialogs trap focus, close on Escape and restore focus to their trigger.
- Motion: 120ms (hover, colour) and 180ms (drawers, disclosure) with
  `cubic-bezier(.2, 0, 0, 1)`; everything except content loading stops under
  `prefers-reduced-motion`.
- Print: register, top bar and composer are hidden; the thread prints in black on white with stamps
  kept.

## 10. Quick reference for contributors and agents

Tokens: `--bg --panel --panel-2 --line --line-strong --text --text-2 --muted --primary
--primary-hover --on-primary --primary-soft --seal --on-seal --amber(-soft) --crimson(-soft)
--green(-soft) --focus`; `--font-sans --font-mono`; `--fs-meta 12 --fs-ui 13 --fs-body 15/16
--fs-section 18 --fs-title 22`; `--space-1…8`; `--radius-1…4`; `--shadow-pop --shadow-dialog`.

### Gate action names

The UI and the documentation use exactly these words.

| Code | English action | 繁體中文 action | 日本語 action |
|---|---|---|---|
| `allow` | Allow | 允許 | 許可 |
| `flag` | Flag | 標記 | フラグ |
| `redact` | Redact | 遮蔽 | マスキング |
| `mask` | Substitute | 替換 | 置換 |
| `warn` | Warn | 警告 | 警告 |
| `block` | Block | 阻擋 | ブロック |
| `require_approval` | Require approval | 需經核准 | 承認が必要 |

| Code | English outcome | 繁體中文 outcome | 日本語 outcome |
|---|---|---|---|
| `allow` | Allowed | 已允許 | 許可済み |
| `flag` | Flagged | 已標記 | フラグ済み |
| `redact` | Redacted | 已遮蔽 | マスキング済み |
| `mask` | Substituted | 已替換 | 置換済み |
| `warn` | Warned | 已警告 | 警告済み |
| `block` | Blocked | 已阻擋 | ブロック済み |
| `require_approval` | Held for approval | 待核准 | 承認待ち |

Example requests:
- "Add a Revoke action to the sessions table": ghost 28px icon button in the row (danger colour on
  hover), confirm in a dialog with a filled danger button; no new colours.
- "Show that a file upload was redacted": a stamp on the upload row using the `redact` label and
  `--primary` ink; the explanation goes in a receipt, not a toast.
- "New admin page for X": page head (22px title, 13px description, actions right), a filter row of
  32px inputs, then a table per section 4; add the page to the right navigation group.
- "Make the composer show a quota warning": a receipt-style notice above the text area in
  `--amber`; do not change the Send button colour.
