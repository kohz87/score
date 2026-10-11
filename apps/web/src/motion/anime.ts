// The only place that imports anime.js. Loaded on demand by motion.ts, so it is its own chunk and the main bundle
// never carries it. Named re-exports keep the unused modules (timeline, draggable, scroll, text…) out of the chunk.
export { animate, stagger, svg, utils, waapi } from 'animejs'
