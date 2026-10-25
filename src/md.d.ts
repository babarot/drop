// Declaration for importing .md as a string via wrangler's [[rules]] type = "Text"
declare module '*.md' {
  const text: string
  export default text
}
