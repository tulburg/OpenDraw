// get_guide topics (S-17 Req 2): one markdown file per topic in guides/, bundled as text.
import mobileStatusBar from '../guides/mobile-status-bar.md' with { type: 'text' }
import instructions from '../guides/paper-mcp-instructions.md' with { type: 'text' }

export const GUIDES: Record<string, { summary: string; text: string }> = {
  'paper-mcp-instructions': { summary: 'How to work with OpenDraw\'s tools, start to finish', text: instructions },
  'mobile-status-bar': { summary: 'Paste-ready status bar markup for mobile artboards', text: mobileStatusBar }
}

export function guide(topic: string): { text: string } | { error: string } {
  const found = GUIDES[topic.trim()]
  if (found) return { text: found.text }
  const list = Object.entries(GUIDES).map(([name, g]) => `"${name}" (${g.summary})`).join(', ')
  return { error: `No guide on "${topic}". Topics: ${list}.` }
}
