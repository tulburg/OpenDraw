// On-canvas handles (S-10): the selection frame follows a layer's rotation, and shows the handles
// that apply to the layer: resize, rotate, corner radius, and padding and gap on flex containers.
import type { DesignNode } from '../../shared/document'

/** A layer as drawn on screen: its center, unrotated size (screen px) and rotation in degrees. */
export interface Frame {
  cx: number
  cy: number
  width: number
  height: number
  angle: number
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
export type Corner = 'nw' | 'ne' | 'se' | 'sw'
export const CORNERS: Corner[] = ['nw', 'ne', 'se', 'sw']
export type Side = 'top' | 'right' | 'bottom' | 'left'
export const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

export const CORNER_PROPERTIES: Record<Corner, string> = {
  nw: 'borderTopLeftRadius',
  ne: 'borderTopRightRadius',
  se: 'borderBottomRightRadius',
  sw: 'borderBottomLeftRadius'
}
export const PADDING_PROPERTIES: Record<Side, string> = {
  top: 'paddingTop',
  right: 'paddingRight',
  bottom: 'paddingBottom',
  left: 'paddingLeft'
}
export const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** Handles other than resize are hidden when the layer is smaller than this on screen. */
const MIN_HANDLE_SIZE = 24
/** Corner radius dots sit at least this far (screen px) inside their corner. */
const RADIUS_DOT_INSET = 10

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What a selected layer offers beyond resizing, measured in layer px (unscaled). */
export interface HandleInfo {
  type: DesignNode['type']
  radii: Record<Corner, number>
  border: { left: number; top: number; right: number; bottom: number }
  flex: { axis: 'x' | 'y'; padding: Record<Side, number>; gap: number; gaps: Rect[] } | null
}

const parsePx = (value: string) => Number.parseFloat(value) || 0

/** An element's own CSS rotation in degrees (from `rotate`), 0 when none. */
export function angleOf(el: HTMLElement): number {
  const value = getComputedStyle(el).rotate
  if (!value || value === 'none') return 0
  const last = value.trim().split(/\s+/).pop() ?? ''
  const number = Number.parseFloat(last)
  if (Number.isNaN(number)) return 0
  if (last.endsWith('turn')) return number * 360
  if (last.endsWith('grad')) return number * 0.9
  if (last.endsWith('rad')) return (number * 180) / Math.PI
  return number
}

/** The frame of an element relative to `outer` (the canvas), at `zoom`. */
export function frameOf(el: HTMLElement, outer: DOMRect, zoom: number): Frame {
  const r = el.getBoundingClientRect()
  const angle = angleOf(el)
  const cx = r.left - outer.left + r.width / 2
  const cy = r.top - outer.top + r.height / 2
  if (angle % 360 === 0) return { cx, cy, width: r.width, height: r.height, angle: 0 }
  return { cx, cy, width: el.offsetWidth * zoom, height: el.offsetHeight * zoom, angle }
}

/** Rotates a vector by `degrees` (clockwise on screen, as CSS rotate does). */
export function rotateVector(v: { x: number; y: number }, degrees: number) {
  const a = (degrees * Math.PI) / 180
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) }
}

/** Half the size of a frame's axis-aligned bounds, for placing labels under rotated layers. */
export function halfExtent(frame: Frame) {
  const a = (frame.angle * Math.PI) / 180
  const c = Math.abs(Math.cos(a))
  const s = Math.abs(Math.sin(a))
  return { x: (frame.width / 2) * c + (frame.height / 2) * s, y: (frame.width / 2) * s + (frame.height / 2) * c }
}

/** A child's border box within its container's border box, in layer px. */
function childRect(child: HTMLElement, container: HTMLElement): Rect {
  const x = child.offsetParent === container ? child.offsetLeft + container.clientLeft : child.offsetLeft - container.offsetLeft
  const y = child.offsetParent === container ? child.offsetTop + container.clientTop : child.offsetTop - container.offsetTop
  return { x, y, width: child.offsetWidth, height: child.offsetHeight }
}

export function handleInfoOf(el: HTMLElement, node: DesignNode): HandleInfo {
  const style = getComputedStyle(el)
  const radii = {
    nw: parsePx(style.borderTopLeftRadius),
    ne: parsePx(style.borderTopRightRadius),
    se: parsePx(style.borderBottomRightRadius),
    sw: parsePx(style.borderBottomLeftRadius)
  }
  const border = {
    left: parsePx(style.borderLeftWidth),
    top: parsePx(style.borderTopWidth),
    right: parsePx(style.borderRightWidth),
    bottom: parsePx(style.borderBottomWidth)
  }
  let flex: HandleInfo['flex'] = null
  if ((node.type === 'frame' || node.type === 'artboard') && style.display.includes('flex')) {
    const axis = style.flexDirection.startsWith('row') ? 'x' : 'y'
    const padding = {
      top: parsePx(style.paddingTop),
      right: parsePx(style.paddingRight),
      bottom: parsePx(style.paddingBottom),
      left: parsePx(style.paddingLeft)
    }
    const gap = parsePx(axis === 'x' ? style.columnGap : style.rowGap)
    const children = [...el.children]
      .filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.nodeId && getComputedStyle(c).position !== 'absolute')
      .map((c) => childRect(c, el))
    const gaps: Rect[] = []
    const crossStart = axis === 'x' ? border.top + padding.top : border.left + padding.left
    const crossSize =
      axis === 'x'
        ? el.offsetHeight - border.top - border.bottom - padding.top - padding.bottom
        : el.offsetWidth - border.left - border.right - padding.left - padding.right
    for (let i = 0; i + 1 < children.length; i++) {
      const a = children[i]
      const b = children[i + 1]
      if (axis === 'x') gaps.push({ x: a.x + a.width, y: crossStart, width: Math.max(0, b.x - a.x - a.width), height: crossSize })
      else gaps.push({ x: crossStart, y: a.y + a.height, width: crossSize, height: Math.max(0, b.y - a.y - a.height) })
    }
    flex = { axis, padding, gap, gaps }
  }
  return { type: node.type, radii, border, flex }
}

