/** The dashboard stylesheet, served verbatim. Plain CSS: no `@import`, no `url(...)`, no backtick. */
export const APP_STYLE: string = String.raw`:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --fg: #14181f;
  --muted: #5b6573;
  --card: #ffffff;
  --border: #d9dee5;
  --live: #1a7f37;
  --reconnecting: #9a6700;
  --error: #cf222e;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8b949e;
    --card: #161b22;
    --border: #30363d;
    --live: #3fb950;
    --reconnecting: #d29922;
    --error: #f85149;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 16px;
  background: var(--bg);
  color: var(--fg);
  font-family:
    system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  line-height: 1.4;
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  max-width: 960px;
  margin: 0 auto 16px;
}

h1 {
  margin: 0;
  font-size: 1.5rem;
}

h2 {
  margin: 0 0 8px;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}

#status {
  margin: 0;
  font-size: 0.9rem;
  color: var(--muted);
}

#status.status-live {
  color: var(--live);
}

#status.status-reconnecting {
  color: var(--reconnecting);
}

#status.status-error {
  color: var(--error);
}

main {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
  max-width: 960px;
  margin: 0 auto;
}

section {
  padding: 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.figure {
  margin: 0;
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

#alerts {
  margin: 0;
  padding: 0;
  list-style: none;
}

#alerts li {
  padding: 6px 0;
  border-top: 1px solid var(--border);
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}

#alerts li:first-child {
  border-top: 0;
}

#alerts-empty {
  margin: 0;
  color: var(--muted);
}
`;
