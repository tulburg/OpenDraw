# OpenDraw: open pencil → Paper gap analysis

Baseline: `open-pencil` @ `932e499b0` (2026-11-01), v0.16.0, MIT. Cloned at `./open-pencil`.

**Rule: Paper wins ties.** Where the two differ, OpenDraw follows Paper. The biggest consequence: CSS is the document model, not open pencil's Figma-style scene graph. A node is an element with CSS styles, and everything else (layout, computed styles, JSX, tokens) derives from that.

## What open pencil gives us, judged against a CSS-native model

| Area | Where | Carries over? |
| --- | --- | --- |
| MCP server: stdio and Streamable HTTP, sessions, Unix socket, MCP root sandboxing, RPC bridge to the app | `packages/mcp` | **Yes.** Model-independent; replace the tool set |
| Tool registry pattern (Valibot schemas, read/write effects, capabilities) | `packages/core/src/tools/registry` | **Yes**, as a pattern for our tools |
| Desktop shell (Tauri v2) and web/PWA build | `desktop/`, `vite/` | **Yes** |
| HTML/CSS parsing, browser `getComputedStyle()` sandbox, Tailwind pipeline | `packages/dom-css` (`runtime`, `import`) | **Partly.** Parsing and the runtime are useful; its projection into the scene graph is not |
| CSS custom-property output for tokens | `packages/dom-css/src/tokens`, `design_to_tokens` | **Partly** |
| Collaboration (WebRTC), comments, CLI shape, lint ideas | various | **Partly**, after rework for the new model |
| Scene graph (fill arrays, sizing modes, auto-layout props) | `packages/scene-graph` | **No.** This is the Figma-style model we're replacing |
| CanvasKit/Skia renderer, Yoga layout | `packages/core` | **No**, if the canvas renders real DOM (see below) |
| ~130 agent tools | `packages/core/src/tools` | **Mostly no.** Written against the scene graph; useful as a reference |
| `.fig`/`.pen` I/O | `packages/fig`, `packages/pen`, `packages/kiwi` | **Optional** import path later, converting into CSS |

Paper's HTML rules (flex only, padding and gap, no margin, no grid, no tables, no inline) still match what Yoga can lay out. But with CSS canonical, the browser's own layout engine is the natural renderer, and Yoga is no longer needed.

## Major gaps

1. **A CSS-native document model and canvas.** Paper's agents work entirely in CSS: `write_html`, `update_styles` (camelCase CSS with `ignoredStyles`), `get_computed_styles`, and `get_jsx` (inline styles or Tailwind). Open pencil stores Figma-style properties and renders them with CanvasKit, so this is a new core, not an adapter. It needs:
   - a node store where each node is a tag, a layer name, a style object, and children, with undo and change events;
   - a canvas that renders nodes as real DOM (pan/zoom, selection, handles drawn over it), so layout, fonts, gradients, filters and computed styles come from the browser;
   - per-node style updates that drop styles that are inert in context and report them as `ignoredStyles`;
   - raster/PDF export from that DOM (for example a WebView snapshot or an HTML-to-image library), since CanvasKit export no longer applies.
2. **Paper-compatible MCP surface.** Paper has about 45 tools with different names, arguments, and semantics, and every call takes an explicit `fileId` (and often a `pageId`). Open pencil's tools act on the active document. We need a new tool set, either a `paper` profile in `packages/mcp/src/tool/registration.ts` or our own package, that maps each Paper tool onto core operations and can address any open document by ID.
3. **Files, folders and resources.** Paper has `list_resources`, `create_file`, `create_folder`, `move_resources`, `rename_resource`, `archive_resources`, `unarchive_resources`, and `open_file`, plus drafts and open/active tab state. Open pencil only has tabs plus `open_file`, `new_document`, `save_file`, and `list_recent_files` inside the MCP root. We need a local workspace: a folder tree on disk plus an index (SQLite or JSON) with stable IDs, archive flags, and timestamps. `packages/cloud` covers similar ground (Postgres, S3, accounts), but it's too heavy for a local-only app.
4. **Design tokens as typed CSS custom properties.** Paper has `create_tokens`, `get_tokens`, and `set_tokens`, typed as color, spacing, radius, fontSize, fontWeight, lineHeight, letterSpacing, opacity, breakpoint, container, or fontFamily, with `var(--x)` aliases usable inside any style. Open pencil has variables, collections, and modes, plus CSS export (`design_to_tokens`). Missing: token-type mapping, name-based `var()` resolution when writing HTML or styles, and returning `var()` references in JSX and computed styles.
5. **Live agent editing UX.** Paper draws incremental writes on the canvas in real time and shows which nodes an agent is working on (`finish_working_on_nodes`). Open pencil already has presence cursors for human peers. Adding an agent-presence indicator, plus a working-set lifecycle that clears when the agent finishes, is new work.
6. **Rich-text spans.** Paper's text nodes take inline-formatted spans (`set_text_content`, the "Inline formatting" guide) and must round-trip through JSX. Open pencil has `set_font_range` and style runs; we need span HTML ⇄ style-run conversion in both directions.

