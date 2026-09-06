import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useEnterNewline } from './use-enter-newline'

function mediaQueries(coarse: boolean, fineHover: boolean) {
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
  queries.set('(pointer: coarse)', { matches: coarse, listeners: new Set() })
  queries.set('(any-pointer: fine) and (any-hover: hover)', { matches: fineHover, listeners: new Set() })
  vi.stubGlobal('matchMedia', (query: string) => {
    const state = queries.get(query)

    if (!state) {throw new Error(`Unexpected media query: ${query}`)}

    return {
      get matches() {
        return state.matches
      },
      addEventListener: (_: string, listener: () => void) => state.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => state.listeners.delete(listener)
    }
  })

  return queries
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('touch Enter policy', () => {
  it.each([
    [true, false, true, 'touch phone, including a fine pointer without hover'],
    [true, true, false, 'touch device with a hover-capable fine pointer'],
    [false, true, false, 'desktop mouse'],
    [false, false, false, 'non-touch fallback']
  ] as const)('%s / %s gives %s for %s', (coarse, fineHover, expected, _description) => {
    mediaQueries(coarse, fineHover)
    const { result } = renderHook(useEnterNewline)
    expect(result.current).toBe(expected)
  })

  it('reacts to capability changes and cleans up both subscriptions', () => {
    const queries = mediaQueries(true, false)
    const { result, unmount } = renderHook(useEnterNewline)
    expect(result.current).toBe(true)
    const fineHover = queries.get('(any-pointer: fine) and (any-hover: hover)')!
    act(() => {
      fineHover.matches = true
      fineHover.listeners.forEach(listener => listener())
    })
    expect(result.current).toBe(false)
    unmount()
    queries.forEach(query => expect(query.listeners.size).toBe(0))
  })

  it('preserves desktop behaviour without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(useEnterNewline).result.current).toBe(false)
  })
})
