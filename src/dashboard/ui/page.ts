function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The dashboard page. `tokenQuery` is `''` or `'?token=<encoded token>'`; it is appended to the
 * relative asset and SSE URLs so each request is authorized the way `/events` already is.
 */
export function renderPage(tokenQuery: string): string {
  const q = escapeAttribute(tokenQuery);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="argus-events" content="events${q}">
<title>Argus</title>
<link rel="stylesheet" href="app.css${q}">
<script src="app.js${q}" defer></script>
</head>
<body>
<header>
<h1>Argus</h1>
<p id="status">connecting</p>
</header>
<main>
<section>
<h2>Event loop lag</h2>
<p id="lag" class="figure">–</p>
</section>
<section>
<h2>Memory</h2>
<p id="memory" class="figure">–</p>
</section>
<section>
<h2>GC</h2>
<p id="gc" class="figure">–</p>
</section>
<section>
<h2>Alerts</h2>
<ul id="alerts"></ul>
<p id="alerts-empty">No alerts yet</p>
</section>
<section aria-labelledby="waterfall-heading">
<h2 id="waterfall-heading">Recent requests</h2>
<ol id="waterfall" aria-label="Trace waterfall"></ol>
<p id="waterfall-empty">No requests yet</p>
</section>
</main>
</body>
</html>
`;
}
