/**
 * texwright's SVG renderer: SVG figures as vector Drawing nodes for the
 * native PDF engine. See render.ts for the entry point.
 */

export { svgToDrawing, SVG_LIMITS, type SvgOptions, parseViewBox, parseAspectRatio, viewBoxTransform, type ViewBox, type AspectRatio } from "./render.js";
export { parseXml, type XmlElement, type XmlNode, type XmlResult, DEFAULT_XML_LIMITS } from "./xml.js";
export { type EmbeddedImageRef, isEmbeddedImage } from "./image.js";
export { opsBounds, pathBounds, type Box } from "./bounds.js";
export { parsePath, arcToCubics } from "./path.js";
export { parseTransform, type Matrix } from "./matrix.js";
export { parseColor } from "./color.js";
