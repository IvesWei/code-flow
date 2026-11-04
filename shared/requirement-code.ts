export const codeSnapshotLimits = Object.freeze({ files: 200, fileBytes: 131072, totalBytes: 1048576 })

const extensions = new Set('ts tsx js jsx mts cts mjs cjs vue svelte astro html htm css scss sass less md mdx markdown json jsonc yaml yml xml sql py pyi java kt kts scala groovy go rs c h cc cpp cxx hpp cs fs fsx vb php rb erb rake swift m mm dart r lua sh bash zsh ps1 psm1 bat cmd ex exs erl hrl clj cljs cljc edn elixir eex heex hbs handlebars mustache twig jinja jinja2 j2 njk pug jade cshtml razor jsp jspx asp aspx graphql gql proto toml ini cfg conf properties gradle csproj fsproj vbproj sln props targets xaml resx cmake'.split(' '))
const manifests = new Set(['dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'cmakelists.txt', 'gemfile', 'rakefile', 'procfile', 'requirements.txt', 'pipfile', 'go.mod', 'go.sum'])
const excludedDirectory = /^(?:node_modules|bower_components|vendor|dist(?:-server)?|build|out|target|coverage|bin|obj|packages|venv|env|__pycache__|__pypackages__|site-packages|pods|deriveddata|storybook-static|htmlcov)$/i
const sensitive = /(?:^|[._-])(?:credentials?|secrets?|passwords?|tokens?|certificates?|certs?|certkeys|private[._-]?keys?|keystore|truststore|production|prod)(?:[._-]|$)/i

export function codeFileAllowed(path: string): boolean {
  if (typeof path !== 'string' || !path || path.length > 240 || /[\x00-\x20\x7f-\x9f\\:%<>"|?*]/.test(path)) return false
  const parts = path.split('/')
  if (parts.some(part => !part || part.startsWith('.') || part.endsWith('.') || excludedDirectory.test(part) || sensitive.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false
  const name = parts[parts.length - 1].toLowerCase()
  if (/^(?:appsettings(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|authorized_keys$|known_hosts$)/.test(name) || /(?:^|[._-])lock(?:[._-]|$)|\.(?:min\.(?:js|css)|map)$/.test(name) || ['go.sum', 'gemfile.lock', 'npm-shrinkwrap.json', 'bun.lockb'].includes(name)) return false
  return manifests.has(name) || extensions.has(name.split('.').at(-1)!)
}