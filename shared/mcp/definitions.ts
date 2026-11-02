// Tool names and arguments follow Paper's MCP server so prompts written for Paper work here.
// Descriptions are OpenDraw's own.
import { z } from 'zod'

import { PAGE_ICONS, TOKEN_TYPES } from '../document'

const fileId = z.string().describe('ID of the file to work on. Omit for the file open in OpenDraw.')
const requiredFileId = z.string().describe('ID of the file to work on, from get_basic_info.')
const pageId = z.string().describe('ID of the page to work on. Omit for the page the user is viewing.')
const nodeId = z.string().describe('ID of the node.')
const tokenType = z.enum(TOKEN_TYPES).describe('Token type.')
const tokenName = z.string().describe('CSS custom property name, like --color-primary.')
const tokenValue = z
  .union([z.string(), z.number()])
  .describe('Colors: a CSS color. spacing, radius, fontSize, container, breakpoint: a px string like "8px". fontWeight: a number. opacity: 0-1 or a percent. var(--other) aliases another token.')
const pageIcon = z
  .enum(PAGE_ICONS)
  .describe('Icon shown in the page list in place of the default. arrow marks a key page; design is a pencil over a ruler; paper (crumpled) marks old drafts.')

export const SERVER_INSTRUCTIONS = `OpenDraw is a local design app. Its documents are CSS-native: every node is an HTML element with inline CSS, and that CSS is what gets saved.

- A file has pages; a page holds artboards (top-level frames positioned on the canvas with left/top); artboards hold frames, text, images and SVG.
- Layout is flexbox with padding and gap. Absolute positioning is for decoration. Margins, grid, inline display and tables are not supported.
- Read get_guide({ topic: "opendraw-mcp-instructions" }) once per session before other tools.
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
  get_tokens: {
    description:
      'Lists the file\'s design tokens: typed CSS custom properties that styles use with var(--name). format "json" (default) returns name, type, value and description; "css" a :root block; "tailwind" a Tailwind v4 @theme block. namePattern is a case-insensitive glob over the full name ("--color-*").',
    inputSchema: z.object({
      fileId: requiredFileId,
      format: z.enum(['json', 'css', 'tailwind']).optional(),
      namePattern: z.string().optional(),
      types: z.array(tokenType).optional()
    })
  },
  list_comment_threads: {
    description:
      'List visible comment threads in the open file as compact summaries. A comment thread is a conversation pinned to a node (or a canvas point): a first message plus replies, each with its own author, and an "open" or "resolved" status. Lists only open threads by default. Use this first to find relevant discussion, then call get_comment_thread for full replies. When you fully address a thread\'s feedback, mark it done with set_comment_thread_status. User ID filters accept "current-user" for the local user. Deleted threads and messages are never returned.',
    inputSchema: z.object({
      fileId: requiredFileId,
      pageId: z.string().optional().describe('Only threads on this page. Omit to include all pages.'),
      currentPageOnly: z.boolean().optional().describe('Only threads on the page the user is viewing. Ignored when pageId is given.'),
      nodeId: z.string().optional().describe('Only threads pinned to this node.'),
      status: z.enum(['open', 'resolved', 'all']).optional().describe('Defaults to "open": unresolved threads, the ones still needing action.'),
      participantUserId: z.string().optional().describe('Only threads where this user wrote a visible message. "current-user" for the local user; otherwise an authorUserId from earlier results.'),
      threadAuthorUserId: z.string().optional().describe('Only threads started by this user. "current-user" for the local user.'),
      search: z.string().optional().describe('Case-insensitive search over author names and message text.'),
      searchScope: z.enum(['first-message', 'all-messages']).optional().describe('Defaults to "all-messages".'),
      sortField: z.enum(['page', 'createdAt', 'updatedAt']).optional().describe('Defaults to "page", matching the Comments panel.'),
      sortDirection: z.enum(['asc', 'desc']).optional().describe('Defaults to "asc".'),
      limit: z.number().int().min(1).max(200).optional().describe('Defaults to 50.'),
      offset: z.number().int().min(0).optional().describe('Defaults to 0.'),
      previewLength: z.number().int().min(20).max(1000).optional().describe('Maximum characters of each first-message preview. Defaults to 240.')
    })
  },
  get_comment_thread: {
    description:
      'Full details for one visible comment thread: status, every message with author and time, reactions, page context and pinned node context. Works for any status. Deleted threads and messages are never returned.',
    inputSchema: z.object({ fileId: requiredFileId, commentThreadId: z.string().describe('The ID of the comment thread to read.') })
  },
  list_comment_thread_authors: {
    description:
      'Lists every user who started a comment thread or wrote a visible message, with user ID, display name, thread and message counts and last activity time. Use it to turn a name into a userId for list_comment_threads filters.',
    inputSchema: z.object({ fileId: requiredFileId, pageId: z.string().optional().describe('Only count activity on this page.') })
  },
  get_guide: {
    description:
      'Reads a guide. Call with topic "opendraw-mcp-instructions" before using other tools for best results. Other topics: "mobile-status-bar" (paste-ready status bar markup for mobile artboards).',
    inputSchema: z.object({ topic: z.string().describe('The guide topic: "opendraw-mcp-instructions" or "mobile-status-bar".') })
  },
  get_font_family_info: {
    description:
      'Whether font families are available, and every weight and style in each. Looks up fonts installed on this machine and Google Fonts; a Google Fonts family loads into OpenDraw the first time a style uses it. Call before your first typographic styling.',
    inputSchema: z.object({ fileId: requiredFileId, familyNames: z.array(z.string()).min(1).describe('Names of the font families to look up.') })
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
- <x-opendraw-clone node-id="..."></x-opendraw-clone> inserts a copy of an existing node with new IDs; style and layer-name on the tag override the copy's root style and name. A missing node ID fails the whole call.
- <img src> and background-image take http, https, data: image and opendraw-asset:// URLs. opendraw-asset:///Users/name/logo.png (an absolute path) copies that image into the design file, so it keeps showing if the original moves; opendraw-asset://images/logo.png (relative) uses the file in the workspace folder. A path that does not exist or is not an image fails the call. <svg> is kept as vector markup. <pre> or white-space: pre keeps whitespace.
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
  create_page: {
    description:
      'Adds a page after the one the user is viewing and returns its pageId, without switching their page. Pass the pageId to other tools to work on it.',
    inputSchema: z.object({
      fileId: requiredFileId,
      name: z.string().optional().describe('Name for the page. Defaults to "Page N".'),
      icon: pageIcon.optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  update_pages: {
    description: 'Renames pages and changes their icons, in one undo step. Does not switch the page the user is viewing.',
    inputSchema: z.object({
      fileId: requiredFileId,
      updates: z
        .array(
          z.object({
            pageId: z.string().describe('ID of the page, from get_basic_info.'),
            name: z.string().optional().describe('New name. Omit to keep it.'),
            icon: pageIcon.nullable().optional().describe('New icon. Omit to keep it; null restores the default.')
          })
        )
        .min(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  arrange_pages: {
    description:
      'Reorders the page list and adds or removes dividers. Pass the complete new order: every page and divider ID from get_basic_info once (except dividers in removeDividerIds), with {"type": "divider"} where a new divider goes. A missing, unknown or repeated ID rejects the call with no change. Pages are never deleted. Returns the new list, with the IDs of new dividers.',
    inputSchema: z.object({
      fileId: requiredFileId,
      order: z.array(z.union([z.string(), z.object({ type: z.literal('divider') })])),
      removeDividerIds: z.array(z.string()).optional().describe('IDs of dividers to remove.')
    }),
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  create_tokens: {
    description:
      'Creates design tokens, in order. Use var(--other) as a value to alias another token. Returns {name, result: "created"} or {name, result: "error", message} per entry; a bad entry does not stop the rest. Define neutral colors first, then primary, secondary and accent; other types smallest first. Reuse tokens before making new ones.',
    inputSchema: z.object({
      fileId: requiredFileId,
      tokens: z
        .array(z.object({ type: tokenType, name: tokenName, value: tokenValue, description: z.string().optional().describe('What the token is for. Max 1024 characters.') }))
        .min(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  set_comment_thread_status: {
    description:
      'Sets one comment thread\'s status to "resolved" or "open". Resolve a thread once its feedback is fully addressed in the design; reopen it if more work is needed. One undo step for the user.',
    inputSchema: z.object({
      fileId: requiredFileId,
      commentThreadId: z.string().describe('The ID of the comment thread to update.'),
      status: z.enum(['open', 'resolved'])
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  set_tokens: {
    description:
      'Renames (newName), updates (value, description) or deletes (delete: true) tokens by name, applied in order in one undo step. A rename rewrites var() references in styles and other tokens. Deleting a token that is still used is allowed; the result lists its users. Errors are per entry.',
    inputSchema: z.object({
      fileId: requiredFileId,
      tokens: z
        .array(
          z.object({
            name: tokenName,
            newName: z.string().optional(),
            value: tokenValue.optional(),
            description: z.string().optional().describe('Pass "" to clear.'),
            delete: z.boolean().optional()
          })
        )
        .min(1)
    }),
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

const resourceIds = z.array(z.string()).min(1).describe('IDs of the files and folders, from list_resources.')
const folderId = z.string().describe('ID of a folder, from list_resources.')

/** Files and folders in the workspace (S-13). These run in the main process, not against one document. */
export const resourceTools = {
  list_resources: {
    description:
      'Lists files and folders in the workspace. Open files come first (`open` for a tab, `active` for the tab in front), then the most recently updated files and folders. Each item has type, id, name, parentId (omitted at the top level) and timestamps. `truncated` means the limit cut the list.',
    inputSchema: z.object({
      parentId: folderId.optional(),
      includeArchived: z.boolean().optional().describe('Also list archived items, marked archived.'),
      limit: z.number().min(1).max(200).optional().describe('Most items to return. Defaults to 50.')
    }),
    annotations: { readOnlyHint: true }
  },
  create_file: {
    description: 'Creates a file and returns its id, name and parentId. Call open_file with the ID to work in it.',
    inputSchema: z.object({
      name: z.string().optional().describe('Name for the file. Defaults to "Untitled".'),
      parentId: folderId.optional(),
      cloneFileId: z.string().optional().describe('ID of a file to copy. The copy gets new IDs.')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  create_folder: {
    description: 'Creates a folder and returns its id, name and parentId. The name is trimmed and capped at 500 characters.',
    inputSchema: z.object({
      name: z.string().optional().describe('Name for the folder. Defaults to "Untitled project".'),
      parentId: folderId.optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  move_resources: {
    description:
      'Moves files and folders into a folder; a folder moves with its contents. Every ID is checked first, and if any cannot move, nothing moves. Items already in the folder are listed separately.',
    inputSchema: z.object({ resourceIds, parentId: folderId }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  rename_resource: {
    description: 'Renames a file or folder. The name is trimmed and capped at 500 characters; an empty name changes nothing. Returns the stored name and the type.',
    inputSchema: z.object({ resourceId: z.string().describe('ID of the file or folder.'), name: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  archive_resources: {
    description:
      'Archives files and folders; a folder takes its contents with it. Archived items only show in list_resources with includeArchived. All or nothing.',
    inputSchema: z.object({ resourceIds }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  unarchive_resources: {
    description:
      'Restores archived files and folders, with their contents. An item whose folder stays archived moves to the top level. All or nothing.',
    inputSchema: z.object({ resourceIds }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  open_file: {
    description:
      'Opens a file as a tab behind the one in front, by bare ID, /file/<id> path or URL. pageId applies only when the file is not already open. Returns a get_basic_info response.',
    inputSchema: z.object({ fileId: z.string(), pageId: pageId.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }
}

/** Export tools (S-15). They render in the main process and write files. */
export const exportTools = {
  export: {
    description:
      'Exports layers as files, with each layer\'s own export settings (a 1x PNG for a layer without any), and returns each file\'s path. Pass node IDs, or "nodes-with-exports-only" for every layer on the page that has export settings. Do not change export settings unless the user asks. Only type "image" is supported.',
    inputSchema: z.object({
      fileId: requiredFileId,
      nodes: z.union([z.array(z.string()).min(1), z.literal('nodes-with-exports-only')]),
      pageId: pageId.optional(),
      type: z.enum(['image', 'video']).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  export_combined_pdf: {
    description:
      'Exports layers into one PDF, one page per layer, each page the layer\'s size. Pages are ordered top to bottom, then left to right on the canvas. Returns the file path.',
    inputSchema: z.object({ fileId: requiredFileId, nodeIds: z.array(z.string()).min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  get_fill_image: {
    description:
      'Returns the picture of an image layer (or a layer with a background image) as base64 JPEG, scaled to at most 1568 px on the long side, with the source URL. SVG layers have no fill image; read them with get_jsx.',
    inputSchema: z.object({ fileId: requiredFileId, nodeId }),
    annotations: { readOnlyHint: true }
  }
}
