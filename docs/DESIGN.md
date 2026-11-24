# Design: the iPhone standard

The owner, 24 November 2026: "The minimum standard for UX/UI is an Apple iPhone interface. Review every
screen, every feature, every button, and make sure it is as visually peaceful and as intuitive to use as
the iPhone's UI and UX." The trigger was the match page: busy, and "'I've booked it' looks like it has no
design thought at all".

So the reference for every screen is the iPhone's own apps (Settings, Calendar, Wallet) and Apple's Human
Interface Guidelines. A design question that this file does not answer is answered by "what would
Settings or Calendar do here".

This file sets how a screen looks. `docs/DECIDING.md` says what a screen does: one job per screen, and one
primary action (rule 1). `AGENTS.md` rule 3 is the same rule for code review.

## The test for each screen

Before a screen ships, open it on a phone at 390 px. Then check these five things:

1. **In one second you know what the screen is for, and the one thing to do.** If the eye has two places to
   start, one of them goes or gets quieter.
2. **One lime button at most.** Lime is the action of the screen. Every other action is grey or plain.
3. **No box inside a box.** A card is a group. Inside it, parts are separated by a hairline, never by a
   second border, a tinted panel or a shadow.
4. **Nothing shouts.** No capitals for emphasis, no extra-bold text, no row of emoji, no third colour.
5. **Every control looks like what it does.** A button looks like a button, a row that opens something has
   a chevron, and a link looks like a link. Each tap target is 44 px high or more.

## Colour

The tokens are in `src/app/globals.css`. `tests/contrast.test.ts` holds every text colour at 4.5:1 or
better on the page and on a card, in both themes.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#f2f2f7` | `#000000` | The page: the iPhone's grouped background |
| `card` | `#ffffff` | `#1c1c1e` | A group of related rows |
| `fill` | `#e8e8ed` | `#2c2c2e` | A grey button, a text field, a segmented control |
| `line` | `#e5e5ea` | `#38383a` | A hairline between two rows of a card |
| `ink` | `#1c1c1e` | `#f5f5f7` | Text |
| `muted` | `#5c5c62` | `#aeaeb2` | Secondary text: a subtitle, a value on the right |
| `faint` | `#6c6c71` | `#98989e` | A footnote under a group |
| `court` | `#1b4fd8` | `#8db0ff` | The tint: links and plain buttons |
| `accent` | `#c8f135` | same | The one prominent button, and the brand |
| `ok`, `warn`, `danger` | green, amber, red | lighter | State only: booked, full, cancelled |

Colour means a state or an action, never decoration. A tinted panel (`bg-ok-soft`, `bg-warn-soft`,
`bg-court-soft`) is for one thing a person must not miss, and one on a screen at most.

## Type

The iPhone's scale, in rem so that "Bigger text" grows all of it.

