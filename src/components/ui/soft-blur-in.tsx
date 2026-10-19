// A headline that arrives letter by letter, each one rising out of a soft blur: an Apple-keynote title entrance.
// Adapted from educalvolpz's Soft Blur In on 21st.dev. Changed: letters are grouped by word so a line only breaks
// between words; the whole text stays readable to screen readers (and to anything reading the heading's text);
// nothing moves with reduced motion. Key it by its text to play again when the text changes.
import { motion, useReducedMotion } from "motion/react";

const EASE = [0.22, 1, 0.36, 1] as const;

export function SoftBlurIn({ children, stagger = 22, delay = 0 }: { children: string; stagger?: number; delay?: number }) {
  const reduce = useReducedMotion();
  let i = 0;
  return (
    <>
      {children.split(" ").map((word, w, words) => (
        <span key={w}>
          <span className="inline-block whitespace-nowrap">
            {Array.from(word).map((ch) => {
              const n = i++;
              return (
                <motion.span
                  key={n}
                  className="inline-block"
                  initial={reduce ? false : { opacity: 0, y: "0.18em", filter: "blur(12px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={reduce ? { duration: 0 } : { duration: 0.9, delay: delay / 1000 + (n * stagger) / 1000, ease: EASE }}
                >
                  {ch}
                </motion.span>
              );
            })}
          </span>
          {w < words.length - 1 && " "}
        </span>
      ))}
    </>
  );
}
