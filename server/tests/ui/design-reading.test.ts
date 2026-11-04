import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RequirementRevision } from '../../../shared/requirements.js'
import { DesignReview } from '../../../src/features/requirements/DesignReview.js'

const revision: RequirementRevision = {
  id: 'revision1',
  createdAt: '2026-11-01T00:00:00Z',
  prd: { title: 'Orders', summary: '', blocks: [], requirements: [] },
  screens: [
    { id: 'screen1', title: 'Save', state: 'Default', requirementIds: ['REQ1'], acceptanceIds: [], html: '<p>Save</p>' },
    { id: 'screen2', title: 'Search', state: 'Default', requirementIds: ['REQ2'], acceptanceIds: [], html: '<p>Search</p>' },
  ],
}

test('reading association warning checks all design pages, not only the manually displayed page', () => {
  const render = (selectedId: string) => renderToStaticMarkup(React.createElement(DesignReview, { revision, projectId: 'project1', selectedId }))
  assert.doesNotMatch(render('REQ2'), /role="status"/)
  assert.doesNotMatch(render(''), /role="status"/)
  assert.match(render('unmapped'), /role="status"/)
})