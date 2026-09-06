import { useMediaQuery } from '@/hooks/use-media-query'

/** Pointer capability heuristic, not physical-keyboard detection.
 * A fine pointer without hover must not disqualify a touch-primary phone.
 * Keyboard-only accessories remain ambiguous.
 */
export function useEnterNewline(): boolean {
  const touchPrimary = useMediaQuery('(pointer: coarse)')
  const fineWithHover = useMediaQuery('(any-pointer: fine) and (any-hover: hover)')

  return touchPrimary && !fineWithHover
}
