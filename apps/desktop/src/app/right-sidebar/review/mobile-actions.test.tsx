import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type * as ReviewModule from '@/store/review'
import { $reviewFiles, $reviewIsRepo, $reviewOpen } from '@/store/review'

import { ReviewShipBar } from './ship-bar'

import { ReviewPane } from './index'

vi.mock('@/store/review', async importOriginal => {
  const actual = await importOriginal<typeof ReviewModule>()

  return {
    ...actual,
    refreshReview: vi.fn(async () => undefined),
    stageReviewFile: vi.fn(async () => undefined),
    unstageReviewFile: vi.fn(async () => undefined)
  }
})

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nProvider configClient={null} initialLocale="en">{node}</I18nProvider>)
}

describe('review mobile actions', () => {
  afterEach(() => {
    cleanup()
    $reviewFiles.set([])
    $reviewIsRepo.set(false)
    $reviewOpen.set(false)
  })

  it('uses finger-sized header and selected-file controls on coarse pointers', () => {
    $reviewOpen.set(true)
    $reviewIsRepo.set(true)
    $reviewFiles.set([
      { added: 1, path: 'src/a.ts', removed: 0, staged: false, status: 'M' }
    ])

    renderWithI18n(<ReviewPane />)

    for (const name of ['Stage all', 'Revert all', 'Refresh tree', 'Stage']) {
      expect(screen.getByRole('button', { name }).className).toContain('pointer-coarse:size-11')
    }
  })

  it('uses a finger-sized PR control on coarse pointers', () => {
    $reviewFiles.set([
      { added: 1, path: 'src/a.ts', removed: 0, staged: false, status: 'M' }
    ])

    renderWithI18n(<ReviewShipBar />)

    expect(screen.getByRole('button', { name: 'Create PR' }).className).toContain('pointer-coarse:size-11')
  })
})
