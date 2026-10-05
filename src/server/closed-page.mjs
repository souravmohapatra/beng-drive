const page = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A little quiet · beng-drive</title><meta name="robots" content="noindex,nofollow">
<style>
:root{color-scheme:light;font-family:ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",sans-serif;color:#193e32;background:#edf5ed}*{box-sizing:border-box}body{margin:0;min-height:100svh;background:radial-gradient(ellipse at 85% 10%,#d9ecdc,transparent 60%),linear-gradient(140deg,#f8fcf7,#e9f4eb)}header,main,footer{width:min(1120px,100% - 48px);margin-inline:auto}header{padding-block:32px}.brand{font-size:25px;font-weight:850;letter-spacing:-.075em;color:inherit;text-decoration:none}.brand span{color:#638b73}main{padding-block:clamp(32px,9vh,112px)}.quiet{position:relative;overflow:hidden;padding:clamp(28px,6vw,80px);border:1px solid #fff;border-radius:36px;background:#ffffffc9;box-shadow:0 24px 80px #28543c09}.quiet:before{content:"";position:absolute;width:280px;height:280px;right:-120px;top:-170px;border-radius:50%;background:#d9ecdc}h1{position:relative;max-width:13ch;margin:0 0 28px;font-size:clamp(42px,6vw,76px);line-height:1.04;letter-spacing:-.055em;font-weight:800;text-wrap:balance}p{max-width:43ch;margin:0;font-size:clamp(17px,2vw,21px);line-height:1.65;color:#526e5e}.note{margin-top:36px;padding-top:24px;border-top:1px solid #d6e5d8;font-size:15px}footer{padding-block:24px 40px;color:#526e5e;font-size:13px}a:focus-visible{outline:3px solid #176f52;outline-offset:6px;border-radius:4px}@media(max-width:480px){header,main,footer{width:calc(100% - 32px)}header{padding-block:24px}.quiet{border-radius:26px}}@media(prefers-reduced-transparency:reduce){.quiet{background:#fff}}
</style></head><body><header><a class="brand" href="/" aria-label="beng-drive home">beng<span>·</span>drive</a></header>
<main><section class="quiet" aria-labelledby="quiet-title"><h1 id="quiet-title">A little quiet,<br>for now.</h1><p>Nothing is happening here right now. This space opens when Beng is expecting files.</p><p class="note">Have something to send? Check with Beng, then come back when the window is open.</p></section></main>
<footer>A private place for the things you share.</footer></body></html>`);
const blocked = Buffer.from(JSON.stringify({ error: { code: 'INTAKE_CLOSED', message: 'Uploads are closed.' } }));
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

export function closedResponse(req, res, pathname) {
  const document = (req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || /^\/c\/[^/]+$/.test(pathname));
  const body = document ? page : blocked;
  res.writeHead(document ? 200 : 403, {
    ...headers,
    'Content-Type': document ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': body.length,
    // Never wait for an upload body or retain its connection while closed.
    Connection: 'close',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
