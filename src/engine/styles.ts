// Colors and CSS. Highlight colors go on the page (::highlight rules must live in the document);
// everything else lives inside the shadow root.
import type { Kind } from '../shared/notes.ts';

export const KINDS: Record<Kind, { label: string; color: string; bg: string }> = {
  issue:   { label: 'Problem',    color: '#cf222e', bg: 'rgba(207,34,46,.20)' },
  caution: { label: 'Caution',    color: '#9a6700', bg: 'rgba(212,167,44,.30)' },
  agree:   { label: 'Looks good', color: '#1a7f37', bg: 'rgba(26,127,55,.20)' },
  info:    { label: 'Context',    color: '#0969da', bg: 'rgba(9,105,218,.14)' },
  step:    { label: 'Step',       color: '#8250df', bg: 'rgba(130,80,223,.20)' },
};
export const ACCENT = '#8250df';

export const PAGE_CSS = [
  ...Object.entries(KINDS).map(([k, v]) => `::highlight(at-${k}) { background-color: ${v.bg}; }`),
  `::highlight(at-term) { text-decoration: underline dotted ${ACCENT}; text-decoration-thickness: 2px; text-underline-offset: 3px; }`,
  '::highlight(at-active) { background-color: rgba(255, 196, 0, .55); }',
].join('\n');

export const UI_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .marks { position: absolute; top: 0; left: 0; pointer-events: none; }
  .marks.off { display: none; }
  .proxy { position: absolute; pointer-events: none; }
  svg.arrows { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
  .ui, .ui * { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #1f2328; }
  .pin { position: absolute; width: 24px; height: 24px; border-radius: 50%; color: #fff !important; font-weight: 700 !important;
         display: flex; align-items: center; justify-content: center; pointer-events: auto; cursor: pointer;
         box-shadow: 0 1px 4px rgba(0,0,0,.35); border: 2px solid #fff; background: ${ACCENT}; }
  .pin.done { opacity: .45; }
  .tip, .card, .ask, .panel, .toast { position: fixed; top: 0; left: 0; background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
         box-shadow: 0 8px 24px rgba(140,149,159,.35); }
  .tip { max-width: 320px; padding: 6px 10px; pointer-events: none; }
  .k { font-size: 11px !important; font-weight: 700 !important; text-transform: uppercase; letter-spacing: .04em; }
  .card { width: 420px; max-height: 65vh; overflow: auto; padding: 12px 14px; pointer-events: auto; }
  .card h3 { margin: 2px 0 6px; font-size: 15px !important; font-weight: 600 !important; }
  .card p { margin: 6px 0; } .card ul { margin: 6px 0; padding-left: 20px; }
  .table { overflow-x: auto; margin: 6px 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d0d7de; padding: 3px 8px; text-align: left; vertical-align: top; }
  th { background: #eaeef2; font-weight: 600 !important; }
  strong { font-weight: 700 !important; }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace !important; background: #eff1f3; padding: 1px 4px; border-radius: 4px; }
  a { color: #0969da !important; }
  pre.code { margin: 6px 0; padding: 8px 10px; background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 6px; overflow-x: auto; }
  pre.code code { display: block; min-width: max-content; padding: 0; background: none; white-space: pre; }
  pre.code span { font: inherit !important; }
  pre.diff { padding: 8px 0; } pre.diff code > * { display: block; padding: 0 10px; }
  .tk-c { color: #6e7781 !important; font-style: italic; } .tk-s { color: #0a3069 !important; }
  .tk-n { color: #0550ae !important; } .tk-k { color: #cf222e !important; }
  .tk-add { background: #dafbe1; color: #116329 !important; } .tk-del { background: #ffebe9; color: #82071e !important; }
  .tk-hunk { color: #8250df !important; }
  .x { position: sticky; top: 0; float: right; border: 0; background: none; cursor: pointer; font-size: 16px !important; color: #656d76 !important; }
  .section { border-top: 1px solid #d8dee4; margin-top: 10px; padding-top: 8px; }
  .section p { margin: 4px 0; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 6px; background: #f6f8fa; }
  .msg.claude { background: #f3eefe; }
  .who { font-size: 11px !important; font-weight: 700 !important; color: #656d76 !important; }
  .status { font-weight: 400 !important; color: ${ACCENT} !important; }
  .hint { font-size: 12px !important; color: #656d76 !important; margin-top: 8px; }
  textarea { width: 100%; min-height: 56px; margin-top: 8px; padding: 6px; border: 1px solid #d0d7de; border-radius: 6px; resize: vertical; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  button.b { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-weight: 600 !important; }
  button.b.primary { background: ${ACCENT}; border-color: ${ACCENT}; color: #fff !important; }
  .quote { border-left: 3px solid ${ACCENT}; padding-left: 8px; color: #656d76 !important; font-style: italic; margin: 4px 0; }
  .ask { padding: 0; pointer-events: auto; }
  .ask button { border: 0; background: ${ACCENT}; color: #fff !important; font-weight: 600 !important; padding: 5px 10px; border-radius: 7px; cursor: pointer; }
  .toast { top: 72px; left: auto; right: 16px; width: 300px; padding: 10px 12px; pointer-events: auto; border-left: 4px solid ${ACCENT}; }
  .panel { top: auto; left: auto; right: 16px; bottom: 16px; width: 320px; max-height: 70vh; overflow: auto; pointer-events: auto; }
  .panel header { position: sticky; top: 0; background: #fff; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #d8dee4; }
  .panel header .t { flex: 1; font-weight: 600 !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .panel header button { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .panel.mini { width: auto; }
  .panel .sec { padding: 6px 10px; }
  .panel .warn { margin: 8px 10px 0; padding: 6px 8px; border-radius: 6px; background: #fff8c5; border: 1px solid #d4a72c; }
  .panel .sec h4 { margin: 4px 0; font-size: 11px !important; font-weight: 700 !important; text-transform: uppercase; color: #656d76 !important; }
  .item { display: flex; gap: 6px; align-items: flex-start; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
  .item:hover { background: #f6f8fa; }
  .item.unread > span.label { font-weight: 700 !important; }
  .item.miss { color: #656d76 !important; cursor: default; }
  .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; margin-top: 4px; }
  .badge { background: ${ACCENT}; color: #fff !important; border-radius: 10px; padding: 0 7px; font-size: 11px !important; font-weight: 700 !important; white-space: nowrap; }
  .badge.posted { background: #1a7f37; text-decoration: none; }
  .badge.queued { background: #9a6700; }
  .card .posted { color: #1a7f37 !important; font-weight: 600 !important; }
  .opt { display: flex; align-items: center; gap: 6px; padding: 6px 10px 0; border-top: 1px solid #d8dee4; cursor: pointer; }
  .meta { font-size: 11px !important; color: #656d76 !important; padding: 4px 10px 8px; }
`;