| Role | Size | Weight | Class |
|---|---|---|---|
| Large title (the time of a match) | 48 px | bold | `text-5xl font-extrabold` |
| Title (the page's `h1`) | 28 px | bold | `text-[1.75rem] font-extrabold` |
| Headline (a card's title) | 17 to 20 px | semibold | `text-lg font-bold` |
| Body, button | 17 px | regular, semibold | `text-[1.0625rem]` |
| Subheadline (a row's second line) | 15 px | regular | `text-[0.9375rem] text-muted` |
| Footnote (under a group) | 13 px | regular | `text-xs text-faint` |

The weights are one step lighter than their names (`globals.css`, `@theme`): `font-extrabold` is 700,
`font-bold` is 600 and `font-semibold` is 500. The app's classes were a step heavier everywhere, and this
moved every screen at once. Write new code with the weight you want to see:
`font-extrabold` for a title, `font-bold` for a headline or a button, and `font-semibold` for a label.

The font is the phone's own (`-apple-system`, which is SF on an iPhone). Text is in sentence case: "Open",
never "OPEN".

## Surfaces

- **A card** (`.card`) is white on the grey page, with corners of 20 px, no border and no shadow.
- **Inside a card**, a part is separated by a hairline: `border-t border-line pt-3`, or `divide-y
  divide-line` for a list. The parts of the match page's top card are rows under hairlines: the place,
  the court, "Stay updated".
- **A list of things** (players, matches, clubs) is rows in one card, each 44 px high or more: a title on
  the left, a value or an action on the right, and a chevron (›) when the row opens a page.
- **Optional things** sit behind one `<details>` row ("More options") with a one-line summary
  (DECIDING rule 1). A `<summary>` is a row, not a button.
- A shadow is for what lifts above the page: the picked part of a segmented control, the share bar at the
  bottom, a sheet. A card never has one.

## Buttons

| Kind | Class | Looks like | Use |
|---|---|---|---|
| Prominent | `.btn-primary` | Lime fill, dark text | The action of the screen. One at most. |
| Grey | `.btn-secondary` | Grey fill, ink text | The action of a card: "I booked it", "Choose the video" |
| Plain | `.btn-ghost` | Tint-coloured words, no fill | A small or third action: "Map", "Undo", "Cancel" |
| Destructive | `.btn-danger` | Red text on a pale red fill | Cancel a match, remove a player |

- Sizes: 50 px high (`btn`), 44 px (`btn-sm`). `btn-xs` (36 px) only in a dense table.
- A label is a verb and says what happens: "Choose the video", never "OK". Sentence case.
- No emoji in a button. An icon only where it helps a person know the button: a brand's own logo
  (WhatsApp, Telegram), never a decoration such as 🎟 or 📍.
- A dark fill (`bg-night`) is for one block that leads a screen, such as "Film this match". Never two.

## Chips

A chip (`.chip-*`) says one state of the thing it is on: "Open", "Full", "Live". It is in sentence case,
12 px, medium weight. A row of three chips at most. More facts go into a line of text:
"Level 3 to 4 · Rawai Padel Club".

## Forms

A text field is grey (`bg-fill`) with no border until it has the focus, as in the iPhone's forms. Its
label is above it, short, in `.label`. A choice of two to four is a segmented control (`.segment`). A
switch is for a setting that takes effect at once.

## Motion

Short and quiet: a pressed button dims (`active:opacity-70`), a new block fades in (`.animate-pop`). Nothing
moves for decoration, and `prefers-reduced-motion` stops the rest.

## Copy

DECIDING rule 4 ("words over widgets") and `AGENTS.md` rule 9 hold. On a screen, the shortest words that
say it. A help line under a control is one sentence. If a control needs two sentences of help, the control
is wrong.

## What changed on 24 November 2026

- `globals.css`: the iPhone's greys and hairlines, cards with no border and no shadow, weights one step
  lighter, a grey button for `.btn-secondary` (it was black) and a plain tint button for `.btn-ghost` (it
  was a white box with a border), grey text fields, sentence-case chips, the segmented control.
- The match page's top card: the place, the court ("I booked it") and "Stay updated" are rows under
  hairlines. Before, each was its own box, and one of them was blue.
- The browser bar and the app icon's ground follow the new page colour.
- About 45 boxes inside cards lost their border. A group of rows is now one plain card, as in Settings.
- 133 decorative emoji left the screens: 🎟, 📍, 🔔, 🏆, 🔁 and the rest. ✓ and ✕ stay, because they say a
  state.
- The match page: the players and the pairs are one list each, with a hairline between rows. An avatar
  is a grey circle, and an open place is a dashed circle.
- "I booked it" is a grey button at the end of its row, with one line of help: "Booked and paid in the
  club's app? Tell the others." "Book this court" is a grey button beside the slot.
- The map and booking links are plain tint words, the language switch has no border, and the landing
  page's "Find a game ›" is a link, not a second button.
- The chip text (`--text-2xs`) is 12 px, the iPhone's smallest caption. It was 11 px.

Still to do: the hero chips of a club and a level keep an emoji (📍, 🎚️), and the group page keeps a
long paragraph about the Telegram group. Each needs its own look on a phone.

When you change a screen, check it against "The test for each screen" above. When something here proves
wrong on a real phone, change this file in the same pull request.
