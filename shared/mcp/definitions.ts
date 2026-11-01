// Tool names and arguments follow Paper's MCP server so prompts written for Paper work here.
// Descriptions are OpenDraw's own.
import { z } from 'zod'

const fileId = z.string().describe('ID of the file to work on. Omit for the file open in OpenDraw.')
const requiredFileId = z.string().describe('ID of the file to work on, from get_basic_info.')
const pageId = z.string().describe('ID of the page to work on. Omit for the page the user is viewing.')
const nodeId = z.string().describe('ID of the node.')

export const SERVER_INSTRUCTIONS = `OpenDraw is a local design app. Its documents are CSS-native: every node is an HTML element with inline CSS, and that CSS is what gets saved.

- A file has pages; a page holds artboards (top-level frames positioned on the canvas with left/top); artboards hold frames, text, images and SVG.
- Layout is flexbox with padding and gap. Absolute positioning is for decoration. Margins, grid, inline display and tables are not supported.
- Start with get_basic_info to learn the pages, artboards and sizes, and get_tree_summary to see structure before reading details.
- Sizes and positions come from the live canvas. They are null for nodes on pages the user is not viewing.
- get_computed_styles and get_screenshot render the node fresh, independent of the user's zoom and scroll.`

export const readTools = {
  get_basic_info: {
    description:
      'Start here. Returns the open file (ID and name), its pages with the one the user is viewing, the artboards on a page with their positions and sizes, the node count and the font families in use.',
    inputSchema: z.object({ fileId: fileId.optional(), pageId: pageId.optional() })
  },
  get_selection: {
    description: 'Returns the nodes the user has selected: ID, name, kind, size and the artboard each belongs to.',
    inputSchema: z.object({ fileId: fileId.optional() })
  },
  get_tree_summary: {
    description:
      'A compact indented outline of a node and its descendants: kind, name, ID and size per line. "?" marks a size that was not measured. Cheaper than get_jsx for learning structure.',
    inputSchema: z.object({
      fileId: requiredFileId,
      nodeId,
      depth: z.number().int().min(1).max(10).optional().describe('Levels to include (default 3, at most 10).')
    })
  },
  get_node_info: {
    description:
      'Details for one node: name, kind, page, parent, child IDs, visibility, text content for text nodes, and its position (world and relative to its parent) and size.',
    inputSchema: z.object({ fileId: requiredFileId, nodeId })
  },
  get_children: {
    description: "A node's direct children with their names, kinds, child counts, positions and sizes.",
    inputSchema: z.object({ fileId: requiredFileId, nodeId })
  },
  find_nodes: {
    description:
      'Search nodes by their CSS and/or text. Filters are { styleName, styleValue } pairs that must all match; "*" is a wildcard; colors match in any notation (#fff equals rgb(255, 255, 255)); a "--token" value finds var(--token) uses. textValue matches text node content, case-insensitive, with "*" wildcards. Searches the whole file unless nodeId or pageId narrows it.',
    inputSchema: z.object({
      fileId: requiredFileId,
      nodeId: z.string().optional().describe('Search this node and its descendants.'),
      pageId: z.string().optional().describe('Search this page.'),
      textValue: z.string().optional().describe('Text to match, "*" wildcards allowed.'),
      filters: z
        .array(
          z.object({
            styleName: z.string().optional().describe('CSS property, camelCase or kebab-case, "*" allowed.'),
            styleValue: z.string().optional().describe('Value, color or "--token" to match, "*" allowed.')
          })
        )
        .min(1)
        .optional()
    })
  },
  get_jsx: {
    description:
      'The node and its descendants as JSX, with inline styles (default) or Tailwind classes. Node IDs are included as id attributes unless includeNodeIds is false; pass false to get clean code for a codebase.',
    inputSchema: z.object({
      fileId: requiredFileId,
      nodeId,
      format: z.enum(['inline-styles', 'tailwind']).optional(),
      includeNodeIds: z.boolean().optional().describe('Add id attributes with node IDs (default true).'),
      includeRootPositioning: z
        .boolean()
        .optional()
        .describe("Keep the root's canvas position styles (default false, so the JSX is portable).")
    })
  },
  get_computed_styles: {
    description:
      'Computed CSS for one or more nodes, as the browser lays them out: actual sizes of flex children, inherited fonts and resolved colors. Returns a map from node ID to camelCase properties.',
    inputSchema: z.object({ fileId: requiredFileId, nodeIds: z.array(z.string()).min(1) })
  },
  get_screenshot: {
    description:
      'A PNG of a node, rendered fresh at scale 1 (default) or 2. Use scale 1 to check layout and 2 to read small text.',
    inputSchema: z.object({
      fileId: requiredFileId,
      nodeId,
      scale: z.number().min(0.25).max(4).optional().describe('Render scale, 1 or 2 (default 1).')
    })
  }
}

export type ReadToolName = keyof typeof readTools

export const NOT_RUNNING_MESSAGE =
  'OpenDraw is not running. Ask the user to open the OpenDraw app, then try again. Do not try to start it yourself.'

const styles = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .describe('CSS as a JSON object with camelCase properties, like React.CSSProperties: {"backgroundColor": "#fff", "padding": "20px"}.')

