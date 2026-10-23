// The intake page for no-helper mode. `tater open` opens open.html#<notes>; this stores the notes,
// asks for access to the site if needed (this page's button click is the gesture browsers require),
// and then moves on to the target page.
import { decodeFragment, originPattern } from '../shared/notes.ts';
import { ext, type Request } from './compat.ts';
import { saveLocalPage } from './local.ts';

const status = document.getElementById('status');
const actions = document.getElementById('actions');
const say = (text: string) => { if (status) status.textContent = text; };

function button(text: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
}

async function main(): Promise<void> {
  const fragment = location.hash.slice(1);
  // Drop the notes from this page's address right away, so they don't linger in the tab.
  history.replaceState(null, '', location.pathname);
  if (!fragment) { say('Nothing to open. This page is used by `tater open`.'); return; }

  const { target, notes } = await decodeFragment(fragment);
  await saveLocalPage({ ...notes, url: notes.url ?? target });
  const origin = originPattern(target);
  if (!origin || (await ext.permissions.contains({ origins: [origin] }))) { location.replace(target); return; }

  say(`Anno Tater needs access to ${new URL(target).hostname} to show Claude's notes there. You only grant this once per site.`);
  actions?.append(
    button('Allow and continue', true, () => {
      void ext.permissions.request({ origins: [origin] }).then(async granted => {
        if (granted) await ext.runtime.sendMessage({ type: 'granted' } satisfies Request);
        location.replace(target);
      });
    }),
    button('Continue without notes', false, () => location.replace(target)));
}

main().catch((e: unknown) => say(`Couldn't read these notes: ${(e as Error).message}`));