## Minor gaps (mostly adapters over existing code)

| Paper tool or feature | Open pencil equivalent | Work |
| --- | --- | --- |
| `create_artboard` (defaults to flex column, auto-placed with 80px spacing, `fit-content` height) | `create_shape` FRAME | Placement heuristic, defaults |
| `get_tree_summary` (depth, `?` for unmeasured sizes) | `node_tree`, `get_page_tree` | Format adapter |
| `get_node_info`, `get_children`, `find_nodes`, `get_selection`, `get_basic_info` | `get_node`, `node_children`, `find_nodes`/`query_nodes`, `get_selection`, `list_pages` | Adapters |
| `duplicate_nodes`, `<x-paper-clone node-id>` inside `write_html` | `clone_node` | Parse the custom tag in the HTML import |
| `move_nodes`, `rename_nodes`, `delete_nodes`, `set_text_content` | `reparent_node`, `rename_node`, `delete_node`, `set_text` | Batch adapters |
| `create_page`, `update_pages`, `arrange_pages` | `create_page`, `switch_page` | Rename and reorder |
| `get_screenshot` | `export_image` (base64) | Adapter |
| `export`: avif, scale units `2x`/`720p`/`512w`/`512h`, `nodes-with-exports-only`; `export_combined_pdf` | PNG/JPG/WEBP/SVG/PDF export | Add AVIF, scale parser, per-node export settings, multi-page PDF |
| `export` video (mp4/webm) | None (no media layers or animation) | Major if needed; defer |
| Comment threads: `list_comment_threads`, `get_comment_thread`, `set_comment_thread_status`, `list_comment_thread_authors` | `add_comment`, `get_comments`, `reply_to_comment`, `resolve_comment` | Thread/status model and authors |
| `get_font_family_info` | `list_fonts`, `list_available_fonts`, `get_font_status` | Adapter; Google Fonts on demand |
| `get_fill_image` | Image fills exist | Extraction adapter |
| `get_guide` topics | AI prompts in `core/src/tools/prompts` | Write our own guide content |
| `paper-asset://` local images | `set_image_fill`, `import_svg` | URL scheme handler restricted to the MCP root |
| `paper-gen://` AI image generation | `stock_photo`, vectorization providers | Optional; BYOK provider |

## Things to decide early

- **Source of truth: decided.** CSS is canonical, following Paper. Nodes store CSS and the canvas renders it.
- **Fork or build new.** That decision changes the earlier lean toward forking. The editor UI, scene graph, renderer and tools are all built around the Figma-style model, so a fork would mean ripping out most of its core. Recommend a new CSS-native app that borrows open pencil's MCP server package, tool registry pattern, Tauri shell setup and the useful parts of `dom-css`, with `./open-pencil` kept as a reference checkout. This is the first question for the Spill board.
- **Renderer.** Real DOM (recommended: CSS fidelity and computed styles for free) or a custom renderer (more control over huge canvases, but re-implements CSS). Worth a spike to check DOM canvas performance with a few hundred artboards.
- **Naming and branding.** Ship as OpenDraw with a Paper-compatible MCP API. Don't copy Paper's branding or UI assets.
