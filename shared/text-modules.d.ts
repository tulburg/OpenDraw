// Markdown files imported as text (bundled by Bun).
declare module '*.md' {
  const text: string
  export default text
}
