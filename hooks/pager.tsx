import type { ClientModule } from 'claude-code'

// The band's pages, drawn on the surface (it takes the pointer): a column of numbered cells at the region's right (the
// cell left of them is grip), the open page lit. Pressed, or swept with the button held (a desktop sends moves with
// it), the cell under the pointer lights at once and its page goes to the hooks module ({ page }). `rows` comes from
// the hooks module: a desktop reports no region size (surface.rows stays 0).
type Props = { page: number; pages: number; rows: number }
type State = { page: number; base: number } // a page pressed here, and the props' page then

const Pager: ClientModule<Props, State> = (p, s) => {
  const { Box, Text } = s.elements
  // the cells share the rows to the last one: the bottom ones a row taller when they do not divide evenly
  const n = Math.max(1, Math.min(p.pages, p.rows))
  const base = Math.floor(p.rows / n)
  const cells = Array.from({ length: n }, (_, i) => base + (i >= n - (p.rows % n) ? 1 : 0))
  const tops = cells.map((_, i) => cells.slice(0, i).reduce((a, b) => a + b, 0))
  // the page pressed here lights at once, until the hooks module's next props bring it (or another)
  const open = s.state && s.state.base === p.page ? s.state.page : p.page
  s.onPointer(e => {
    if (e.type !== 'down' && !(e.type === 'move' && e.button !== undefined)) return
    const page = Math.max(0, tops.findLastIndex(top => top <= e.y))
    if (page === open) return
    s.setState({ page, base: p.page })
    s.post({ page })
  })
  return (
    <Box flexDirection="row" width={3} height={p.rows}>
      <Box width={1} />
      <Box flexDirection="column" width={2}>
        {cells.map((cell, i) => (
          <Box key={`p${i}`} width={2} height={cell} alignItems="center" justifyContent="center" backgroundColor={i === open ? '#8a8a8a' : i % 2 ? '#333333' : '#3d3d3d'}>
            <Text bold={i === open} color={i === open ? '#141414' : '#bdbdbd'}>
              {String(i + 1)}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
export default Pager
