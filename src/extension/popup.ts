// The toolbar popup: helper status, sites waiting for access, and controls for the current tab.
import { ext, type PopupState, type Request } from './compat.ts';

const root = document.getElementById('root') ?? document.body;
// Firefox and its forks (Zen) report their name here; Chrome has no getBrowserInfo.
async function geckoName(): Promise<string | null> {
  const info = (ext.runtime as { getBrowserInfo?: () => Promise<{ name: string }> }).getBrowserInfo;
  return info ? (await info()).name.toLowerCase() : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function section(title: string, ...kids: Node[]): HTMLElement {
  const s = el('section');
  s.append(el('h2', title), ...kids);
  return s;
}

function command(text: string): HTMLElement {
  const box = el('div', undefined, 'cmd');
  const code = el('code', text);
  const copy = el('button', 'Copy');
  copy.addEventListener('click', () => { void navigator.clipboard.writeText(text).then(() => { copy.textContent = 'Copied'; }); });
  box.append(code, copy);
  return box;
}

async function render(): Promise<void> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  const state = (await ext.runtime.sendMessage({ type: 'popup' } satisfies Request)) as PopupState;
  const { 'ui:block-keys': blockKeys = true } = await ext.storage.local.get('ui:block-keys');
  root.replaceChildren();

  if (state.needsAccess.length) {
    root.append(section('Waiting for access', ...state.needsAccess.map(p => {
      const row = el('div', undefined, 'row');
      const allow = el('button', 'Allow', 'primary');
      allow.addEventListener('click', () => {
        void ext.permissions.request({ origins: [p.origin] }).then(async ok => {
          if (ok) await ext.runtime.sendMessage({ type: 'granted' } satisfies Request);
          void render();
        });
      });
      row.append(el('span', `${p.title} (${new URL(p.url).hostname})`), allow);
      return row;
    })));
  }

  if (tab?.id !== undefined) {
    const tabId = tab.id;
    const kids: Node[] = [];
    if (state.tabNotes !== null) {
      kids.push(el('p', `${state.tabNotes} note${state.tabNotes === 1 ? '' : 's'} on this page.`));
      const hide = el('button', 'Hide or show markings');
      hide.addEventListener('click', () => { void ext.runtime.sendMessage({ type: 'toggle-hidden', tabId } satisfies Request); window.close(); });
      kids.push(hide);
    } else {
      kids.push(el('p', 'No notes on this page.'));
      if (state.helper === 'connected') {
        const ask = el('button', 'Ask Claude about this page', 'primary');
        ask.addEventListener('click', () => { void ext.runtime.sendMessage({ type: 'activate', tabId } satisfies Request); window.close(); });
        kids.push(ask, el('p', 'Then select any text on the page and choose "Ask Claude".', 'muted'));
      }
    }
    root.append(section('This page', ...kids));
  }

  const keys = el('label', undefined, 'check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = blockKeys !== false;
  box.addEventListener('change', () => { void ext.storage.local.set({ 'ui:block-keys': box.checked }); });
  keys.append(box, document.createTextNode(" Block site shortcuts on pages with notes"));
  root.append(section('Settings', keys));

  const helper = state.helper === 'connected'
    ? [el('p', 'Two-way: your replies reach Claude.')]
    : [el('p', 'One-way: Claude can show notes, but replies need the helper. From the anno-tater folder, run:'), command('npm run tater -- install'), el('p', 'Then reopen this popup.', 'muted')];
  const gecko = await geckoName();
  if (gecko) {
    const name = gecko === 'zen' ? 'zen' : 'firefox';
    helper.push(el('p', 'So `tater open` can reach this browser, run once:', 'muted'), command(`npm run tater -- config ${name}-base ${ext.runtime.getURL('').replace(/\/$/, '')}`));
  }
  root.append(section('Helper', ...helper));
}

void render();
