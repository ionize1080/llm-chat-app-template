# VEAIX design system

VEAIX is a Chinese-first AI workspace for conversation, document reading and visual creation. Its interface operates in Operate / Read mode: legibility, task continuity and truthful access states matter more than decoration. The 2026-10-29 refinement follows Impeccable's polish, operate and craft-floor guidance. The user explicitly replaced the former gray-green mood with a warm, lively and carefully finished direction, and requested a new logo.

## Identity and surfaces

The transparent `public/logo-symbol.png` carries the new airy symbol with a vermilion main form and golden-apricot upper wing; `public/logo-wordmark.svg` is the accompanying custom lowercase warm-ink wordmark with a coral dot. The symbol is not clipped, boxed or inverted in dark mode. Navigation renders it at 48px so its transparent breathing room remains visible; the welcome and authentication surfaces use a larger version. The wordmark may be recolored for dark backgrounds independently. The PNG also serves as the favicon.

Light: warm ivory canvas `#fffaf5`, peach-ivory sidebar `#fff0e2`, luminous working surface `#fffdf9`, warm ink `#302a27`, secondary ink `#7a5845`, vermilion action `#b9432c`, apricot selected surface `#ffdec7`, and small teal accents `#176b60`. The accent is visible in the new-chat action, active navigation, heading, composer outline, model selection, send button and connection tools. Dark: warm espresso canvas `#211b18`, sidebar `#191411`, panel `#30251f`, cream text `#fff0e1`, peach action `#ffb58d` and restrained mint success accents. Semantic tokens own selected, hover, danger, success and focus states. No gray haze, decorative gradients, grain, glass or artificial charts. Borders separate ordinary surfaces; a warm soft offset shadow gives overlays elevation.

## Layout and typography

Desktop uses a 248px sidebar, 72px workspace header, centered 808px reading column and anchored 872px composer area. The sidebar holds workspaces, model library, title search across loaded conversation history and the saved-connection entry. On mobile the sidebar becomes an overlay; the composer stays within the visual viewport and safe area. The model picker positions against the viewport rather than an overflow-clipped ancestor. The settings provider rail becomes horizontally scrollable on mobile.

The system UI sans stack supports Chinese without remote font requests. Chat is 15px with 1.85 line height; primary labels 13–14px; secondary labels at least 11px; content-bearing help paragraphs 12px. Headings use a fixed scale, with 36px welcome type and 30px mobile type. Color and hierarchy, rather than extra borders, organize the start screen. The same authored SVG stroke family serves all functional icons. Focus is visible, selection and caret colors follow the palette, and reduced-motion settings suppress nonessential transitions.

## Model discovery

The searchable model panel displays upstream catalog freshness, manual refresh, ready/vision filters, model-manufacturer and connection-channel filters. A model publisher (OpenAI, Anthropic, Google, etc.) is distinct from its route (OpenRouter or a direct API). Rows show name, actual provider ID, vision capability, supported context and input/output price per million tokens when the provider supplies those values. Missing pricing is not interpreted as zero.

Access is visible and actionable: site free allocation, site-paid, sign-in required, connect key, connected and selected states. Clicking a login-only model prompts login; clicking an unconfigured remote model opens the correct key provider. Hundreds of catalog entries do not imply that all are currently callable: the usable filter reflects authentication and configured credentials. Catalog errors preserve available site models and identify stale upstream data.

## Saved BYOK

Credentials use a focused settings dialog with provider navigation, masked saved-state summary, provider-specific API-console link and explicit API-billing explanation. Users can verify, save/replace, reveal their currently typed value, or remove a saved key with an inline confirmation. The API secret is cleared when the dialog closes and after successful saving. No API key is persisted to localStorage or sessionStorage. Only masked server metadata is held in UI state; the server performs encryption and owns the stable account association. Requests go through the site server to the selected official service. Chat-product subscriptions are not represented as API credits.

## Interaction and references

Keyboard navigation supports model-list arrows, Home/End, Enter and Escape. The model search receives focus on open. Existing send/stop/retry, uploads, image generation, source details, export, theme and login flows remain. History title search and a return-to-latest-message control shorten common journeys. Authentication and catalog refresh invalidate private provider state on logout.

Official product references consulted on 2026-10-29:

- [ChatGPT content search](https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt): discoverable sidebar search and contextual filters.
- [Claude desktop navigation](https://academy.claude.com/tutorials/navigating-the-claude-desktop-app): a consistent conversational workspace and adjacent attachment tools across surfaces.
- [Perplexity Pro model selection](https://www.perplexity.ai/help-center/en/articles/10352901-what-is-perplexity-pro): explicit model choice and separate access tiers. Its static marketing examples are not used as our model catalog.
- [Impeccable](https://github.com/pbakaus/impeccable): context, scoped polish, Operate/Read guidance and mechanical design detector.

Verification: frontend bundle and JavaScript syntax checks; static checks verified 77 unique HTML IDs, 153 selector references, local asset presence, CSS brace structure, no key persistence in browser storage, and AA contrast for core light/dark palette combinations. Impeccable detector identified sidebar muted-text contrast and sub-11px helper text, corrected in the shared tokens and type rules. Browser visual QA was unavailable under this environment's browser policy, so actual viewport appearance and pointer interaction were not claimed as visually verified.
