import * as React from 'react'
import { ChevronDown, ExternalLink, Image as ImageIcon } from 'lucide-react'
import type { RequirementRevision, RequirementSourceAnchor } from '../../../shared/requirements'

function EvidenceImage({ url, label, detail }: { url: string; label: string; detail: string }) {
  const [failed, setFailed] = React.useState(false)
  return <figure>
    <figcaption><strong>{label}</strong><span>{detail}</span></figcaption>
    {failed && <p role="alert">图片加载失败，请打开原图核对。</p>}
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看原图：${label}`}>
      {!failed && <img loading="lazy" src={url} alt={label} onError={() => setFailed(true)} />}
      <span>查看原图 <ExternalLink size={13} aria-hidden="true" /></span>
    </a>
  </figure>
}

export function SystemPageEvidence({ anchors, revision, revisionNumber, historical, endpoint, children }: {
  anchors: RequirementSourceAnchor[]; revision?: RequirementRevision; revisionNumber: number; historical: boolean; endpoint: string; children?: React.ReactNode
}) {
  const originals = revision?.existingPages ?? []
  const fallback = revision?.capturePlan?.sourceFallback
  const replicas = fallback?.images ?? []
  const title = (blockId: string) => revision?.prd.blocks.find(block => block.id === blockId)?.title || blockId
  const url = (kind: string, id: string) => `${endpoint}/${kind}/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision!.id)}`
  return <details className="requirements-source-additions" open><summary>代码壳子与页面锚点 · {anchors.length}<ChevronDown size={14} aria-hidden="true" /></summary>
    <section className="requirements-system-images" aria-label="现有系统图像证据">
      <h4><ImageIcon size={15} aria-hidden="true" />现有系统图像证据</h4>
      {revision && <p className="requirements-card-description">修订 {revisionNumber} · {historical ? '历史修订' : '当前修订'} · 真实截图 {originals.length} 张 · 源码复刻 {replicas.length} 张</p>}
      {originals.length > 0 && <div className="requirements-baseline-grid">{originals.map(page => <EvidenceImage key={url('existing-pages', page.image.id)} url={url('existing-pages', page.image.id)} label={`真实截图 · ${title(page.blockId)}${page.viewId ? ` · ${page.viewId}` : ''}`} detail={`${page.path} · ${new Date(page.capturedAt).toLocaleString()}`} />)}</div>}
      {fallback && <><p className="requirements-limitations">真实页面取证未成功（{fallback.code}）。源码复刻只展示变更前的现状，真实运行态未验证。</p>
        {replicas.length ? <div className="requirements-baseline-grid">{replicas.map(item => <EvidenceImage key={url('source-reconstructions', item.image.id)} url={url('source-reconstructions', item.image.id)} label={`源码复刻 · ${title(item.blockId)}`} detail={`非真实截图 · ${new Date(item.createdAt).toLocaleString()}`} />)}</div> : <p className="requirements-card-description">本修订尚无现有系统的源码复刻图。</p>}{children}</>}
      {!fallback && !originals.length && <p className="requirements-card-description">{revision?.capturePlan?.blocks.every(block => block.kind === 'new') ? '本修订仅含新增页面，无现有页面取证。' : '暂无已保存的现有系统截图。'}</p>}
    </section>
    {!!anchors.length && <>{historical && <p className="requirements-card-description">下列代码锚点来自当前项目分析，不是历史修订的截图依据。</p>}<ul className="requirements-anchor-list">{anchors.map((anchor, index) => <li key={`${anchor.sourceId}:${anchor.pageFile}:${index}`}><div className="requirements-anchor-head"><strong>{anchor.domain}</strong><code>{anchor.pageFile}</code>{anchor.route && <code>{anchor.route}</code>}{anchor.layout && <code>{anchor.layout}</code>}</div><p className="requirements-prewrap">{anchor.summary}</p></li>)}</ul></>}
  </details>
}