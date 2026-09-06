import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { HelpHint } from './help-hint'

vi.mock('@/components/ui/kbd', () => ({ KbdCombo: ({ combo }: { combo: string }) => <kbd>{combo}</kbd> }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each([true, false])('only advertises Enter-to-send on desktop (touch=%s)', touch => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? touch : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))

  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <HelpHint />
    </I18nProvider>
  )

  const keys = Array.from(container.querySelectorAll('kbd'), node => node.textContent)
  expect(keys.includes('enter')).toBe(!touch)
  expect(keys.includes('@')).toBe(true)
})
