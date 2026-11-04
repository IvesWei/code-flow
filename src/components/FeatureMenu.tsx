import { Activity, ClipboardList, Code2, FileText, Play, Workflow } from 'lucide-react'
import { useLocation } from 'react-router-dom'

const features = [
  { id: 'coding', label: '编码工作流', href: '/', icon: Workflow },
  { id: 'requirements', label: '需求与设计', href: '/requirements', icon: FileText },
  { id: 'planning', label: '用例规划', href: '/planning', icon: ClipboardList },
  { id: 'execution', label: '用例执行', href: '/execution', icon: Play },
  { id: 'automation', label: '自动化任务', href: '/?automation=overview', icon: Activity },
]

export function FeatureMenu() {
  const location = useLocation()
  const query = new URLSearchParams(location.search)
  const current = /^\/requirements(?:\/[^/]+)?$/.test(location.pathname) ? 'requirements' : location.pathname === '/planning' ? 'planning' : location.pathname === '/execution' ? 'execution'
    : location.pathname === '/' ? query.get('view') || (query.has('automation') ? 'automation' : 'coding') : undefined
  return <aside className="feature-rail">
    <a className="feature-brand" href="/" aria-label="Code/Flow 工作台" title="Code/Flow 工作台"><Code2 size={24} /><span>CODE/FLOW</span></a>
    <nav className="feature-menu" aria-label="功能菜单">
      {features.map(({ id, label, href, icon: Icon }) => <a key={id} href={href} aria-label={label} aria-current={current === id ? 'page' : undefined}>
        <Icon size={20} /><span className="feature-label">{label}</span><span className="feature-tooltip" role="tooltip">{label}</span>
      </a>)}
    </nav>
  </aside>
}