const HAS_RADIUS = new Set<DesignNode['type']>(['frame', 'image', 'svg', 'artboard'])

/** Which handle sets a layer shows (S-10 Req 1). */
export function handleSets(info: HandleInfo, frame: Frame) {
  const roomy = frame.width >= MIN_HANDLE_SIZE && frame.height >= MIN_HANDLE_SIZE
  return {
    resize: true,
    rotate: roomy && info.type !== 'artboard',
    radius: roomy && HAS_RADIUS.has(info.type),
    padding: roomy && !!info.flex,
    gap: roomy && !!info.flex && info.flex.gaps.length > 0
  }
}

const round = (n: number) => Math.round(n * 10) / 10

/**
 * The rotated selection frame with its handles. Positions inside are in screen px along the
 * layer's own axes; the frame's rotation turns them with the layer.
 */
export function SelectionFrame({
  id,
  frame,
  info,
  zoom,
  showHandles,
  activeShade
}: {
  id: string
  frame: Frame
  info: HandleInfo | null
  zoom: number
  showHandles: boolean
  activeShade: 'padding' | 'gap' | null
}) {
  const { width, height } = frame
  const sets = info && showHandles ? handleSets(info, frame) : null
  return (
    <div
      className="selection-outline"
      data-outline-id={id}
      data-angle={round(frame.angle)}
      data-shade={activeShade ?? undefined}
      style={{
        left: frame.cx - width / 2,
        top: frame.cy - height / 2,
        width,
        height,
        transform: frame.angle ? `rotate(${frame.angle}deg)` : undefined
      }}
    >
      {sets && info && (
        <>
          {sets.padding && info.flex && <PaddingShades info={info} zoom={zoom} width={width} height={height} />}
          {sets.gap &&
            info.flex?.gaps.map((g, i) => (
              <div
                key={i}
                className="gap-shade"
                style={{ left: g.x * zoom, top: g.y * zoom, width: g.width * zoom, height: g.height * zoom }}
              />
            ))}
          {sets.rotate &&
            CORNERS.map((corner) => <div key={corner} className="rotate-zone" data-rotate={corner} title={`Rotate ${round(frame.angle)}°`} />)}
          {HANDLES.map((handle) => {
            const hx = handle.includes('w') ? 0 : handle.includes('e') ? width : width / 2
            const hy = handle.includes('n') ? 0 : handle.includes('s') ? height : height / 2
            return <div key={handle} className="resize-handle" data-handle={handle} style={{ left: hx, top: hy }} />
          })}
          {sets.radius &&
            CORNERS.map((corner) => {
              const r = info.radii[corner]
              const inset = Math.min(Math.max(r * zoom * 0.3 + RADIUS_DOT_INSET, RADIUS_DOT_INSET), width / 2, height / 2)
              const x = corner.includes('w') ? inset : width - inset
              const y = corner.includes('n') ? inset : height - inset
              return (
                <div key={corner} className="radius-dot" data-radius={corner} title={`Radius ${round(r)}`} style={{ left: x, top: y }} />
              )
            })}
          {sets.padding &&
            info.flex &&
            SIDES.map((side) => {
              const p = info.flex!.padding
              const b = info.border
              const left = side === 'left' ? (b.left + p.left / 2) * zoom : side === 'right' ? width - (b.right + p.right / 2) * zoom : width / 2
              const top = side === 'top' ? (b.top + p.top / 2) * zoom : side === 'bottom' ? height - (b.bottom + p.bottom / 2) * zoom : height / 2
              return (
                <div
                  key={side}
                  className="padding-handle"
                  data-padding={side}
                  data-vertical={side === 'left' || side === 'right' || undefined}
                  title={`Padding ${side} ${round(p[side])}`}
                  style={{ left, top }}
                />
              )
            })}
          {sets.gap &&
            info.flex?.gaps.map((g, i) => (
              <div
                key={i}
                className="gap-handle"
                data-gap={i}
                data-vertical={info.flex!.axis === 'x' || undefined}
                title={`Gap ${round(info.flex!.gap)}`}
                style={{ left: (g.x + g.width / 2) * zoom, top: (g.y + g.height / 2) * zoom }}
              />
            ))}
        </>
      )}
    </div>
  )
}

function PaddingShades({ info, zoom, width, height }: { info: HandleInfo; zoom: number; width: number; height: number }) {
  const p = info.flex!.padding
  const b = info.border
  const inner = { left: b.left * zoom, top: b.top * zoom, right: width - b.right * zoom, bottom: height - b.bottom * zoom }
  const rects = [
    { left: inner.left, top: inner.top, width: inner.right - inner.left, height: p.top * zoom },
    { left: inner.left, top: inner.bottom - p.bottom * zoom, width: inner.right - inner.left, height: p.bottom * zoom },
    { left: inner.left, top: inner.top + p.top * zoom, width: p.left * zoom, height: inner.bottom - inner.top - (p.top + p.bottom) * zoom },
    { left: inner.right - p.right * zoom, top: inner.top + p.top * zoom, width: p.right * zoom, height: inner.bottom - inner.top - (p.top + p.bottom) * zoom }
  ]
  return (
    <>
      {rects.map((r, i) => (
        <div key={i} className="padding-shade" style={r} />
      ))}
    </>
  )
}
