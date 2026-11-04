export const prototypePolicy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'"
export const prototypeArtboardWidth = 1600

export const staticPrototypeGuards = String.raw`
  const controlSelector='input,textarea,select,button,summary,a';
  document.addEventListener('pointerdown',event=>{if(event.target.closest('select,input'))event.preventDefault();},true);
  for(const type of ['beforeinput','paste','cut','drop','submit','reset','dblclick','contextmenu'])document.addEventListener(type,event=>event.preventDefault(),true);
  document.addEventListener('keydown',event=>{if(event.target.closest(controlSelector)&&!['Tab','Escape'].includes(event.key))event.preventDefault();},true);
  document.addEventListener('wheel',event=>{if(event.target.closest('input,select'))event.preventDefault();},{capture:true,passive:false});
`

export function needsScreenshot(html: string): boolean {
  return /<\s*script\b|\bon[a-z]+\s*=|javascript\s*:|<\s*(?:iframe|object|embed|math)\b/i.test(html)
}

export function buildPrototypeDocument(html: string, nonce: string, screenId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(nonce)) throw new Error('Invalid preview nonce')
  const parsed = document.createElement('template')
  parsed.innerHTML = html
  const allowedTags = new Set('html head body style div span main section article aside header footer nav h1 h2 h3 h4 h5 h6 p br hr strong em b i u small code pre ul ol li dl dt dd table caption thead tbody tfoot tr th td form button input textarea label select option img figure figcaption a details summary fieldset legend progress svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop clippath mask title desc'.split(' '))
  const allowedAttributes = /^(?:id|class|style|title|role|aria-[a-z-]+|data-requirement-id|data-acceptance-id|data-prototype-node|hidden|tabindex|disabled|value|type|checked|selected|colspan|rowspan|alt|width|height|src|name|placeholder|min|max|step|open|xmlns|viewbox|preserveaspectratio|d|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|dx|dy|points|transform|fill|fill-rule|fill-opacity|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-dasharray|stroke-dashoffset|stroke-opacity|opacity|offset|stop-color|stop-opacity|gradientunits|gradienttransform|clip-path|clip-rule|mask|text-anchor|dominant-baseline|font-size|font-family|font-weight)$/i
  for (const element of parsed.content.querySelectorAll('*')) {
    if (!allowedTags.has(element.tagName.toLowerCase())) { element.remove(); continue }
    if (element.tagName === 'STYLE') element.textContent = (element.textContent || '').replaceAll('<', '').replaceAll('>', '')
    for (const attribute of Array.from(element.attributes)) {
      if (!allowedAttributes.test(attribute.name) || attribute.name === 'src') {
        if (attribute.name === 'src' && element.tagName === 'IMG' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(attribute.value)) continue
        element.removeAttribute(attribute.name)
      }
    }
    if (element.matches('input,textarea')) element.setAttribute('readonly', '')
  }
  const context = JSON.stringify({ nonce, screenId }).replaceAll('<', '\\u003c')
  const fitting = `(()=>{let pending=false,viewportHeight=innerHeight;function fit(){pending=false;const body=document.body;if(!body)return;const height=Math.ceil(Array.from(body.querySelectorAll('*')).reduce((bottom,element)=>Math.max(bottom,element.getBoundingClientRect().bottom+scrollY),Math.max(body.getBoundingClientRect().bottom+scrollY+parseFloat(getComputedStyle(body).marginBottom),1)));parent.postMessage({type:'requirements:resize',...${context},height},'*')}function schedule(){if(!pending){pending=true;requestAnimationFrame(fit)}}addEventListener('DOMContentLoaded',()=>{new ResizeObserver(()=>{if(innerHeight!==viewportHeight){viewportHeight=innerHeight;return}schedule()}).observe(document.body);schedule()});addEventListener('load',schedule,true)})();`
  const bootstrap = `(()=>{${staticPrototypeGuards}document.addEventListener('click',event=>event.preventDefault(),true)})();`
  const policy = prototypePolicy.replace("script-src 'none'", `script-src 'nonce-${nonce}'`)
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><script nonce="${nonce}">${bootstrap}${fitting}</script></head><body>${parsed.innerHTML}<style data-static-prototype>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style></body></html>`
}