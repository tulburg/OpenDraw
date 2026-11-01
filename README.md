# OpenDraw

A local design app for people working with coding agents. OpenDraw is a desktop canvas where designs are plain HTML elements with CSS, and it runs a local MCP server so agents like Claude Code can read your designs and draw on the canvas while you watch.

It is modeled on [Paper](https://paper.design): the MCP tools use Paper's names and arguments, so prompts written for Paper work here. Everything runs on your machine; nothing is sent anywhere.

> Status: early. The canvas, the document engine and the full MCP read and write tool set work. Most of the editor UI (drawing tools, style editing, multiple pages in the UI) is still to come. See [Roadmap](#roadmap).

## Contents

- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [Connecting Claude Code](#connecting-claude-code)
- [MCP tools](#mcp-tools)
- [Using the app](#using-the-app)
- [Document format](#document-format)
- [Architecture](#architecture)
- [Development](#development)
- [Security](#security)
- [Roadmap](#roadmap)
- [How this project is built](#how-this-project-is-built)

## How it works

- **CSS is the design.** Every node is an element with a CSS style object (`display: flex`, `padding`, `gap`, `backgroundColor`, ...). What you see on the canvas is the browser laying out that CSS, and that CSS is what gets saved and exported. There is no separate Figma-style model to translate.
- **Agents write HTML.** An agent calls `write_html` with inline-styled HTML; OpenDraw turns it into nodes following Paper's rules (flexbox, padding and gap for layout, absolute positioning for decoration) and reports anything it had to drop.
- **Live and undoable.** Every agent call lands on the canvas as soon as it commits and is one step in your undo history. Artboards an agent is working on show an "Agent working" outline.
- **Local MCP server.** The app serves MCP on `127.0.0.1` with a per-launch access token. A small stdio bridge, `opendraw-mcp`, connects clients such as Claude Code to it.

## Getting started

Requirements: macOS (the app is developed and tested there; Windows and Linux builds are untested), [Bun](https://bun.sh) 1.3 or newer, and Node.js 18 or newer (the MCP bridge runs on Node).

```bash
git clone https://github.com/tulburg/OpenDraw.git
cd OpenDraw
bun install
bun run dev
```

`bun run dev` starts Vite and opens the Electron app with hot reload for the editor. `bun run start` builds and runs the production bundle instead.

On first launch OpenDraw creates `~/Documents/OpenDraw/Untitled.opendraw` with one 1440x900 Desktop artboard and opens it. On later launches it reopens the last file, with the window size and position, page, zoom and scroll you left it at.

If Electron fails to start with a missing-binary error, Bun skipped Electron's install script; run it once:

```bash
node node_modules/electron/install.js
```

## Connecting Claude Code

Build once so the bridge exists at `dist-electron/opendraw-mcp.mjs`:

```bash
bun run build
```

Then add it to Claude Code. For every project on your machine:

```bash
claude mcp add -s user opendraw -- node /path/to/OpenDraw/dist-electron/opendraw-mcp.mjs
```

Or only for sessions started in the OpenDraw folder (the default `local` scope):

```bash
claude mcp add opendraw -- node /path/to/OpenDraw/dist-electron/opendraw-mcp.mjs
```

Check it with `claude mcp get opendraw`. Start a new Claude Code session after adding it.

Any MCP client that speaks stdio can use the same command. The bridge:

- finds the running app through a discovery file (`~/Library/Application Support/OpenDraw/mcp.json` on macOS) and re-reads it on every message, so it follows the app across restarts;
- still answers `initialize` and `tools/list` when the app is closed, and every tool call then returns a clear "OpenDraw is not running" error instead of hanging.

OpenDraw has to be running for tools to work; the bridge never starts it.

## MCP tools

Names, arguments and behavior follow Paper's MCP server. Descriptions are OpenDraw's own.

### Read

| Tool | What it returns |
| --- | --- |
| `get_basic_info` | The open file, its pages (and the one you are viewing), artboards with positions and sizes, node count, font families in use. Start here. |
| `get_selection` | The nodes you have selected, with sizes and the artboard each belongs to. |
| `get_tree_summary` | A compact outline of a node's subtree: kind, name, ID and size per line, with a depth limit. |
| `get_node_info` | One node: name, kind, page, parent, children, text, and its position and size. |
| `get_children` | A node's direct children with positions and sizes. |
| `find_nodes` | Nodes matching CSS filters and/or text. Colors match in any notation (`#fff` equals `rgb(255, 255, 255)`), `*` is a wildcard, `--token` finds `var(--token)` uses. |
| `get_jsx` | A subtree as JSX with inline styles or Tailwind classes, ready to paste into a codebase. |
| `get_computed_styles` | The browser's computed CSS for nodes: real sizes of flex children, inherited fonts, resolved colors. |
| `get_screenshot` | A PNG of a node at scale 1 or 2, rendered fresh in a hidden window so it does not depend on your zoom or scroll. |

### Write

| Tool | What it does |
| --- | --- |
| `create_artboard` | Adds an artboard (defaults: flex column, white background) in the first empty spot on the page, 80 px from its neighbours. `pageId` targets another page without changing your view. |
| `write_html` | Turns inline-styled HTML into nodes, appended inside a node (`insert-children`) or in place of it (`replace`). Returns the created nodes and a list of anything dropped. |
| `update_styles` | Sets styles on many nodes at once. Styles that would have no effect (margins, grid, offsets on non-positioned nodes, invalid values) come back under `ignoredStyles` with the reason. |
| `set_text_content` | Replaces the text of text nodes, keeping their IDs and styles. |
| `rename_nodes` | Renames layers (up to 50 characters). |
| `move_nodes` | Moves nodes before or after a sibling or into a parent at an index, across pages, keeping their IDs. |
| `duplicate_nodes` | Deep-copies nodes with new IDs and returns a map from each original ID to its copy. |
| `delete_nodes` | Deletes nodes and their descendants. |
| `finish_working_on_nodes` | Clears the "Agent working" indicator (it also clears 30 s after the last write). |

### HTML rules for `write_html`

- Inline styles only (`style="..."`). Layout is flexbox with `padding` and `gap`; absolute positioning is for decoration. Sizing is `border-box`.
- Dropped and reported: `margin`, `display: grid` and grid properties, inline display (`inline`, `inline-block`, `inline-flex`), tables, `<script>`, `<style>`, form controls, and the Paper clone tag.
- `layer-name="Hero"` sets the layer name.
- `<img src>` takes `http`, `https` or `data:` image URLs. `<svg>` is kept as vector markup (sanitized). `<pre>` or `white-space: pre` keeps whitespace.
- An element that holds only text becomes a text node. Headings, links, `<b>`, `<em>` and similar get the same defaults a browser gives them, so the design matches the HTML.
- An artboard's content starts from plain web-page defaults (16 px text, black, the browser's default font), so HTML looks the same as in a browser.

## Using the app

| Action | How |
| --- | --- |
| Pan | Scroll, or hold Space (or the middle mouse button) and drag |
| Zoom | Pinch, or Cmd + scroll; Cmd + `=` / Cmd + `-` to step; Cmd + `0` for 100% |
| Fit everything | Shift + `1` |
| Select | Click an artboard or a layer in the Layers panel; Escape clears |
| Undo / redo | Cmd + Z / Shift + Cmd + Z (also in the Edit menu) |

The left panel shows the nested layer tree; the right panel shows the selected node's CSS (read-only for now). Changes save automatically about half a second after each edit, and before the window closes.

## Document format

Files are JSON with the `.opendraw` extension, saved in `~/Documents/OpenDraw`.

```json
{
  "format": "opendraw",
  "version": 1,
  "id": "…",
  "name": "Untitled",
  "pages": [
    {
      "id": "…",
      "name": "Page 1",
      "nodes": [
        {
          "id": "…",
          "type": "artboard",
          "name": "Desktop",
          "style": { "left": "0px", "top": "0px", "width": "1440px", "height": "900px", "display": "flex", "flexDirection": "column" },
          "children": []
        }
      ]
    }
  ]
}
```

A node has `id`, `type` (`artboard`, `frame`, `text`, `image` or `svg`), `name`, `style` (camelCase CSS, like React's `style` prop) and `children`. Text nodes add `text`, images add `src` and SVG nodes add their `svg` markup. Artboards sit directly on a page and are positioned on the canvas by `left` and `top`.

## Architecture

```
Claude Code --stdio--> opendraw-mcp (bin/) --HTTP, 127.0.0.1 + token--> MCP server (Electron main)
                                                                             |
                                                     read and write requests |
                                                                             v
                                   Editor window (React): document store, undo history
                                   Hidden render window: screenshots, computed styles
```
- **Electron main process** (`electron/`): window, menus, file I/O and autosave, the MCP server (`electron/mcp/server.ts`) and the hidden offscreen render window (`electron/mcp/render.ts`).
- **Editor** (`src/`): React 19. `src/document/` is the document engine: immutable tree edits, a store where every change is a transaction and one undo step, style rules, autosave. `src/canvas/` renders nodes as real DOM elements. `src/mcp/` runs the write tools and the HTML import.
- **Shared** (`shared/`): the document types, MCP tool definitions (zod schemas) and the read tools, which work on a snapshot of the document plus live layout measured from the canvas.
- **Bridge** (`bin/opendraw-mcp.ts`): a Node script bundled with its dependencies into one file, `dist-electron/opendraw-mcp.mjs`.

Stack: Electron, React, TypeScript, Vite, Bun, and the official MCP TypeScript SDK (`@modelcontextprotocol/server`) with zod.

## Development

| Command | What it does |
| --- | --- |
| `bun run dev` | Run the app with hot reload |
| `bun run build` | Build the editor, main process, preload and bridge |
| `bun run start` | Build and run the production bundle |
| `bun run typecheck` | Type-check everything |
| `bun run test` | Build and run every end-to-end suite |
| `bun run test:launch` | First launch, window, canvas and relaunch (8 checks) |
| `bun run test:engine` | Document engine: edits, undo, autosave, crash safety (7 checks) |
| `bun run test:mcp` | MCP server and read tools through the real bridge (11 checks) |
| `bun run test:write` | MCP write tools, including a landing page compared pixel by pixel with a plain browser (8 checks) |

The tests launch the real Electron app with a throwaway profile and drive it over the Chrome DevTools Protocol. Results and screenshots go to `tests/results/`. Set `OPENDRAW_TEST_LOGS=1` to see the app's logs.

Environment variables:

| Variable | Effect |
| --- | --- |
| `OPENDRAW_WORKSPACE` | Folder for documents (default `~/Documents/OpenDraw`) |
| `OPENDRAW_USER_DATA` | App data folder, where state and the MCP discovery file live |
| `OPENDRAW_MCP_PORT` | Fixed port for the MCP server (default: a random free port) |
| `OPENDRAW_MCP_DISCOVERY` | Discovery file the bridge reads (default: the app's data folder) |

## Security

- The MCP server listens on `127.0.0.1` only, on a random port, and only at `/mcp`.
- Every request needs a bearer token that is generated per launch and written to the discovery file with permissions `600` (readable by your user only). The file is removed when the app quits.
- Host and Origin headers are checked, so web pages in your browser cannot reach the server (DNS rebinding and cross-origin requests are rejected).
- SVG from agents or files is sanitized before it is drawn: scripts, event handlers, `<style>`, `<foreignObject>` and outside references are removed. Images load only from `http`, `https` and `data:` URLs.

## Roadmap

Done: first launch and canvas, the document engine with undo and autosave, the MCP server with Paper's read tools, and the write tools.

Next, roughly in order:

- Rich text in text nodes (today, formatting on part of a text, such as a `<b>` inside a `<p>`, is flattened to plain text and reported)
- Editing in the UI: selection on the canvas, moving and resizing, a style editor
- Pages, files and folders (`create_page`, `open_file`, resources)
- Design tokens (CSS variables), comments and export
- The clone tag in `write_html`, local image files

The [gap analysis](GAP_ANALYSIS.md) has the full comparison with Paper.

## How this project is built

Every feature starts as a spec on a Spill board (a visual spec board for agent work), stored in [`.spill/`](.spill/): questions, decisions and specs with acceptance checks, which are recorded on the card when the checks run. [`CLAUDE.md`](CLAUDE.md) holds the working rules for agents in this repo.

OpenDraw started from a study of [open-pencil](https://github.com/open-pencil/open-pencil), an open-source Figma-style editor. It is a new, CSS-native app rather than a fork: open-pencil's ideas informed the MCP server and the canvas, but no code was copied.
