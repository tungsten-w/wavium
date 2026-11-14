# Wavium: name and logo

- Branch: `night/brand` (on top of `night/v1`) · Instance: session A · Date: 2026-11-13
- Status: done

## Done

- **Name**: the product name is **Wavium** everywhere a person sees it:
  - server defaults (`OC_Defaults`: name, title, entity, product name; the
    theming default);
  - the page title, the login page, the header, and every visible text of the
    React UIs that said "Atrium" (Mail, Settings, Agents, AI...);
  - the README;
  - new slogan: "Your mail, calendar, files and AI agents, in one calm
    place".
- **Logo** (the user's `wavium-logo-wave-01.svg`, kept as-is in
  `core/img/wavium/wave-w.svg`):
  - header logo: the white wave W next to the name;
  - app icon: the W on an ocean gradient (`#0a3d8f` → `#00a6c7`), rounded
    square (`core/img/wavium/app-icon.svg`), PNG 512 px;
  - favicons: `favicon.svg` (gradient), `favicon.ico` (16/32/48),
    `favicon.png`, `favicon-touch.png` (180), `favicon-fb.png`,
    `logo-icon-175px.png`, `logo.png`, mask icon;
  - a wordmark (`core/img/wavium/wordmark.svg`);
  - login page: a large mark (96 px) on the gradient, the name in big type,
    the slogan.
  - Default primary colour `#0b6aa8` (the icon's blue).
- **Not renamed, on purpose**: code identifiers, `@atrium/*` packages, routes,
  CSS classes, containers, `ATRIUM_*` variables, the repository. Renaming them
  breaks things without changing anything a person sees. Existing instances
  that saved their own theming name keep it (Settings > Appearance).

## Tested

`make lint` OK; web tests 108 passed. PNGs were rendered with PHP Imagick in
the project's PHP image. Imagick does not draw SVG gradients, so the PNGs use
the solid `#0b6aa8`; the SVGs keep the gradient.

## Questions for the human

- Is the ocean gradient the colour you want, or do you have brand colours?
- Should the code and the containers be renamed later too (a big, risky
  change)?
