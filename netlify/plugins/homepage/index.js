import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const fragment = name => readFile(new URL(name, import.meta.url), 'utf8');

export async function onPostBuild({ constants }) {
  const page = join(constants.PUBLISH_DIR, 'index.html');
  const [source, style, film, playback, translations] = await Promise.all([
    readFile(page, 'utf8'), fragment('style.html'), fragment('film.html'),
    fragment('playback.html'), fragment('cookie-text.json')
  ]);
  if (source.includes('id="home-video"')) return;

  const copy = JSON.parse(translations);
  const [title, notice] = Object.keys(copy);
  const dictionary = Object.entries(copy)
    .map(([key, values]) => JSON.stringify(key) + ':' + JSON.stringify(values) + ',')
    .join('\n');

  let html = source;
  function replace(pattern, replacement) {
    if (!pattern.test(html)) throw new Error('Homepage template is missing ' + pattern);
    html = html.replace(pattern, replacement);
  }
  replace(/(<section\b[^>]*\bid="home"[^>]*>)/, (_, tag) => tag + '\n' + film);
  // Place the new rules after the original cookie styles so both layouts take effect.
  replace(/(?=<div class="ck" id="ck")/, () => style);
  replace(/(<h2 id="ck-t">)[^<]*(<\/h2>\s*<p>)[^<]*(<\/p>)/,
    (_, heading, paragraph, end) => heading + title + paragraph + notice + end);
  replace(/(?="Ние използваме „бисквитки“":\[)/, () => dictionary + '\n');
  replace(/<\/body>/, () => playback + '</body>');
  await writeFile(page, html);
}
