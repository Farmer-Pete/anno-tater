// The potato mark, used for the toolbar icon and in the panel header.
export const POTATO = {
  viewBox: '0 0 64 64',
  body: 'M14 21C19 9 40 5 51 13C61 21 61 38 53 48C45 58 22 61 12 50C4 42 8 30 14 21Z',
  fill: '#c48a4a',
  stroke: '#6f4520',
  shine: { cx: 27, cy: 19, rx: 8, ry: 3.2, rotate: -18 },
  eyes: [[24, 26, 2.2], [41, 21, 1.9], [46, 37, 2.2], [29, 45, 1.9], [17, 37, 1.6]] as const,
};

export function potatoSvg(): string {
  const { viewBox, body, fill, stroke, shine, eyes } = POTATO;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`,
    `<path d="${body}" fill="${fill}" stroke="${stroke}" stroke-width="3" stroke-linejoin="round"/>`,
    `<ellipse cx="${shine.cx}" cy="${shine.cy}" rx="${shine.rx}" ry="${shine.ry}" transform="rotate(${shine.rotate} ${shine.cx} ${shine.cy})" fill="#fff" fill-opacity=".35"/>`,
    ...eyes.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${stroke}"/>`),
    '</svg>',
  ].join('');
}
