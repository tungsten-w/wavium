const http = require('http'), fs = require('fs'), path = require('path')
const APP = path.join(__dirname, '..', '..')
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }
const month = (m) => {
  const out = {}
  for (let d = 1; d <= 31; d++) {
    const date = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1, d))
    if (date.getUTCMonth() !== +m.slice(5) - 1) break
    if (d <= 15) out[`${m}-${String(d).padStart(2, '0')}`] = { total: 10, done: Math.round(((d * 37) % 11)) }
  }
  return out
}
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let m
  if ((m = url.pathname.match(/api\/summary\/(\d{4}-\d{2})$/))) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(month(m[1]))) }
  if ((m = url.pathname.match(/api\/stats\//))) {
    if (url.searchParams.get('empty')) { res.setHeader('content-type', 'application/json'); return res.end('{}') }
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify(process.env.EMPTY ? {} : Object.assign({}, month('2026-10'), month('2026-08'))))
  }
  const file = url.pathname === '/harness.html' ? __dirname + '/harness.html' : path.join(APP, url.pathname)
  if (!file.startsWith(APP) && !file.startsWith(__dirname)) { res.statusCode = 403; return res.end() }
  fs.readFile(file, (err, data) => { if (err) { res.statusCode = 404; return res.end('nf') } res.setHeader('content-type', types[path.extname(file)] || 'text/plain'); res.end(data) })
}).listen(8765, '127.0.0.1', () => console.log('up'))