export const writeTools = {
  create_artboard: {
    description:
      'Creates an artboard (a top-level frame) and returns its ID; add content with write_html in insert-children mode. width and height are required whole-pixel values (Desktop 1440x900, Tablet 768x1024, Mobile 390x844). Artboards default to display flex, flex-direction column and a white background, and are placed in the first empty spot on the page, 80 px from other artboards, unless styles give left and top. pageId puts it on another page without changing what the user sees.',
    inputSchema: z.object({
      fileId: requiredFileId,
      name: z.string().describe('Name shown in the layers panel.'),
      pageId: pageId.optional(),
      styles: styles.and(z.object({ width: z.string(), height: z.string() }))
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  write_html: {
    description: `Turns HTML with inline styles into design nodes. "insert-children" appends them inside targetNodeId; "replace" removes targetNodeId and puts them in its place. Each call is one undo step and appears on the canvas immediately, so write one visual group per call (a header, a card, a row).

Rules:
- Inline styles only (style="..."). Layout is flexbox with padding and gap; absolute positioning is for decoration. display: block is fine for simple elements, not for layout containers. Sizing is border-box.
- Not supported, dropped and listed in the response: margin, display: grid and grid properties, display: inline (and inline-block, inline-flex), tables, scripts, style elements and form controls.
- layer-name="Hero" sets the layer name.
- <img src> takes http, https or data: image URLs. <svg> is kept as vector markup. <pre> or white-space: pre keeps whitespace.
- An element holding only text becomes a text node. Formatting on part of the text (a <b> or a styled <span> inside a <p>) is kept as rich text; a run can carry only text styles (color, font, weight, style, size, letter-spacing, line-height, text-transform, text-decoration, text stroke, and backgrounds with background-clip: text), and other properties on it are dropped and reported.`,
    inputSchema: z.object({
      fileId: requiredFileId,
      html: z.string().describe('HTML to turn into nodes.'),
      targetNodeId: z.string().describe('In insert-children mode the parent; in replace mode the node to replace.'),
      mode: z.enum(['insert-children', 'replace'])
    }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  update_styles: {
    description:
      'Sets styles on one or more nodes in one undo step. Each update applies its styles to all of its nodeIds; null removes a property. Setting left and top on an artboard moves it on the canvas. Styles that would have no effect where the node sits (margins, grid, offsets on a node that is not absolutely positioned, invalid values) are left out and returned under ignoredStyles with the reason.',
    inputSchema: z.object({
      fileId: requiredFileId,
      updates: z
        .array(
          z.object({
            nodeIds: z.array(z.string()).min(1),
            styles: z.record(z.string(), z.union([z.string(), z.number(), z.null()]))
          })
        )
        .min(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  set_text_content: {
    description:
      "Replaces the text of one or more text nodes, keeping their IDs and styles. html is the node's inner content without a wrapper; whitespace is kept as written and <br> is a line break. Inline formatting (<b>, <i>, <u>, styled <span>s) is kept as rich text; runs carry only text styles. update_styles on the node styles all of its text, replacing that property on every run.",
    inputSchema: z.object({
      fileId: requiredFileId,
      updates: z.array(z.object({ nodeId, html: z.string() })).min(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  rename_nodes: {
    description: 'Renames one or more layers. Names longer than 50 characters are cut short.',
    inputSchema: z.object({
      fileId: requiredFileId,
      updates: z.array(z.object({ nodeId, name: z.string() })).min(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  move_nodes: {
    description: `Moves nodes, keeping their IDs. Each move is { nodeId, before: siblingId }, { nodeId, after: siblingId }, or { nodeId, parentId, index? } where index is the position among the parent's children after the move (omit to append) and parentId "root" means the page the node is on. Moves apply in order and can cross pages; artboards stay directly on a page. Returns where each node landed and the new child order of every parent that changed.`,
    inputSchema: z.object({
      fileId: requiredFileId,
      moves: z
        .array(
          z.union([
            z.object({ nodeId, before: z.string() }).strict(),
            z.object({ nodeId, after: z.string() }).strict(),
            z.object({ nodeId, parentId: z.string(), index: z.number().int().min(0).optional() }).strict()
          ])
        )
        .min(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  duplicate_nodes: {
    description:
      'Deep-copies nodes with new IDs, placed after the original or at the end of parentId. Copied artboards go to an empty spot on the page. Returns each copy\'s ID and descendantIdMap, mapping every original ID to its copy, so you can edit the copy without looking it up.',
    inputSchema: z.object({
      fileId: requiredFileId,
      nodes: z.array(z.object({ id: z.string(), parentId: z.string().optional() })).min(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  delete_nodes: {
    description: 'Deletes nodes and everything inside them, in one undo step. Check a node with get_node_info before deleting it if you are unsure of its parent.',
    inputSchema: z.object({ fileId: requiredFileId, nodeIds: z.array(z.string()).min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  finish_working_on_nodes: {
    description:
      'Call when you are done editing. Removes the "working" indicator from the artboards you edited (it also clears 30 s after your last write). Pass the IDs of the artboards (or of nodes in them) to release only those, or nothing to release all.',
    inputSchema: z.object({ fileId: requiredFileId, nodeIds: z.array(z.string()).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }
}

export type WriteToolName = keyof typeof writeTools
