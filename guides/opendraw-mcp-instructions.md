# Working with OpenDraw

OpenDraw is a local design app. A file has pages; a page holds artboards (top-level frames placed on the canvas with `left` and `top`); artboards hold frames, text, images and SVG. Every node is an HTML element with inline CSS, and that CSS is what gets saved. The tools here use Paper's names and arguments.

## Start

1. `get_basic_info` to learn the file, its pages, the artboards on the page in view, and the fonts in use. Omit `fileId` for the file in front, or call `list_resources` and `open_file` for another.
2. `get_selection` to see what the user is focused on.
3. `get_tree_summary` on an artboard before reading details with `get_node_info`, `get_children` or `get_jsx`.
4. `get_tokens` to learn the design tokens. Use them in styles as `var(--name)` instead of raw values.
5. `get_font_family_info` before your first typographic styling. Prefer families already in the file. A Google Fonts family loads the first time a style uses it.

`pageId` defaults to the page the user is viewing. Pass it to work on another page; you cannot switch the user's page.

## Write

- Before a new design, write a short brief: palette, type scale, spacing, direction. Skip it when the file already has tokens or a design system.
- `create_artboard` for a new screen, then `write_html` to fill it. Each `write_html` call should add about one visual group (a header, a card, a list), not a whole screen.
- Layout is flexbox with `padding` and `gap`. Absolute positioning is for decoration. Margins, grid, inline display and tables are not supported.
- Use `px` for font sizes and line heights, `em` for letter spacing.
- Reuse layers: `<x-opendraw-clone node-id="...">` inside `write_html` inserts a copy of an existing node. `style` and `layer-name` on the tag override the copy's root style and name. `duplicate_nodes` with `update_styles` and `set_text_content` is often faster than writing new HTML.
- Images: `src` and `background-image` take `https://`, `data:` and `opendraw-asset://` URLs. An absolute path (`opendraw-asset:///Users/name/logo.png`) copies the image into the design file; a relative path (`opendraw-asset://images/logo.png`) uses the file in the workspace folder.
- Repeated rows (lists, nav): give icons and trailing actions fixed-width slots with `flex-shrink: 0`; gap alone will not align columns across rows.
- Artboard height is a starting point. When content clips, set `height: fit-content` with `update_styles` instead of guessing a height.

## Review

- `get_screenshot` after each meaningful change. It renders the node fresh, independent of the user's zoom.
- For exact values (export to code), use `get_jsx`, `get_computed_styles` and `get_fill_image`. Never read sizes or colors from a screenshot.

## Comments

`list_comment_threads` shows open review feedback. Read a thread with `get_comment_thread`, make the change, then mark it done with `set_comment_thread_status`.

## Pages and files

`create_page`, `update_pages` and `arrange_pages` manage pages. `create_file`, `create_folder`, `move_resources` and `rename_resource` manage the workspace.

## Finish

When you are done creating or editing, call `finish_working_on_nodes` so the working indicators clear. Never show raw node IDs to the user.
