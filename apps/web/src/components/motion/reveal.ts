import type { CSSProperties } from "react";

type RevealDirection = "up" | "left" | "right" | "scale";

/** Props that make an element fade in when it scrolls into view (see globals.css). */
export function reveal(delayMs = 0, direction: RevealDirection = "up") {
  return {
    "data-reveal": direction,
    style: { "--reveal-delay": `${delayMs}ms` } as CSSProperties,
  };
}

/** Position of a child inside a [data-sequence] container. */
export function seq(index: number) {
  return { style: { "--i": index } as CSSProperties };
}
