# Theme conventions (for uploaded HTML)

If you are generating HTML to put on this site (drop), this document is the generation rule as it stands.
In short: write a single-file HTML page, build its colors only from the `--drop-*` variables described below,
and do not use hard-coded color codes directly. Starting from the "Starter template" below is the safest way.

When drop serves uploaded HTML at `/p/:id/f/*`, it injects a minimal set of design rules.
The original (what view raw / download gives you) is not modified.

## Starter template

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page title</title>
<style>
  /* Follow drop's theme variables; outside drop, display with the fallback values */
  :root {
    color-scheme: light dark;
    --bg: var(--drop-bg, #f7f7f8);
    --surface: var(--drop-bg-elevated, #ffffff);
    --text: var(--drop-text, #17181c);
    --muted: var(--drop-text-muted, #6b7280);
    --border: var(--drop-border, #e4e5e9);
    --accent: var(--drop-accent, #16a34a);
    --danger: var(--drop-danger, #b91c1c);
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: "Hiragino Sans", "Noto Sans JP", sans-serif;
    max-width: 880px;
    margin: 0 auto;
    padding: 32px 24px 80px;
    line-height: 1.9;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 24px;
    margin: 20px 0;
  }
  a { color: var(--accent); }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  th { background: var(--bg); }
</style>
</head>
<body>
</body>
</html>
```

Set `lang` to the language of the page's content.

When you need a tint that is not in the template (such as the background of a note), mix it from the tokens with
`color-mix()` instead of using a hard-coded color code:

```css
.note {
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--surface));
}
```

## What every page gets automatically

- Defensive CSS in `@layer drop-defaults`: keeps images from overflowing, scrolls `pre` horizontally, and scrolls
  tables horizontally at mobile widths. It is the weakest layer with zero specificity, so whenever the page writes
  its own styles, those always win
- `<meta name="viewport">` (only if the page does not have one)
- The `--drop-*` CSS variables (see below)

HTML with no styling at all (no style element, no stylesheet link, no style attribute, and no presentational
attributes such as bgcolor) also gets `color-scheme` injected, so it follows light/dark without doing anything.

## Opt-in convention: the --drop-* variables

drop's theme palette is defined as CSS variables on `:root` of every page.
Just by referring to them, a page gets the same colors as the shell and follows the theme the same way (the OS
setting plus an explicit switch in the admin app). If a page does not refer to them, nothing happens.

| Variable | Use |
|---|---|
| `--drop-bg` | Page background |
| `--drop-bg-elevated` | Background of raised surfaces such as cards and panels |
| `--drop-text` | Base text color |
| `--drop-text-muted` | Subdued text color for notes, labels and the like |
| `--drop-border` | Rules and borders |
| `--drop-accent` | Accent (links, emphasis) |
| `--drop-danger` | Danger, errors |

### Recommended pattern

```html
<style>
  :root { color-scheme: light dark; }
  body {
    background: var(--drop-bg, #f7f7f8);
    color: var(--drop-text, #17181c);
  }
  table, th, td { border-color: var(--drop-border, #e4e5e9); }
  a { color: var(--drop-accent, #16a34a); }
</style>
```

- With fallback values, the file does not break when opened directly outside drop
- Declaring `color-scheme: light dark` yourself makes form controls and scrollbars follow the theme as well
  (drop does not inject it into pages that have their own styles)

### How the theme is passed

- When nothing is specified: the variable values switch with the OS's `prefers-color-scheme`
- When the theme is set explicitly in the admin app: it is passed as `?theme=dark|light` (e.g.
  `/p/:id/f/index.html?theme=dark`), and the variables take that fixed value. In addition, `<html>` gets
  `data-theme="dark|light"`, so you can also write your own dark styles with a `[data-theme='dark']` selector
  instead of using the variables

## Prompt snippet for AI generation

When having an AI generate HTML to put on drop, add this:

> Output the HTML as a single file. For colors, use the CSS variables --drop-bg /
> --drop-bg-elevated / --drop-text / --drop-text-muted / --drop-border /
> --drop-accent / --drop-danger with fallback values
> (e.g. `var(--drop-bg, #f7f7f8)`), and declare
> `:root { color-scheme: light dark; }`. The host defines values for these
> variables that support both light and dark. Do not use hard-coded color codes directly.
