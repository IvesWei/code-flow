import { lazy, Suspense } from 'react'
import type { MouseEvent } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { LoaderCircle } from 'lucide-react'
import { NavigationContext } from './navigation'
import { FeatureMenu } from '../components/FeatureMenu'

const CodingWorkspace = lazy(() => import('../features/coding/CodingWorkspace'))
const RequirementsWorkspace = lazy(() => import('../features/requirements/RequirementsWorkspace'))
const TestingWorkspace = lazy(() => import('../features/testing/TestingWorkspace').then(module => ({ default: module.TestingWorkspace })))

function WorkspaceRoute({ view }: { view?: 'planning' | 'execution' }) {
  const location = useLocation()
  const query = new URLSearchParams(location.search)
  const legacyView = query.get('view')
  const testingView = view || (legacyView === 'planning' || legacyView === 'execution' ? legacyView : undefined)
  return testingView ? <TestingWorkspace key={`${testingView}:${location.search}`} view={testingView} id={query.get(testingView) || ''} /> : <CodingWorkspace />
}

export default function AppRouter() {
  const navigate = useNavigate()
  function followLink(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element).closest('a')
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return
    const url = new URL(anchor.href, location.href)
    if (url.origin !== location.origin || !(/^\/(?:requirements(?:\/[^/]+)?|planning|execution)?$/.test(url.pathname)) || url.hash) return
    event.preventDefault()
    navigate(`${url.pathname}${url.search}`)
  }
  return <NavigationContext value={path => { void navigate(path) }}><div className="application-layout" onClick={followLink}><FeatureMenu /><div className="application-content"><Suspense fallback={<main className="route-loading" role="status"><LoaderCircle className="spin" size={20} />正在加载工作区…</main>}>
    <Routes>
      <Route path="/" element={<WorkspaceRoute />} />
      <Route path="/planning" element={<WorkspaceRoute view="planning" />} />
      <Route path="/execution" element={<WorkspaceRoute view="execution" />} />
      <Route path="/requirements" element={<RequirementsWorkspace />} />
      <Route path="/requirements/:projectId" element={<RequirementsWorkspace />} />
      <Route path="*" element={<main className="route-loading"><h1>页面不存在</h1><a href="/">返回工作台</a></main>} />
    </Routes>
  </Suspense></div></div></NavigationContext>
}